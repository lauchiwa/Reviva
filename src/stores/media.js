import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { encodeModelRef, parseModelRef } from '@/utils/modelRef'
import {
  ALIYUN_ASR_PRESET_MODELS,
  formatAliyunAsrLimit,
  getAliyunAsrModelCapability,
} from '@/constants/aliyunAsrModels'

// ────────── ASR API Formats ──────────
export const ASR_API_FORMATS = Object.freeze([
  { value: 'openai_transcriptions', label: 'OpenAI Transcriptions', desc: '标准 /audio/transcriptions 文件上传接口' },
  { value: 'dashscope', label: 'DashScope (阿里百炼)', desc: '百炼 ASR 异步转录服务' },
])

// ────────── Provider Definitions ──────────
export const SPEECH_PROVIDER_DEFINITIONS = Object.freeze([
  {
    id: 'local_asr',
    name: '本地 ASR 服务',
    shortName: '本地 HTTP ASR',
    icon: 'ri-cpu-line',
    accent: '#10B981',
    description: '连接本地的 OpenAI Transcriptions 兼容 HTTP 服务。',
    apiFormat: 'openai_transcriptions',
  },
  {
    id: 'openai_whisper_compatible',
    name: 'OpenAI Whisper',
    shortName: 'OpenAI 兼容接口',
    icon: 'ri-cloud-line',
    accent: '#6C8AFF',
    description: '使用兼容 openai 请求 /audio/transcriptions 文件上传接口。',
    apiFormat: 'openai_transcriptions',
  },
  {
    id: 'siliconflow_asr',
    name: '硅基流动',
    shortName: 'SiliconFlow',
    icon: 'ri-cloud-line',
    accent: '#FF6B35',
    description: '硅基流动 OpenAI 兼容 ASR 接口，支持 SenseVoice 等模型。',
    apiFormat: 'openai_transcriptions',
  },
  {
    id: 'aliyun_bailian_asr',
    name: '阿里百炼',
    shortName: '百炼 ASR',
    icon: 'ri-mic-ai-line',
    accent: '#F59E0B',
    description: '阿里百炼服务，用于长音频异步转录。',
    apiFormat: 'dashscope',
  },
])

export const ALIYUN_ASR_MODELS = ALIYUN_ASR_PRESET_MODELS

// 已从默认预设中移除的百炼模型 ID。ALIYUN_ASR_MODEL_CAPABILITIES 能力表保留，
// 仍可通过 getAliyunAsrModelCapability 解析用户手动添加的这些模型。
// 规整时只清理处于“未启用”状态的旧预设，避免删除用户实际启用的模型。
const RETIRED_ALIYUN_ASR_PRESET_IDS = Object.freeze(new Set([
  'qwen3-asr-flash-filetrans',
  'paraformer-realtime-v1',
  'fun-asr-realtime',
  'qwen3-asr-flash-realtime',
  'gummy-realtime-v1', // 官方标记为待废弃
]))

// ────────── Model Card Factory ──────────
function asrModel(id, name, options = {}) {
  return {
    id,
    name,
    enabled: options.enabled ?? true,
    capabilities: {
      streaming: options.streaming ?? false,
      realtime: options.realtime ?? false,
      timestamps: options.timestamps ?? 'segment',
      diarization: options.diarization ?? false,
    },
    language: options.language || 'auto',
    customParams: options.customParams || {},
    addedBy: options.addedBy || 'default',
  }
}

// ────────── Default Settings ──────────

export function createDefaultSpeechSettings() {
  return {
    version: 4,
    defaultModelRef: '',
    providers: {
      local_asr: {
        enabled: false,
        baseUrl: '',
        apiKey: '',
        models: [
          asrModel('whisper-1', 'Whisper-1', { timestamps: 'segment' }),
        ],
      },
     openai_whisper_compatible: {
       enabled: false,
       baseUrl: '',
       apiKey: '',
       models: [
         asrModel('whisper-1', 'Whisper-1', { timestamps: 'segment' }),
       ],
     },
      siliconflow_asr: {
        enabled: false,
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: '',
        models: [
          asrModel('FunAudioLLM/SenseVoiceSmall', 'SenseVoiceSmall', { timestamps: 'segment' }),
        ],
      },
     aliyun_bailian_asr: {
       enabled: false,
        baseUrl: '',
        apiKey: '',
        workspaceId: '',
        region: 'cn-beijing',
        models: [
          ...ALIYUN_ASR_PRESET_MODELS.map(m =>
            asrModel(m.id, m.name, {
              enabled: m.preset,
              timestamps: m.supportsDiarization ? 'segment' : 'none',
              diarization: false,
              language: 'auto',
            })
          ),
          asrModel('paraformer-realtime-v2', 'Paraformer-Realtime-V2', {
            enabled: false,
            realtime: true,
            timestamps: 'none',
            language: 'auto',
            addedBy: 'default',
          }),
         asrModel('qwen-audio-3.0-asr-flash-streaming', 'Qwen-Audio-3.0-ASR-Flash-Streaming', {
           enabled: false,
           realtime: true,
           timestamps: 'none',
           language: 'auto',
           addedBy: 'default',
         }),
        ],
      },
    },
  }
}

