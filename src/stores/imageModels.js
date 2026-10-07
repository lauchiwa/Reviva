import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { encodeModelRef, parseModelRef } from '@/utils/modelRef'

// ─── Image API Formats ───
export const IMAGE_API_FORMATS = Object.freeze([
  { value: 'openai_images', label: 'OpenAI Images', desc: '专用图像接口：/v1/images/generations 与 /v1/images/edits。OpenAI、硅基流动 等' },
  { value: 'dashscope', label: 'DashScope (阿里百炼)', desc: '阿里 multimodal-generation 端点。通义万相 wan2.6、千问 qwen-image 系列' },
  { value: 'gemini_native', label: 'Gemini 原生', desc: 'Google generateContent + responseModalities 出图。Gemini 2.5 Flash Image 等' },
])

function normalizeImageApiFormat(value) {
  const v = String(value || '').trim().toLowerCase()
  if (v === 'dashscope') return 'dashscope'
  if (v === 'gemini_native' || v === 'gemini-native' || v === 'gemini') return 'gemini_native'
  return 'openai_images'
}

// ─── Helpers ───
function imageModel(id, name, options = {}) {
  return {
    id,
    name,
    enabled: options.enabled ?? true,
    capabilities: {
      generation: options.generation ?? false,
      edit: options.edit ?? false,
    },
    sizeMode: options.sizeMode || 'presets',
    sizes: options.sizes || [],
    defaultSize: options.defaultSize || (options.sizes && options.sizes[0] ? options.sizes[0].ratio : ''),
    maxImages: options.maxImages ?? 1,
    customParams: options.customParams || {},
    addedBy: options.addedBy || 'default',
  }
}

function imageProviderPreset({ id, name, desc, iconName, logoBg, logoChar, baseUrl, enabled = false, models, apiKey = '', apiFormat = 'openai_images', region = 'CN' }) {
  return {
    id, name, desc, region,
    iconName, logoBg, logoChar,
    builtin: true,
    apiFormat: normalizeImageApiFormat(apiFormat),
    enabled,
    configured: !!apiKey,
    apiKey,
    baseUrl,
    customParams: {},
    models,
  }
}

const DEFAULT_IMAGE_PROVIDERS = [
  imageProviderPreset({
    id: 'openai', name: 'OpenAI', desc: 'gpt-image-2 与 DALL·E 系列，支持生图与编辑',
    iconName: 'openai', logoBg: '#0F172A', logoChar: 'O',
    baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai_images', region: '海外',
    models: [
      imageModel('gpt-image-2', 'GPT Image 2', {
        generation: true, edit: true, maxImages: 10,
        sizes: [{ ratio: '1:1', value: '1024x1024' }, { ratio: '3:2', value: '1536x1024' }, { ratio: '2:3', value: '1024x1536' }],
        customParams: { quality: 'high', output_format: 'png', background: 'auto' },
      }),
    ],
  }),
  imageProviderPreset({
    id: 'siliconflow', name: '硅基流动', desc: 'SiliconCloud 聚合，FLUX 系列生图',
    iconName: 'siliconflow', logoBg: '#6E29F6', logoChar: '硅',
    baseUrl: 'https://api.siliconflow.cn/v1', apiFormat: 'openai_images', region: '国内',
    models: [
      imageModel('Kwai-Kolors/Kolors', 'Kolors', {
        generation: true, edit: false, maxImages: 4,
        sizes: [{ ratio: '1:1', value: '1024x1024' }, { ratio: '16:9', value: '1024x576' }, { ratio: '9:16', value: '576x1024' }],
      }),
    ],
  }),
  imageProviderPreset({
    id: 'bailian', name: '阿里百炼', desc: '通义万相 wan2.6 与千问 qwen-image，支持编辑与图文混排',
    iconName: 'bailian', logoBg: '#615CED', logoChar: '阿',
    baseUrl: 'https://dashscope.aliyuncs.com', apiFormat: 'dashscope', region: '国内',
    models: [
      imageModel('qwen-image-2.0-pro', 'Qwen-Image 2.0 Pro', {
        generation: true, edit: true, maxImages: 6,
        sizes: [{ ratio: '1:1', value: '1024*1024' }, { ratio: '16:9', value: '1280*720' }, { ratio: '9:16', value: '720*1280' }],
        customParams: { negative_prompt: '', watermark: false },
      }),
    ],
  }),
  imageProviderPreset({
    id: 'gemini', name: 'Google Gemini', desc: 'Gemini 原生出图，generateContent 多模态输出',
    iconName: 'gemini', logoBg: '#1A73E8', logoChar: 'G',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiFormat: 'gemini_native', region: '海外',
    models: [
      imageModel('gemini-2.5-flash-image', 'Gemini 2.5 Flash Image', {
        generation: true, edit: true, maxImages: 4,
        sizes: [{ ratio: '1:1', value: '1:1' }, { ratio: '16:9', value: '16:9' }, { ratio: '9:16', value: '9:16' }, { ratio: '4:3', value: '4:3' }, { ratio: '3:4', value: '3:4' }],
        customParams: { responseModalities: 'TEXT,IMAGE' },
      }),
    ],
  }),
]

