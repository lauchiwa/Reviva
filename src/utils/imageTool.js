/**
 * 图像工具层 — 供 agent / LangChain tool 调用
 *
 * 统一入口 generateImage / editImage，内部自动：
 * 1. 解析默认模型配置（imageModelService.buildImageRequest）
 * 2. 选择格式适配器（imageAdapters）
 * 3. 执行 HTTP 请求（含 DashScope 异步轮询，对外表现为同步）
 * 4. 返回统一结果 { images, model, format, revisedPrompt? }
 *
 * 用法：
 *   import { generateImage, editImage } from '@/utils/imageTool'
 *   const result = await generateImage('一只猫在月光下', { ratio: '16:9', count: 2 })
 *   result.images[0].url  // 或 result.images[0].base64
 */

import { buildImageRequest, listGenerationModels, listEditModels } from './imageModelService'
import { getAdapter } from './imageAdapters'

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 120000

/**
 * 执行 HTTP 请求
 * @param {{url, method, headers, body, contentType}} request
 * @returns {Promise<object>} JSON 响应
 */
async function executeRequest(request) {
  const opts = {
    method: request.method,
    headers: request.headers || {},
  }
  if (request.body) {
    if (request.contentType === 'formdata') {
      opts.body = request.body
    } else if (request.contentType !== 'none') {
      opts.body = request.body
    }
  }
  const res = await fetch(request.url, opts)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error('API ' + res.status + ': ' + (text || res.statusText))
  }
  return res.json()
}

/**
 * 执行请求，处理异步轮询（DashScope）
 */
async function executeWithPolling(request, cfg, adapter) {
  let data = await executeRequest(request)
  if (!adapter.isAsync(data)) return data

  const pollReq = adapter.buildPollRequest(cfg, data)
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    data = await executeRequest(pollReq)
    const status = data?.output?.task_status
    if (status === 'SUCCEEDED' || status === 'SUCCESS') return data
    if (status === 'FAILED' || status === 'UNKNOWN') {
      throw new Error('图像生成失败: ' + (data?.output?.message || status))
    }
  }
  throw new Error('图像生成超时')
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * 统一结果格式
 */
function formatResult(images, cfg, extra = {}) {
  return {
    images,
    model: cfg.modelId,
    modelName: cfg.modelName,
    provider: cfg.providerName,
    format: cfg.apiFormat,
    capability: cfg.capability,
    ratio: cfg.ratio,
    count: images.length,
    ...extra,
  }
}

/**
 * 生成图像（生图）
 *
 * @param {string} prompt - 图像描述
 * @param {{ratio?: string, count?: number, customParams?: object, ref?: string}} [options]
 * @returns {Promise<{images, model, modelName, provider, format, capability, ratio, count}>}
 */
export async function generateImage(prompt, options = {}) {
  const cfg = await buildImageRequest('generation', options)
  if (!cfg) {
    throw new Error('未配置可用的生图模型，请在 设置 → 图像模型配置 中添加并启用')
  }

  const adapter = getAdapter(cfg.apiFormat)
  const request = adapter.buildGenerationRequest(cfg, { prompt })
  const data = await executeWithPolling(request, cfg, adapter)
  const { images, revisedPrompt } = adapter.parseResponse(data, cfg)

  if (!images.length) {
    throw new Error('图像生成完成但未返回图片数据')
  }

  return formatResult(images, cfg, { revisedPrompt })
}

/**
 * 编辑图像
 *
 * @param {string} prompt - 编辑指令
 * @param {{url?: string, base64?: string, mimeType?: string, maskUrl?: string, maskBase64?: string}} image - 原图
 * @param {{ratio?: string, count?: number, customParams?: object, ref?: string}} [options]
 * @returns {Promise<object>} 同 generateImage 返回格式
 */
export async function editImage(prompt, image, options = {}) {
  const cfg = await buildImageRequest('edit', options)
  if (!cfg) {
    throw new Error('未配置可用的图像编辑模型，请在 设置 → 图像模型配置 中添加并启用')
  }

  const adapter = getAdapter(cfg.apiFormat)
  const request = adapter.buildEditRequest(cfg, { prompt, image })
  const data = await executeWithPolling(request, cfg, adapter)
  const { images, revisedPrompt } = adapter.parseResponse(data, cfg)

  if (!images.length) {
    throw new Error('图像编辑完成但未返回图片数据')
  }

  return formatResult(images, cfg, { revisedPrompt })
}

/**
 * 检查是否有可用的生图模型（不执行请求）
 */
export function hasGenerationModel() {
  const list = listGenerationModels()
  return list.length > 0
}

/**
 * 检查是否有可用的编辑模型
 */
export function hasEditModel() {
  const list = listEditModels()
  return list.length > 0
}


// ──────────────────────────── LangChain Tool 定义 ────────────────────────────

/**
 * 生图工具定义（适配 LangChain tool schema）
 */
export const imageGenerationToolDef = {
  name: 'image_generation',
  description: '根据文本提示词生成图像。支持多种模型和服务商（OpenAI gpt-image-1、硅基流动 FLUX、阿里百炼千问/万相、Google Gemini）。返回图片 URL 或 base64 数据。',
  schema: {
    prompt: {
      type: 'string',
      description: '图像描述，越详细越好',
      required: true,
    },
    ratio: {
      type: 'string',
      description: '图像比例，如 1:1、16:9、9:16、3:2、2:3。不传则用模型默认比例',
    },
    count: {
      type: 'number',
      description: '生成数量，不传则用模型默认值',
    },
  },
  func: async ({ prompt, ratio, count }) => {
    return generateImage(prompt, { ratio, count })
  },
}

/**
 * 图像编辑工具定义
 */
export const imageEditToolDef = {
  name: 'image_edit',
  description: '编辑已有图像。需要提供原图（URL 或 base64）和编辑指令。支持 OpenAI gpt-image-1、阿里万相 wan2.6-image、Google Gemini 等具备编辑能力的模型。',
  schema: {
    prompt: {
      type: 'string',
      description: '编辑指令，描述要怎么修改图像',
      required: true,
    },
    imageUrl: {
      type: 'string',
      description: '原图 URL（与 imageBase64 二选一）',
    },
    imageBase64: {
      type: 'string',
      description: '原图 base64 数据（与 imageUrl 二选一）',
    },
    imageMimeType: {
      type: 'string',
      description: '原图 MIME 类型，如 image/png、image/jpeg',
    },
    ratio: {
      type: 'string',
      description: '输出比例',
    },
  },
  func: async ({ prompt, imageUrl, imageBase64, imageMimeType, ratio }) => {
    const image = {
      url: imageUrl,
      base64: imageBase64,
      mimeType: imageMimeType || 'image/png',
    }
    return editImage(prompt, image, { ratio })
  },
}