// ────────── Normalize / Migrate ──────────
const VALID_TIMESTAMP_LEVELS = ['none', 'segment', 'word']

function normalizeTimestampLevel(value, fallback) {
  if (value === true) return 'segment'
  if (value === false) return 'none'
  const v = String(value || '').trim().toLowerCase()
  return VALID_TIMESTAMP_LEVELS.includes(v) ? v : fallback
}

function normalizeModelCard(source, fallbackId) {
  const s = source && typeof source === 'object' ? source : {}
  const caps = s.capabilities && typeof s.capabilities === 'object' ? s.capabilities : {}
  return {
    id: String(s.id || fallbackId).trim(),
    name: String(s.name || s.id || fallbackId).trim(),
    enabled: s.enabled ?? true,
    capabilities: {
      streaming: Boolean(caps.streaming ?? s.streaming ?? false),
      realtime: Boolean(caps.realtime ?? false),
      timestamps: normalizeTimestampLevel(caps.timestamps ?? s.timestamps, 'segment'),
      diarization: Boolean(caps.diarization ?? s.diarization ?? false),
    },
    language: String(s.language || 'auto'),
    customParams: s.customParams && typeof s.customParams === 'object'
      ? JSON.parse(JSON.stringify(s.customParams))
      : {},
    addedBy: s.addedBy || 'default',
  }
}

/** Migrate a v3 provider (single model field) into v4 model cards */
function migrateV3Provider(source, providerId, defaults) {
  const s = source && typeof source === 'object' ? source : {}
  const oldModel = String(s.model || '').trim()
  const models = []

  if (providerId === 'aliyun_bailian_asr') {
    for (const preset of defaults.models) {
      const isSelected = preset.id === oldModel
      models.push(asrModel(preset.id, preset.name, {
        enabled: isSelected || preset.enabled,
        streaming: isSelected ? Boolean(s.streaming?.enabled) : false,
        timestamps: isSelected
          ? normalizeTimestampLevel(s.enableTimestamps === false ? 'none' : 'segment', 'segment')
          : preset.capabilities.timestamps,
        diarization: isSelected ? Boolean(s.enableDiarization) : false,
        language: s.language || preset.language,
        customParams: isSelected ? (s.customParams || {}) : {},
      }))
    }
    if (oldModel && !defaults.models.find(m => m.id === oldModel)) {
      models.push(asrModel(oldModel, oldModel, {
        enabled: true,
        streaming: Boolean(s.streaming?.enabled),
        timestamps: normalizeTimestampLevel(s.enableTimestamps === false ? 'none' : 'segment', 'segment'),
        diarization: Boolean(s.enableDiarization),
        language: s.language || 'auto',
        customParams: s.customParams || {},
        addedBy: 'user',
      }))
    }
  } else {
    const modelId = oldModel || 'whisper-1'
    models.push(asrModel(modelId, modelId, {
      enabled: true,
      streaming: Boolean(s.streaming?.enabled),
      timestamps: normalizeTimestampLevel(s.timestampLevel, 'segment'),
      customParams: s.customParams || {},
    }))
  }

  const baseUrl = String(s.baseUrl ?? defaults?.baseUrl ?? '').trim()
  const result = {
    enabled: providerId === 'local_asr'
      ? Boolean(s.enabled && baseUrl)
      : Boolean(s.enabled ?? defaults.enabled),
    baseUrl: baseUrl === 'undefined' ? '' : baseUrl,
    apiKey: String(s.apiKey ?? defaults.apiKey),
    models,
  }
  if (providerId === 'aliyun_bailian_asr') {
    result.workspaceId = String(s.workspaceId ?? defaults.workspaceId).trim()
    result.region = String(s.region ?? defaults.region).trim() || defaults.region
  }
  return result
}

