/**
 * 图像 API 格式适配器
 *
 * 三种协议各自的请求结构差异：
 * - openai_images: POST /images/generations | /images/edits，JSON 或 multipart
 * - dashscope:    按模型族分不同端点，异步需轮询，统一为同步返回
 * - gemini_native: POST /models/{model}:generateContent?key=，contents/parts 结构
 *
 * 每个适配器实现：
 *   buildGenerationRequest(cfg, input) → { url, method, headers, body, contentType }
 *   buildEditRequest(cfg, input)      → 同上
 *   parseResponse(data, cfg)          → { images: [{url?, base64?, mimeType?}], revisedPrompt? }
 *   isAsync(data)                     → boolean（DashScope 异步任务）
 *   buildPollRequest(cfg, data)      → 轮询请求配置
 */

// ──────────────────────────── OpenAI Images ────────────────────────────

const openaiImagesAdapter = {
  format: 'openai_images',

  buildGenerationRequest(cfg, { prompt }) {
    const body = {
      model: cfg.modelId,
      prompt,
      n: cfg.count || 1,
      ...(cfg.size ? { size: cfg.size } : {}),
      ...cfg.customParams,
    }
    return {
      url: cfg.baseUrl.replace(/\/$/, '') + '/images/generations',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      contentType: 'json',
    }
  },

  buildEditRequest(cfg, { prompt, image }) {
    const form = new FormData()
    form.append('model', cfg.modelId)
    form.append('prompt', prompt)
    form.append('n', String(cfg.count || 1))
    if (cfg.size) form.append('size', cfg.size)
    if (image.base64) {
      const blob = base64ToBlob(image.base64, image.mimeType || 'image/png')
      form.append('image', blob, 'image.png')
    } else if (image.url) {
      form.append('image', image.url)
    }
    if (image.mask) {
      if (image.maskBase64) {
        form.append('mask', base64ToBlob(image.maskBase64, image.maskMimeType || 'image/png'), 'mask.png')
      } else if (image.maskUrl) {
        form.append('mask', image.maskUrl)
      }
    }
    return {
      url: cfg.baseUrl.replace(/\/$/, '') + '/images/edits',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.apiKey },
      body: form,
      contentType: 'formdata',
    }
  },

  parseResponse(data) {
    const images = (data?.data || []).map(item => ({
      url: item.url || undefined,
      base64: item.b64_json || undefined,
      mimeType: item.b64_json ? 'image/png' : undefined,
    })).filter(img => img.url || img.base64)
    return { images, revisedPrompt: data?.data?.[0]?.revised_prompt }
  },

  isAsync() { return false },
}

// ──────────────────────────── DashScope (阿里百炼) ────────────────────────────

const dashscopeAdapter = {
  format: 'dashscope',

  _isText2Image(cfg) {
    const id = cfg.modelId.toLowerCase()
    return id.includes('qwen-image') || id.includes('t2i') || id.includes('wan2.6-t2i')
  },
  _isImageEdit(cfg) {
    const id = cfg.modelId.toLowerCase()
    return id.includes('wan2.6-image') && !id.includes('t2i')
  },

  buildGenerationRequest(cfg, { prompt }) {
    if (this._isImageEdit(cfg)) {
      // 万相图编辑走 multimodal-generation
      return this.buildEditRequest(cfg, { prompt, image: {} })
    }
    // 文生图走 text2image/image-synthesis
    const body = {
      model: cfg.modelId,
      input: { prompt },
      parameters: {
        ...(cfg.size ? { size: cfg.size } : {}),
        n: cfg.count || 1,
        ...cfg.customParams,
      },
    }
    return {
      url: cfg.baseUrl.replace(/\/$/, '') + '/api/v1/services/aigc/text2image/image-synthesis',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.apiKey,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(body),
      contentType: 'json',
    }
  },

  buildEditRequest(cfg, { prompt, image }) {
    const body = {
      model: cfg.modelId,
      input: {
        prompt,
        ...(image?.url ? { image: image.url } : {}),
        ...(image?.base64 ? { image: 'data:' + (image.mimeType || 'image/png') + ';base64,' + image.base64 } : {}),
      },
      parameters: { ...cfg.customParams },
    }
    return {
      url: cfg.baseUrl.replace(/\/$/, '') + '/api/v1/services/aigc/multimodal-generation/generation',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      contentType: 'json',
    }
  },

  isAsync(data) {
    return !!data?.output?.task_id && !data?.output?.images
  },

  buildPollRequest(cfg, data) {
    const taskId = data?.output?.task_id
    return {
      url: cfg.baseUrl.replace(/\/$/, '') + '/api/v1/tasks/' + taskId,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + cfg.apiKey },
      body: null,
      contentType: 'none',
    }
  },

  parseResponse(data) {
    // 异步任务完成后的结果：output.results 或 output.images
    const raw = data?.output?.results || data?.output?.images || []
    const images = raw.map(item => ({
      url: item.url || undefined,
      base64: item.b64_image || item.b64 || undefined,
    })).filter(img => img.url || img.base64)
    return { images }
  },
}