const DEFAULT_DEFAULT_IMAGE_MODELS = { generation: '', edit: '' }

function providerConfigured(provider) {
  if (!provider) return false
  return !!provider.baseUrl && !!provider.apiKey
}

function cloneDefaultProviders() {
  return JSON.parse(JSON.stringify(DEFAULT_IMAGE_PROVIDERS))
}

function mergeBuiltinProviders(stored) {
  const builtinIds = new Set(DEFAULT_IMAGE_PROVIDERS.map(p => p.id))
  const result = cloneDefaultProviders()
  for (const preset of result) {
    const storedP = stored.find(s => s.id === preset.id)
    if (storedP) {
      Object.assign(preset, {
        enabled: storedP.enabled ?? preset.enabled,
        apiKey: storedP.apiKey ?? '',
        baseUrl: storedP.baseUrl || preset.baseUrl,
        customParams: storedP.customParams || {},
        configured: providerConfigured({ ...preset, apiKey: storedP.apiKey, baseUrl: storedP.baseUrl || preset.baseUrl }),
        models: mergeModels(preset.models, storedP.models),
      })
    }
  }
  for (const s of stored) {
    if (!builtinIds.has(s.id)) result.push(s)
  }
  return result
}

function mergeModels(presetModels, storedModels) {
  const presetIds = new Set(presetModels.map(m => m.id))
  const out = presetModels.map(m => {
    const sm = storedModels.find(s => s.id === m.id)
    return sm ? { ...m, ...sm, capabilities: { ...m.capabilities, ...(sm.capabilities || {}) } } : m
  })
  for (const sm of storedModels) {
    if (!presetIds.has(sm.id)) out.push(sm)
  }
  return out
}

function sanitizeDefaultModels(input, providers) {
  const out = { ...DEFAULT_DEFAULT_IMAGE_MODELS, ...(input || {}) }
  for (const key of Object.keys(out)) {
    const ref = out[key]
    if (!ref) { out[key] = ''; continue }
    const { providerId, modelId } = parseModelRef(ref)
    const provider = providers.find(p => p.id === providerId)
    const model = provider ? provider.models.find(m => m.id === modelId) : null
    if (!provider || !model) { out[key] = ''; continue }
    if (key === 'generation' && !model.capabilities.generation) out[key] = ''
    if (key === 'edit' && !model.capabilities.edit) out[key] = ''
  }
  return out
}