export function normalizeSpeechSettings(value = {}) {
  const defaults = createDefaultSpeechSettings()
  const input = value && typeof value === 'object' ? value : {}
  const providers = input.providers && typeof input.providers === 'object' ? input.providers : {}

  const normalizeProvider = (providerId) => {
    const source = providers[providerId]
    const providerDefaults = defaults.providers[providerId]

    // v4: already has models array
    if (source && Array.isArray(source.models)) {
      const baseUrl = String(source.baseUrl ?? providerDefaults?.baseUrl ?? '').trim()
      const result = {
        enabled: providerId === 'local_asr' ? Boolean(source.enabled && baseUrl) : Boolean(source.enabled),
        baseUrl: baseUrl === 'undefined' ? '' : baseUrl,
        apiKey: String(source.apiKey ?? providerDefaults.apiKey),
        models: source.models
          .filter(m => !(providerId === 'aliyun_bailian_asr'
            && !m.enabled
            && RETIRED_ALIYUN_ASR_PRESET_IDS.has(String(m.id || '').trim().toLowerCase())))
          .map(m => normalizeModelCard(m, m.id || 'model')),
      }
      if (providerId === 'aliyun_bailian_asr') {
        result.workspaceId = String(source.workspaceId ?? providerDefaults.workspaceId).trim()
        result.region = String(source.region ?? providerDefaults.region).trim() || providerDefaults.region
      }
      return result
    }

    // v3 migration
    return migrateV3Provider(source, providerId, providerDefaults)
  }

  const normalizedProviders = {
    local_asr: normalizeProvider('local_asr'),
    openai_whisper_compatible: normalizeProvider('openai_whisper_compatible'),
    siliconflow_asr: normalizeProvider('siliconflow_asr'),
    aliyun_bailian_asr: normalizeProvider('aliyun_bailian_asr'),
  }

  // Default model ref
  let defaultModelRef = String(input.defaultModelRef || '').trim()
  if (!defaultModelRef && input.defaultProviderId) {
    const pid = String(input.defaultProviderId)
    const provider = normalizedProviders[pid]
    if (provider?.enabled) {
      const first = provider.models.find(m => m.enabled)
      if (first) defaultModelRef = encodeModelRef(pid, first.id)
    }
  }
  if (defaultModelRef) {
    const { providerId, modelId } = parseModelRef(defaultModelRef)
    const provider = normalizedProviders[providerId]
    const model = provider?.models?.find(m => m.id === modelId)
    if (!provider?.enabled || !model?.enabled) defaultModelRef = ''
  }
  if (!defaultModelRef) {
    for (const def of SPEECH_PROVIDER_DEFINITIONS) {
      const provider = normalizedProviders[def.id]
      if (provider?.enabled) {
        const model = provider.models.find(m => m.enabled)
        if (model) {
          defaultModelRef = encodeModelRef(def.id, model.id)
          break
        }
      }
    }
  }

  return {
    version: 4,
    defaultModelRef,
    providers: normalizedProviders,
  }
}

// ────────── Readiness Checks ──────────
export function speechProviderReady(providerId, settings) {
  const provider = settings?.providers?.[providerId]
  if (!provider?.enabled) return false
  const hasModel = provider.models?.some(m => m.enabled && m.id)
 if (!hasModel) return false
 if (providerId === 'local_asr' || providerId === 'openai_whisper_compatible' || providerId === 'siliconflow_asr') {
   return !!provider.baseUrl?.trim()
 }
 if (providerId === 'aliyun_bailian_asr') {
    return !!provider.apiKey?.trim() && !!provider.workspaceId?.trim()
  }
  return false
}