// ──────────────────────────── Gemini 原生 ────────────────────────────

const geminiNativeAdapter = {
  format: 'gemini_native',

  _buildParts(prompt, image, editMode) {
    const parts = [{ text: prompt }]
    if (editMode && image) {
      if (image.base64) {
        parts.push({
          inlineData: {
            mimeType: image.mimeType || 'image/png',
            data: image.base64,
          },
        })
      }
    }
    return parts
  },

  buildGenerationRequest(cfg, { prompt }) {
    const modalities = cfg.customParams?.responseModalities
      ? cfg.customParams.responseModalities.split(',').map(s => s.trim())
      : ['TEXT', 'IMAGE']
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: modalities,
        ...(cfg.ratio ? { aspectRatio: cfg.ratio } : {}),
      },
      ...Object.fromEntries(
        Object.entries(cfg.customParams || {}).filter(([k]) => k !== 'responseModalities')
      ),
    }
    const sep = cfg.baseUrl.includes('?') ? '&' : '?'
    return {
      url: cfg.baseUrl.replace(/\/$/, '') + '/models/' + cfg.modelId + ':generateContent' + sep + 'key=' + encodeURIComponent(cfg.apiKey),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      contentType: 'json',
    }
  },

  buildEditRequest(cfg, { prompt, image }) {
    const modalities = cfg.customParams?.responseModalities
      ? cfg.customParams.responseModalities.split(',').map(s => s.trim())
      : ['TEXT', 'IMAGE']
    const parts = this._buildParts(prompt, image, true)
    const body = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: modalities,
      },
      ...Object.fromEntries(
        Object.entries(cfg.customParams || {}).filter(([k]) => k !== 'responseModalities')
      ),
    }
    const sep = cfg.baseUrl.includes('?') ? '&' : '?'
    return {
      url: cfg.baseUrl.replace(/\/$/, '') + '/models/' + cfg.modelId + ':generateContent' + sep + 'key=' + encodeURIComponent(cfg.apiKey),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      contentType: 'json',
    }
  },

  parseResponse(data) {
    const candidates = data?.candidates || []
    const images = []
    let text = ''
    for (const cand of candidates) {
      const parts = cand?.content?.parts || []
      for (const part of parts) {
        if (part?.inlineData?.data) {
          images.push({
            base64: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'image/png',
          })
        }
        if (part?.text) text += part.text
      }
    }
    return { images, revisedPrompt: text || undefined }
  },

  isAsync() { return false },
}

// ──────────────────────────── Registry ────────────────────────────

export const imageAdapters = {
  openai_images: openaiImagesAdapter,
  dashscope: dashscopeAdapter,
  gemini_native: geminiNativeAdapter,
}

export function getAdapter(apiFormat) {
  const adapter = imageAdapters[apiFormat]
  if (!adapter) throw new Error('不支持的图像 API 格式: ' + apiFormat)
  return adapter
}

// ──────────────────────────── Helpers ────────────────────────────

function base64ToBlob(base64, mimeType) {
  const bytes = atob(base64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mimeType })
}