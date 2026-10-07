/**
 * 图像模型服务工具
 * 封装 useImageModelsStore，提供简洁 API 供其他业务模块调用。
 *
 * 用法示例：
 *   import { buildImageRequest, getDefaultModel } from '@/utils/imageModelService'
 *   const cfg = await buildImageRequest('generation', { ratio: '16:9', count: 1 })
 *   if (!cfg) { / 无可用模型 / }
 *   // cfg => { apiFormat, baseUrl, apiKey, modelId, modelName, size, customParams, maxImages, provider, model }
 */

import { useImageModelsStore } from '@/stores/imageModels'
import { parseModelRef, encodeModelRef } from '@/utils/modelRef'

/**
 * 解析 modelRef，返回 { provider, model } 或 null
 * @param {string} ref - 如 "openai::gpt-image-1"
 * @returns {{provider: object, model: object} | null}
 */
export function resolveModel(ref) {
  if (!ref) return null
  const store = useImageModelsStore()
  const { providerId, modelId } = parseModelRef(ref)
  if (!providerId || !modelId) return null
  const provider = store.getProvider(providerId)
  const model = store.getModel(providerId, modelId)
  if (!provider || !model) return null
  return { provider, model }
}

/**
 * 获取默认模型（生图或编辑）
 * @param {'generation'|'edit'} capability
 * @returns {{provider: object, model: object, ref: string} | null}
 */
export function getDefaultModel(capability) {
  const store = useImageModelsStore()
  const ref = store.defaultModels[capability]
  if (!ref) return null
  const resolved = resolveModel(ref)
  if (!resolved) return null
  return { ...resolved, ref }
}

/**
 * 合并自定义参数，后者覆盖前者
 * provider.customParams -> model.customParams -> callerParams
 * @param {object} provider
 * @param {object} model
 * @param {object} callerParams - 调用方额外参数
 * @returns {object}
 */
export function mergeParams(provider, model, callerParams = {}) {
  return {
    ...(provider?.customParams || {}),
    ...(model?.customParams || {}),
    ...callerParams,
  }
}

/**
 * 根据比例获取尺寸原生值
 * @param {object} model
 * @param {string} ratio - 如 "16:9"
 * @returns {string | null}
 */
export function getSizeValue(model, ratio) {
  if (!model?.sizes?.length) return null
  const found = model.sizes.find(s => s.ratio === ratio)
  return found ? found.value : null
}

/**
 * 获取模型支持的所有比例
 * @param {object} model
 * @returns {string[]}
 */
export function getAvailableRatios(model) {
  return (model?.sizes || []).map(s => s.ratio).filter(Boolean)
}

/**
 * 验证比例是否在模型支持列表内（free 模式始终通过）
 * @param {object} model
 * @param {string} ratio
 * @returns {boolean}
 */
export function validateRatio(model, ratio) {
  if (model?.sizeMode === 'free') return true
  if (!ratio) return false
  return getAvailableRatios(model).includes(ratio)
}

/**
 * 构建图像请求配置（供工具层 / agent 调用）
 *
 * @param {'generation'|'edit'} capability - 'generation' 或 'edit'
 * @param {{ratio?: string, count?: number, customParams?: object, ref?: string}} [options]
 *   - ratio: 指定比例，不传则用模型 defaultSize
 *   - count: 生成数量，不传则用模型 maxImages
 *   - customParams: 调用方额外请求参数，覆盖模型/服务商参数
 *   - ref: 指定模型引用，不传则用默认模型
 * @returns {Promise<object|null>} 请求配置对象，无可用模型时返回 null
 *
 * @returns {object|null} 配置对象:
 *   { apiFormat, baseUrl, apiKey, providerId, providerName, modelId, modelName,
 *     capability, ratio, size, count, maxImages, customParams, provider, model }
 */
export async function buildImageRequest(capability, options = {}) {
  const store = useImageModelsStore()
  if (!store.loaded) {
    await store.loadFromDb()
  }

  let provider, model, ref
  if (options.ref) {
    const resolved = resolveModel(options.ref)
    if (!resolved) return null
    ;({ provider, model } = resolved)
    ref = options.ref
  } else {
    const def = getDefaultModel(capability)
    if (!def) return null
    ;({ provider, model, ref } = def)
  }

  if (!provider?.enabled || !provider?.configured) return null
  if (capability === 'generation' && !model.capabilities.generation) return null
  if (capability === 'edit' && !model.capabilities.edit) return null

  const ratio = options.ratio || model.defaultSize || ''
  const size = ratio ? getSizeValue(model, ratio) : ''
  const count = Math.min(
    options.count || model.maxImages || 1,
    model.maxImages || 1
  )
  const customParams = mergeParams(provider, model, options.customParams)

  return {
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelName: model.name,
    capability,
    ratio,
    size,
    count,
    maxImages: model.maxImages,
    sizeMode: model.sizeMode,
    customParams,
    provider,
    model,
    ref,
  }
}

/**
 * 列出所有可用的生图模型（已启用 + 已配置 + 有生图能力）
 * @returns {Array<{providerId, providerName, modelId, modelName, ref, apiFormat, baseUrl}>}
 */
export function listGenerationModels() {
  const store = useImageModelsStore()
  return store.generationModels.map(m => {
    const p = store.getProvider(m.providerId)
    return {
      ...m,
      apiFormat: p?.apiFormat,
      baseUrl: p?.baseUrl,
    }
  })
}

/**
 * 列出所有可用的编辑模型
 * @returns {Array<{providerId, providerName, modelId, modelName, ref, apiFormat, baseUrl}>}
 */
export function listEditModels() {
  const store = useImageModelsStore()
  return store.editModels.map(m => {
    const p = store.getProvider(m.providerId)
    return {
      ...m,
      apiFormat: p?.apiFormat,
      baseUrl: p?.baseUrl,
    }
  })
}

/**
 * 快捷：获取默认生图模型配置
 */
export async function getDefaultGenerationRequest(options = {}) {
  return buildImageRequest('generation', options)
}

/**
 * 快捷：获取默认编辑模型配置
 */
export async function getDefaultEditRequest(options = {}) {
  return buildImageRequest('edit', options)
}