// ────────── Store ──────────
export const useMediaStore = defineStore('media', () => {
  const speechSettings = ref(createDefaultSpeechSettings())
  const speechSettingsLoaded = ref(false)
  const speechSettingsSaving = ref(false)

  // Flat list of all enabled models across providers
  const configuredModels = computed(() => {
    const list = []
    for (const def of SPEECH_PROVIDER_DEFINITIONS) {
      const provider = speechSettings.value.providers[def.id]
      if (!provider?.enabled) continue
      for (const m of provider.models || []) {
        if (m.enabled) {
          const modelCapability = def.id === 'aliyun_bailian_asr' ? getAliyunAsrModelCapability(m.id) : null
          list.push({
            providerId: def.id,
            providerName: def.name,
            modelId: m.id,
            modelName: modelCapability?.name || m.name,
            ref: encodeModelRef(def.id, m.id),
            streaming: m.capabilities?.streaming === true,
            realtime: m.capabilities?.realtime === true,
            active: speechSettings.value.defaultModelRef === encodeModelRef(def.id, m.id),
          })
        }
      }
    }
    return list
  })

  // Streaming-ready models
  const streamingModels = computed(() => configuredModels.value.filter(m => m.streaming))

  // Backward compat: provider-level list (one entry per provider with enabled models)
  const configuredSpeechProviders = computed(() => SPEECH_PROVIDER_DEFINITIONS
    .filter(definition => speechProviderReady(definition.id, speechSettings.value))
    .map(definition => {
      const provider = speechSettings.value.providers[definition.id] || {}
      const { modelId } = parseModelRef(speechSettings.value.defaultModelRef)
      const model = provider.models?.find(m => m.id === modelId && m.enabled)
        || provider.models?.find(m => m.enabled)
        || null
      const modelCapability = definition.id === 'aliyun_bailian_asr'
        ? getAliyunAsrModelCapability(model?.id)
        : null
      return {
        ...definition,
        model: model?.id || '',
        modelName: modelCapability?.name || model?.name || '',
        modelCapability,
        modelLimitText: definition.id === 'aliyun_bailian_asr' ? formatAliyunAsrLimit(modelCapability) : '',
        enableDiarization: model?.capabilities?.diarization === true,
        active: parseModelRef(speechSettings.value.defaultModelRef).providerId === definition.id,
      }
    }))

  const defaultSpeechProvider = computed(() => configuredSpeechProviders.value.find(item => item.active)
    || configuredSpeechProviders.value[0]
    || null)

  const defaultModel = computed(() => configuredModels.value.find(m => m.active)
    || configuredModels.value[0]
    || null)

  function getProvider(id) {
    return speechSettings.value.providers[id] || null
  }

  function getModel(providerId, modelId) {
    const provider = getProvider(providerId)
    return provider?.models?.find(m => m.id === modelId) || null
  }

  function addModelToProvider(providerId, model) {
    const provider = getProvider(providerId)
    if (!provider) return { error: '服务商不存在' }
    const id = model.id || ('model-' + Date.now())
    if (provider.models.find(m => m.id === id)) return { error: '模型 ID 已存在' }
    provider.models.push(asrModel(id, model.name || id, {
      enabled: model.enabled ?? true,
      streaming: model.capabilities?.streaming ?? false,
      timestamps: model.capabilities?.timestamps ?? 'segment',
      diarization: model.capabilities?.diarization ?? false,
      language: model.language || 'auto',
      customParams: model.customParams || {},
      addedBy: 'user',
    }))
    return { success: true }
  }

  function updateModelInProvider(providerId, modelId, patch) {
    const m = getModel(providerId, modelId)
    if (!m) return false
    const { capabilities, ...rest } = patch
    if (capabilities) m.capabilities = { ...m.capabilities, ...capabilities }
    Object.assign(m, rest)
    return true
  }

  function removeModelFromProvider(providerId, modelId) {
    const provider = getProvider(providerId)
    if (!provider) return false
    const idx = provider.models.findIndex(m => m.id === modelId)
    if (idx < 0) return false
    provider.models.splice(idx, 1)
    if (speechSettings.value.defaultModelRef === encodeModelRef(providerId, modelId)) {
      speechSettings.value.defaultModelRef = ''
    }
    return true
  }

  function setDefaultModel(ref) {
    const { providerId, modelId } = parseModelRef(ref)
    const m = getModel(providerId, modelId)
    if (!m) return { error: '模型不存在' }
    speechSettings.value.defaultModelRef = ref
    return { success: true }
  }

  async function loadSpeechSettings({ force = false } = {}) {
    if (speechSettingsLoaded.value && !force) return speechSettings.value
    try {
      const stored = await window.electronAPI?.db?.settings?.get('mediaSpeechSettings')
      const normalized = normalizeSpeechSettings(stored || {})
      speechSettings.value = normalized
      if (stored && JSON.stringify(stored) !== JSON.stringify(normalized)) {
        await window.electronAPI?.db?.settings?.set('mediaSpeechSettings', JSON.parse(JSON.stringify(normalized)))
      }
    } catch (error) {
      console.warn('[Media] load speech settings failed:', error)
      speechSettings.value = createDefaultSpeechSettings()
    } finally {
      speechSettingsLoaded.value = true
    }
    return speechSettings.value
  }

  async function saveSpeechSettings(nextSettings = speechSettings.value) {
    speechSettingsSaving.value = true
    try {
      const normalized = normalizeSpeechSettings(nextSettings)
      await window.electronAPI?.db?.settings?.set('mediaSpeechSettings', JSON.parse(JSON.stringify(normalized)))
      speechSettings.value = normalized
      speechSettingsLoaded.value = true
      return { success: true, data: normalized }
    } catch (error) {
      console.error('[Media] save speech settings failed:', error)
      return { success: false, error: error?.message || '保存语音模型配置失败' }
    } finally {
      speechSettingsSaving.value = false
    }
  }

  return {
    speechSettings,
    speechSettingsLoaded,
    speechSettingsSaving,
    configuredSpeechProviders,
    defaultSpeechProvider,
    configuredModels,
    streamingModels,
    defaultModel,
    getProvider,
    getModel,
    addModelToProvider,
    updateModelInProvider,
    removeModelFromProvider,
    setDefaultModel,
    loadSpeechSettings,
    saveSpeechSettings,
  }
})