export const useImageModelsStore = defineStore('imageModels', () => {
  const providers = ref(cloneDefaultProviders())
  const defaultModels = ref({ ...DEFAULT_DEFAULT_IMAGE_MODELS })
  const loaded = ref(false)

  const enabledProviders = computed(() => providers.value.filter(p => p.enabled))
  const configuredProviders = computed(() => providers.value.filter(p => p.configured))
  const availableModels = computed(() => {
    let n = 0
    for (const p of providers.value) for (const m of p.models) if (m.enabled) n++
    return n
  })
  const generationModels = computed(() => {
    const list = []
    for (const p of providers.value) {
      if (!p.enabled) continue
      for (const m of p.models) {
        if (m.enabled && m.capabilities.generation) list.push({ providerId: p.id, providerName: p.name, modelId: m.id, modelName: m.name, ref: encodeModelRef(p.id, m.id) })
      }
    }
    return list
  })
  const editModels = computed(() => {
    const list = []
    for (const p of providers.value) {
      if (!p.enabled) continue
      for (const m of p.models) {
        if (m.enabled && m.capabilities.edit) list.push({ providerId: p.id, providerName: p.name, modelId: m.id, modelName: m.name, ref: encodeModelRef(p.id, m.id) })
      }
    }
    return list
  })

  function getProvider(id) { return providers.value.find(p => p.id === id) }
  function getModel(providerId, modelId) { const p = getProvider(providerId); return p ? p.models.find(m => m.id === modelId) : undefined }
  function getModelName(ref) { const { providerId, modelId } = parseModelRef(ref); const m = getModel(providerId, modelId); return m ? m.name : (modelId || '') }
  function getProviderDefaultBaseUrl(id) { const preset = DEFAULT_IMAGE_PROVIDERS.find(p => p.id === id); return preset ? preset.baseUrl : '' }

  async function saveProviders() {
    if (!window.electronAPI || !window.electronAPI.db) return false
    try { await window.electronAPI.db.settings.set('imageModels', JSON.stringify(providers.value)); return true }
    catch (e) { console.error('[imageModels] saveProviders error:', e); return false }
  }
  async function saveDefaultModels() {
    if (!window.electronAPI || !window.electronAPI.db) return
    try { await window.electronAPI.db.settings.set('imageDefaultModels', JSON.stringify(defaultModels.value)) }
    catch (e) { console.error('[imageModels] saveDefaultModels error:', e) }
  }
  async function loadFromDb() {
    if (!window.electronAPI || !window.electronAPI.db) return
    try {
      const all = await window.electronAPI.db.settings.getAll()
      const raw = all.imageModels; const stored = Array.isArray(raw) ? raw : (typeof raw === 'string' ? (JSON.parse(raw) || []) : [])
      const merged = stored.length ? mergeBuiltinProviders(stored) : cloneDefaultProviders()
      providers.value = merged
      providers.value.forEach(p => { p.configured = providerConfigured(p) })
      const rawDm = all.imageDefaultModels; defaultModels.value = sanitizeDefaultModels(rawDm && typeof rawDm === 'object' ? rawDm : (typeof rawDm === 'string' ? JSON.parse(rawDm) : {}), providers.value)
      loaded.value = true
    } catch (e) { console.error('[imageModels] loadFromDb failed:', e); loaded.value = true }
  }

  function addProvider(provider) {
    const id = provider.id || ('custom-' + Date.now())
    if (getProvider(id)) return { error: '服务商 ID 已存在' }
    const p = {
      id, name: provider.name || '自定义服务商', desc: provider.desc || '', region: provider.region || '',
      iconName: 'wand-magic-sparkles', logoBg: provider.logoBg || '#4A6CFF', logoChar: provider.logoChar || '图',
      builtin: false, apiFormat: normalizeImageApiFormat(provider.apiFormat),
      enabled: provider.enabled ?? true, configured: false, apiKey: '', baseUrl: provider.baseUrl || '',
      customParams: {}, models: [],
    }
    providers.value.push(p)
    return p
  }
  function updateProvider(id, patch) {
    const p = getProvider(id); if (!p) return false
    Object.assign(p, patch)
    if (patch.apiFormat) p.apiFormat = normalizeImageApiFormat(patch.apiFormat)
    if (patch.apiKey !== undefined || patch.baseUrl !== undefined) p.configured = providerConfigured(p)
    return true
  }
  function removeProvider(id) {
    const idx = providers.value.findIndex(p => p.id === id); if (idx < 0) return false
    providers.value.splice(idx, 1)
    if (parseModelRef(defaultModels.value.generation).providerId === id) defaultModels.value.generation = ''
    if (parseModelRef(defaultModels.value.edit).providerId === id) defaultModels.value.edit = ''
    return true
  }
  function addModelToProvider(providerId, model) {
    const p = getProvider(providerId); if (!p) return { error: '服务商不存在' }
    const id = model.id || ('model-' + Date.now())
    if (p.models.find(m => m.id === id)) return { error: '模型 ID 已存在' }
    p.models.push(imageModel(id, model.name || id, {
      enabled: model.enabled ?? true,
      generation: model.capabilities ? model.capabilities.generation : false,
      edit: model.capabilities ? model.capabilities.edit : false,
      sizeMode: model.sizeMode || 'presets',
      sizes: model.sizes || [],
      maxImages: model.maxImages ?? 1,
      customParams: model.customParams || {},
      addedBy: 'user',
    }))
    return true
  }
  function updateModelInProvider(providerId, modelId, patch) {
    const m = getModel(providerId, modelId); if (!m) return false
    const { capabilities, ...rest } = patch
    if (capabilities) m.capabilities = { ...m.capabilities, ...capabilities }
    Object.assign(m, rest)
    return true
  }
  function removeModelFromProvider(providerId, modelId) {
    const p = getProvider(providerId); if (!p) return false
    const idx = p.models.findIndex(m => m.id === modelId); if (idx < 0) return false
    p.models.splice(idx, 1)
    const g = parseModelRef(defaultModels.value.generation)
    const e = parseModelRef(defaultModels.value.edit)
    if (g.providerId === providerId && g.modelId === modelId) defaultModels.value.generation = ''
    if (e.providerId === providerId && e.modelId === modelId) defaultModels.value.edit = ''
    return true
  }
  function addFetchedModels(providerId, fetched) {
    const p = getProvider(providerId); if (!p) return false
    for (const f of fetched) {
      if (p.models.find(m => m.id === f.id)) continue
      p.models.push(imageModel(f.id, f.name || f.id, { enabled: false, generation: false, edit: false, sizeMode: 'free', sizes: [], addedBy: 'fetched' }))
    }
    return true
  }
  function setDefaultModel(capability, ref) {
    const { providerId, modelId } = parseModelRef(ref)
    const m = getModel(providerId, modelId)
    if (!m) return { error: '模型不存在' }
    if (capability === 'generation' && !m.capabilities.generation) return { error: '该模型不支持生图' }
    if (capability === 'edit' && !m.capabilities.edit) return { error: '该模型不支持编辑' }
    defaultModels.value[capability] = ref
    return true
  }
  function providerConfiguredById(id) { const p = getProvider(id); return p ? providerConfigured(p) : false }

  return {
    providers, defaultModels, loaded,
    enabledProviders, configuredProviders, availableModels, generationModels, editModels,
    IMAGE_API_FORMATS,
    getProvider, getModel, getModelName, getProviderDefaultBaseUrl,
    saveProviders, saveDefaultModels, loadFromDb,
    addProvider, updateProvider, removeProvider,
    addModelToProvider, updateModelInProvider, removeModelFromProvider, addFetchedModels,
    setDefaultModel, providerConfiguredById,
  }
})
