<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import {
  ALIYUN_ASR_MODELS,
  createDefaultSpeechSettings,
  normalizeSpeechSettings,
  SPEECH_PROVIDER_DEFINITIONS,
  speechProviderReady,
  useMediaStore,
} from '@/stores/media'
import { useMessage } from '@/components/MsMessage/useMessage'
import { checkSpeechProvider } from '@/apis/media'
import { fetchSpeechModels } from '@/apis/media'
import { formatAliyunAsrLimit, getAliyunAsrModelCapability, getAliyunAsrModelTypeLabel } from '@/constants/aliyunAsrModels'
import SpeechOptionSelect from './SpeechOptionSelect.vue'
import { encodeModelRef, parseModelRef } from '@/utils/modelRef'
import { useSettingsStore } from '@/stores/settings'
import { resolveProviderModelConfig } from '@/utils/speechModelResolver'

const appStore = useAppStore()
const mediaStore = useMediaStore()
const msg = useMessage()

const isDark = computed(() => appStore.isDark)
const activeCapability = ref('stt')
const selectedProviderId = ref('local_asr')
const draft = ref(createDefaultSpeechSettings())
const loading = ref(false)
const refreshing = ref(false)
const saving = ref(false)
const dirty = ref(false)
const hydrated = ref(false)
const showSecrets = ref({})
const checkingProviderId = ref('')
const checkResults = ref({})
const REFRESH_ROTATION_MS = 600

const selectedDefinition = computed(() => SPEECH_PROVIDER_DEFINITIONS.find(item => item.id === selectedProviderId.value) || SPEECH_PROVIDER_DEFINITIONS[0])
const selectedForm = computed(() => draft.value.providers[selectedProviderId.value])
const configuredCount = computed(() => SPEECH_PROVIDER_DEFINITIONS.filter(item => speechProviderReady(item.id, draft.value)).length)
const settingsStore = useSettingsStore()
const accentHex = computed(() => settingsStore.currentAccentHex)
// 额外参数输入框：用内联 style 设边框（绕过 CSS 优先级问题，与卡片边框一致）
const paramInputCls = computed(() =>
  isDark.value
    ? 'bg-d2 text-wt-main placeholder-wt-dim outline-none transition-colors'
    : 'bg-l2 text-lt-main placeholder-lt-aux outline-none transition-colors'
)
const paramInputStyle = computed(() => ({
  borderWidth: '1px',
  borderStyle: 'solid',
  borderRadius: '6px',
  borderColor: isDark.value ? 'rgba(255,255,255,0.1)' : 'rgba(74,108,255,0.2)'
}))
const defaultModelOptions = computed(() => {
  const list = []
  for (const def of SPEECH_PROVIDER_DEFINITIONS) {
    const provider = draft.value.providers[def.id]
    if (!provider?.enabled) continue
    for (const m of provider.models || []) {
      if (!m.enabled) continue
      const cap = def.id === 'aliyun_bailian_asr' ? getAliyunAsrModelCapability(m.id) : null
      list.push({ value: encodeModelRef(def.id, m.id), label: cap?.name || m.name || m.id, description: def.name })
    }
  }
  return list
})
function isDefaultProvider(id) { return parseModelRef(draft.value.defaultModelRef).providerId === id }
const expandedModels = ref({})
const showAddModel = ref(false)
const newModel = ref({ id: '', name: '', streaming: false, timestamps: 'segment', diarization: false, language: 'auto', customParams: {} })

const fetchingModels = ref(false)
const showFetchModal = ref(false)
const fetchedModels = ref([])
const fetchSelectedIds = ref([])
const fetchSearchQuery = ref('')

function toggleModelExpand(id) {
  expandedModels.value = { ...expandedModels.value, [id]: !expandedModels.value[id] }
}

function openAddModel() {
  newModel.value = { id: '', name: '', streaming: false, timestamps: 'segment', diarization: false, language: 'auto', customParams: {} }
  showAddModel.value = true
}

function confirmAddModel() {
  const form = selectedForm.value
  if (!form.models) form.models = []
  const id = newModel.value.id || ('model-' + Date.now())
  if (form.models.find(m => m.id === id)) {
    msg.error('模型 ID 已存在')
    return
  }
  form.models.push({
    id,
    name: newModel.value.name || id,
    enabled: true,
    capabilities: {
      streaming: newModel.value.streaming,
      timestamps: newModel.value.timestamps,
      diarization: newModel.value.diarization,
    },
    language: newModel.value.language,
    customParams: newModel.value.customParams,
    addedBy: 'user',
  })
  showAddModel.value = false
  expandedModels.value = { ...expandedModels.value, [id]: true }
}

const canFetchModels = computed(() => selectedProviderId.value !== 'aliyun_bailian_asr')
const existingModelIds = computed(() => (selectedForm.value.models || []).map(m => m.id))
const filteredFetchedModels = computed(() => {
  const q = fetchSearchQuery.value.trim().toLowerCase()
  if (!q) return fetchedModels.value
  return fetchedModels.value.filter(m => m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q)))
})

async function fetchModelList() {
  if (fetchingModels.value) return
  const form = selectedForm.value
  if (!form.baseUrl?.trim()) {
    msg.error('请先填写 Base URL')
    return
  }
  fetchingModels.value = true
  try {
    const result = await fetchSpeechModels(selectedProviderId.value, {
      baseUrl: form.baseUrl,
      apiKey: form.apiKey || '',
    })
    if (!result?.success) throw new Error(result?.error || result?.message || '获取失败')
    fetchedModels.value = Array.isArray(result.models) ? result.models : []
    fetchSelectedIds.value = []
    fetchSearchQuery.value = ''
    showFetchModal.value = true
  } catch (error) {
    msg.error(error?.message || '获取模型列表失败')
  } finally {
    fetchingModels.value = false
  }
}

function toggleFetchSelect(modelId) {
  const idx = fetchSelectedIds.value.indexOf(modelId)
  if (idx >= 0) fetchSelectedIds.value = [...fetchSelectedIds.value.slice(0, idx), ...fetchSelectedIds.value.slice(idx + 1)]
  else fetchSelectedIds.value = [...fetchSelectedIds.value, modelId]
}

function confirmFetchAdd() {
  const form = selectedForm.value
  if (!form.models) form.models = []
  let added = 0
  for (const model of fetchedModels.value) {
    if (!fetchSelectedIds.value.includes(model.id)) continue
    if (form.models.find(m => m.id === model.id)) continue
    form.models.push({
      id: model.id,
      name: model.name || model.id,
      enabled: true,
      capabilities: { streaming: false, realtime: false, timestamps: 'segment', diarization: false },
      language: 'auto',
      customParams: {},
      addedBy: 'user',
    })
    expandedModels.value = { ...expandedModels.value, [model.id]: true }
    added++
  }
  showFetchModal.value = false
  if (added) msg.success(`已添加 ${added} 个模型，点击保存生效`)
}

function isDefaultModel(modelId) { return draft.value.defaultModelRef === encodeModelRef(selectedProviderId.value, modelId) }

const providerIcons = Object.freeze({
  local_asr: 'local-asr',
  openai_whisper_compatible: 'openai',
  siliconflow_asr: 'siliconflow',
  aliyun_bailian_asr: 'bailian',
})

const languageOptions = [
  { value: 'auto', label: '自动识别', description: '由服务商判断音频中的主要语言' },
  { value: 'zh', label: '中文', description: '优先按中文语音进行识别' },
  { value: 'en', label: '英文', description: '优先按英文语音进行识别' },
  { value: 'ja', label: '日文', description: '优先按日文语音进行识别' },
]

const timestampOptions = [
  { value: 'none', label: '不支持', description: '只返回整段转录文本' },
  { value: 'segment', label: '句段级', description: '返回句段开始与结束时间' },
  { value: 'word', label: '词级', description: '返回更细粒度的词语时间戳' },
]

const regionOptions = [
  { value: 'cn-beijing', label: '中国大陆（北京）', description: '适用于中国大陆百炼工作空间' },
  { value: 'ap-southeast-1', label: '国际（新加坡）', description: '适用于国际站百炼工作空间' },
]

onMounted(loadSettings)

watch(draft, () => {
  if (hydrated.value) {
    dirty.value = true
    checkResults.value = { ...checkResults.value, [selectedProviderId.value]: null }
  }
}, { deep: true, flush: 'sync' })

async function loadSettings() {
  if (loading.value) return
  loading.value = true
  hydrated.value = false
  try {
    const settings = await mediaStore.loadSpeechSettings({ force: true })
    draft.value = normalizeSpeechSettings(settings)
    const defaultPid = parseModelRef(draft.value.defaultModelRef).providerId
    selectedProviderId.value = defaultPid || 'local_asr'
    dirty.value = false
  } catch (error) {
    msg.error(error?.message || '加载语音模型配置失败')
  } finally {
    hydrated.value = true
    loading.value = false
  }
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function waitForRefreshFrame(ms) {
  return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms)))
}

async function refreshSettings() {
  if (loading.value || refreshing.value) return
  refreshing.value = true
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  try {
    await loadSettings()
  } finally {
    if (!prefersReducedMotion()) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const elapsed = Math.max(0, now - startedAt)
      const remainder = elapsed % REFRESH_ROTATION_MS
      const remaining = elapsed < REFRESH_ROTATION_MS
        ? REFRESH_ROTATION_MS - elapsed
        : remainder < 12 ? 0 : REFRESH_ROTATION_MS - remainder
      if (remaining > 0) await waitForRefreshFrame(remaining)
    }
    refreshing.value = false
  }
}

function providerReady(id) {
  return speechProviderReady(id, draft.value)
}

function providerStatus(id) {
  const form = draft.value.providers[id]
  if (!form?.enabled) return '未启用'
  return providerReady(id) ? '可用' : '待完善'
}

function selectProvider(id) {
  selectedProviderId.value = id
}

function providerIcon(id) {
  return providerIcons[id] || 'local-asr'
}

function toggleProvider() {
  const form = selectedForm.value
  form.enabled = !form.enabled
}

function setDefaultProvider(id = selectedProviderId.value) {
  const provider = draft.value.providers[id]
  if (!provider) return
  provider.enabled = true
  const first = provider.models?.find(m => m.enabled)
  if (first) draft.value.defaultModelRef = encodeModelRef(id, first.id)
}

function validate() {
  for (const provider of SPEECH_PROVIDER_DEFINITIONS) {
    const form = draft.value.providers[provider.id]
    if (!form.enabled) continue
    if (provider.id === 'local_asr' && !form.baseUrl?.trim())
      throw new Error('本地 ASR 需要填写 Base URL。')
    if (provider.id === 'openai_whisper_compatible' && !form.baseUrl?.trim())
      throw new Error('Whisper Compatible 需要填写 Base URL。')
    if (provider.id === 'aliyun_bailian_asr' && (!form.apiKey?.trim() || !form.workspaceId?.trim()))
      throw new Error('阿里百炼需要填写 API Key 和 Workspace ID。')
    if (!form.models?.some(m => m.enabled && m.id?.trim()))
      throw new Error(`${provider.name} 至少需要启用一个模型`)
  }
}

async function saveSettings() {
  if (saving.value) return
  try {
    validate()
    saving.value = true
    const result = await mediaStore.saveSpeechSettings(draft.value)
    if (!result.success) throw new Error(result.error)
    draft.value = normalizeSpeechSettings(result.data)
    dirty.value = false
    msg.success('语音模型配置已保存')
  } catch (error) {
    msg.error(error.message || '保存失败')
  } finally {
    saving.value = false
  }
}

function setThisAsDefault(modelId) {
  draft.value.defaultModelRef = encodeModelRef(selectedProviderId.value, modelId)
}
function toggleCapability(model, capability) {
  if (!model.capabilities) model.capabilities = { streaming: false, realtime: false, timestamps: 'segment', diarization: false }
  model.capabilities[capability] = !model.capabilities[capability]
}
function addModel() {
  const form = selectedForm.value
  if (!form.models) form.models = []
  form.models.push({ id: 'model-' + Date.now(), name: '新模型', enabled: true, capabilities: { streaming: false, realtime: false, timestamps: 'segment', diarization: false }, language: 'auto', customParams: {}, addedBy: 'user' })
}
function removeModel(modelId) {
  const form = selectedForm.value
  const idx = form.models.findIndex(m => m.id === modelId)
  if (idx >= 0) form.models.splice(idx, 1)
  if (draft.value.defaultModelRef === encodeModelRef(selectedProviderId.value, modelId)) draft.value.defaultModelRef = ''
}
function addParamToModel(model) {
  if (!model.customParams) model.customParams = {}
  model.customParams[''] = ''
}
function renameParam(model, oldKey, e) {
  const newKey = e.target.value.trim()
  if (oldKey === newKey) return
  const val = model.customParams[oldKey]
  delete model.customParams[oldKey]
  model.customParams[newKey] = val
}
function delParam(model, key) {
  delete model.customParams[key]
}

function toggleSecret(id) {
  showSecrets.value = { ...showSecrets.value, [id]: !showSecrets.value[id] }
}

async function checkSelectedProvider() {
  const providerId = selectedProviderId.value
  if (checkingProviderId.value) return
  checkingProviderId.value = providerId
  checkResults.value = { ...checkResults.value, [providerId]: null }
  try {
    const result = await checkSpeechProvider(providerId, resolveProviderModelConfig(selectedForm.value, draft.value.defaultModelRef, providerId))
    if (!result?.success) throw new Error(result?.message || '配置检查失败')
    checkResults.value = { ...checkResults.value, [providerId]: { success: true, message: result.message || '配置可用' } }
    msg.success(result.message || '配置检查通过')
  } catch (error) {
    const message = error?.message || '配置检查失败'
    checkResults.value = { ...checkResults.value, [providerId]: { success: false, message } }
    msg.error(message)
  } finally {
    checkingProviderId.value = ''
  }
}
</script>

<template>
  <div class="speech-page max-w-6xl mx-auto px-4 py-4 space-y-2.5" :class="isDark ? 'text-wt-main' : 'text-lt-main'">
    <section
      class="speech-intro"
      :class="isDark ? 'speech-intro--dark' : 'speech-intro--light'">
      <div class="speech-intro__icon">
        <i class="ri-mic-ai-line" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <h2 :class="isDark ? 'text-wt-main' : 'text-lt-main'">语音模型配置</h2>
          <span class="speech-count">{{ configuredCount }} 个语音识别服务可用</span>
        </div>
        <p :class="isDark ? 'text-wt-aux' : 'text-lt-aux'">
          统一管理语音相关模型与服务商。当前支持为音视频解析配置语音转文字服务，文本转语音即将支持。
        </p>
      </div>
      <button class="ghost-button refresh-button" :class="isDark ? 'ghost-button--dark' : 'ghost-button--light'" :disabled="loading || refreshing" :aria-busy="refreshing" aria-label="重新加载配置" title="重新加载配置" @click="refreshSettings">
        <i class="ri-refresh-line refresh-icon" :class="{ 'refresh-icon--spinning': refreshing }" />
      </button>
    </section>

    <div class="capability-tabs" :class="isDark ? 'capability-tabs--dark' : 'capability-tabs--light'">
      <button :class="{ active: activeCapability === 'stt' }" @click="activeCapability = 'stt'">
        <i class="ri-speech-to-text-line text-[16px]" />
        <span class="text-[15px]">语音转文本</span>
        <span class="available-badge">可配置</span>
      </button>
      <button :class="{ active: activeCapability === 'tts' }" @click="activeCapability = 'tts'">
       <i class="ri-text-to-speech-line text-[16px]"></i>
        <span class="text-[15px]">文本转语音</span>
        <span class="future-badge">即将支持</span>
      </button>
    </div>

    <template v-if="activeCapability === 'stt'">
      <div class="speech-layout">
        <aside class="provider-rail rounded-md" :class="isDark ? 'panel-dark' : 'panel-light'">
          <div class="rail-heading">
            <div>
              <span :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">语音识别服务商</span>
              <small :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">可同时配置多个；单次只使用媒体解析中明确选择的服务，选择“自动”时才使用默认项</small>
            </div>
          </div>

          <button
            v-for="provider in SPEECH_PROVIDER_DEFINITIONS"
            :key="provider.id"
            class="provider-card"
            :class="[
              selectedProviderId === provider.id ? 'provider-card--active' : '',
              isDark ? 'provider-card--dark' : 'provider-card--light',
            ]"
            @click="selectProvider(provider.id)">
            <span class="provider-card__icon">
              <SvgIcon :icon-class="providerIcon(provider.id)" :size="26" />
            </span>
            <span class="provider-card__copy">
              <span class="provider-card__name">
                {{ provider.name }}
                <i v-if="isDefaultProvider(provider.id)" class="ri-star-fill default-star" title="默认服务商" />
              </span>
            </span>
            <span
              class="provider-state"
              :class="providerReady(provider.id) ? 'provider-state--ready' : draft.providers[provider.id].enabled ? 'provider-state--warn' : ''">
              {{ providerStatus(provider.id) }}
            </span>
          </button>
        </aside>

        <section class="config-panel rounded-md" :class="isDark ? 'panel-dark' : 'panel-light'">
          <header class="config-header">
            <div class="config-provider-icon">
              <SvgIcon :icon-class="providerIcon(selectedProviderId)" :size="40" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 :class="isDark ? 'text-wt-main' : 'text-lt-main'">{{ selectedDefinition.name }}</h3>
                <span v-if="isDefaultProvider(selectedProviderId)" class="default-pill">默认</span>
              </div>
              <p :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">{{ selectedDefinition.description }}</p>
            </div>
            <button
              type="button"
              class="switch-control"
              role="switch"
              :aria-checked="selectedForm.enabled"
              :aria-label="`${selectedDefinition.name}${selectedForm.enabled ? '已启用' : '未启用'}`"
              :class="{ on: selectedForm.enabled }"
              @click="toggleProvider">
              <span />
            </button>
          </header>

          <div class="config-body" :class="{ 'config-body--disabled': !selectedForm.enabled, 'config-body--aliyun': selectedProviderId === 'aliyun_bailian_asr' }">
            <!-- Connection settings -->
            <template v-if="selectedProviderId === 'aliyun_bailian_asr'">
              <div class="field-grid two-col">
                <div class="field-block"><span>地域</span><SpeechOptionSelect v-model="selectedForm.region" :options="regionOptions" :is-dark="isDark" aria-label="选择百炼地域" /><small>API Key、Workspace 与地域需要保持一致。</small></div>
                <label class="field-block"><span>Workspace ID</span><input v-model="selectedForm.workspaceId" placeholder="输入百炼 Workspace ID" /></label>
              </div>
              <label class="field-block"><span>API Key</span><div class="secret-input"><input v-model="selectedForm.apiKey" :type="showSecrets.aliyun_bailian_asr ? 'text' : 'password'" placeholder="输入百炼 API Key" /><button @click="toggleSecret('aliyun_bailian_asr')"><i :class="showSecrets.aliyun_bailian_asr ? 'ri-eye-off-line' : 'ri-eye-line'" /></button></div></label>
            </template>
            <template v-else>
              <label class="field-block"><span>Base URL</span><div class="input-with-icon"><i class="ri-links-line" /><input v-model="selectedForm.baseUrl" :placeholder="selectedProviderId === 'local_asr' ? 'http://127.0.0.1:8000/v1' : 'https://api.example.com/v1'" /></div><small>请求固定发送到 /audio/transcriptions。</small></label>
              <label class="field-block"><span>API Key <em v-if="selectedProviderId === 'local_asr'">可选</em></span><div class="secret-input"><input v-model="selectedForm.apiKey" :type="showSecrets[selectedProviderId] ? 'text' : 'password'" :placeholder="selectedProviderId === 'local_asr' ? '本地服务不鉴权时留空' : '输入服务商 API Key'" /><button @click="toggleSecret(selectedProviderId)"><i :class="showSecrets[selectedProviderId] ? 'ri-eye-off-line' : 'ri-eye-line'" /></button></div></label>
            </template>

            <!-- Model cards -->
            <div>
              <div class="flex flex-wrap items-center gap-2 mb-3">
                <i class="ri-stack-line text-[14px] text-sky-400" />
                <span class="text-[13px] font-semibold" :class="isDark ? 'text-wt-main' : 'text-lt-main'">模型列表</span>
                <span class="text-[11px] px-1.5 py-0.5 rounded"
                  :class="isDark ? 'bg-d3 text-wt-dim' : 'bg-l3 text-lt-aux'">{{ selectedForm.models?.length || 0 }}</span>
                <div class="flex-1" />
                <button
                  v-if="canFetchModels"
                  class="flex items-center gap-1 px-2.5 py-1 rounded-sm text-[11px] font-medium transition-opacity"
                  :class="isDark ? 'text-wt-sub bg-white/5 hover:bg-white/8' : 'text-lt-sub bg-brand-50 hover:bg-brand-100'"
                  :disabled="fetchingModels"
                  @click="fetchModelList">
                  <i :class="fetchingModels ? 'ri-loader-4-line animate-spin' : 'ri-download-cloud-line'" class="text-[13px]" /> {{ fetchingModels ? '获取中' : '获取模型' }}
                </button>
                <button
                  class="flex items-center gap-1 px-2.5 py-1 rounded-sm text-[11px] font-medium text-white transition-opacity"
                  :style="{ background: accentHex }"
                  @click="openAddModel">
                  <i class="ri-add-line text-[13px]" /> 添加模型
                </button>
              </div>
              <div class="space-y-2.5">
                <div
                  v-for="model in selectedForm.models"
                  :key="model.id"
                  class="rounded-lg border transition-all"
                  :style="{
                    background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(74,108,255,0.025)',
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(74,108,255,0.22)',
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    boxShadow: isDark ? '0 1px 3px rgba(0,0,0,0.2)' : '0 1px 3px rgba(0,0,0,0.04)'
                  }"
                  :class="[
                    !model.enabled ? 'opacity-50' : '',
                    isDefaultModel(model.id) ? 'model-card--default' : ''
                  ]">
                  <div class="flex flex-wrap items-center gap-2 px-3 py-2.5 cursor-pointer select-none" @click="toggleModelExpand(model.id)">
                    <button class="w-5 h-5 grid place-items-center shrink-0 transition-colors"
                      :class="isDark ? 'text-wt-dim hover:text-wt-main' : 'text-lt-aux hover:text-lt-main'"
                      @click.stop="toggleModelExpand(model.id)">
                      <i :class="expandedModels[model.id] ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'" class="text-[16px]" />
                    </button>
                    <button class="w-5 h-5 grid place-items-center shrink-0 transition-colors"
                      :class="isDark ? 'text-wt-dim hover:text-wt-main' : 'text-lt-aux hover:text-lt-main'"
                      :style="isDefaultModel(model.id) ? { color: accentHex } : null"
                      @click.stop="setThisAsDefault(model.id)" title="设为默认">
                      <i :class="isDefaultModel(model.id) ? 'ri-star-fill' : 'ri-star-line'" class="text-[14px]" />
                   </button>
                    <span class="text-[13px] font-medium truncate min-w-0" :class="isDark ? 'text-wt-main' : 'text-lt-main'">{{ model.name }}</span>
                    <span class="text-[10.5px] font-mono px-1.5 py-0.5 rounded shrink-0"
                      :class="isDark ? 'bg-d4 text-wt-sub' : 'bg-l4 text-lt-aux'">{{ model.id }}</span>
                    <span v-if="selectedProviderId === 'aliyun_bailian_asr' && getAliyunAsrModelTypeLabel(model.id)" class="text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium text-cyan-400 bg-cyan-400/8" :title="`${getAliyunAsrModelTypeLabel(model.id)}调用`">{{ getAliyunAsrModelTypeLabel(model.id) }}</span>
                    <span v-if="model.capabilities?.streaming" class="text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium text-emerald-400 bg-emerald-400/8">流式</span>
                    <span v-if="model.capabilities?.realtime" class="text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium text-amber-400 bg-amber-400/8">实时</span>
                    <span v-if="model.capabilities?.timestamps && model.capabilities.timestamps !== 'none'" class="text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium text-sky-400 bg-sky-400/8">{{ model.capabilities.timestamps === 'word' ? '词级' : '句级' }}</span>
                    <span v-if="model.capabilities?.diarization" class="text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium text-violet-400 bg-violet-400/8">分离</span>
                    <div class="flex-1" />
                    <label class="mc-switch shrink-0" :class="model.enabled ? 'on' : ''" @click.stop>
                      <input type="checkbox" :checked="model.enabled" @change="model.enabled = !model.enabled">
                      <span class="slider" :style="model.enabled ? { background: accentHex } : null" />
                    </label>
                    <button class="w-7 h-7 rounded grid place-items-center text-red-400 hover:bg-red-400/8 shrink-0 transition-colors"
                      @click.stop="removeModel(model.id)" title="删除">
                      <i class="ri-delete-bin-line text-[13px]" />
                    </button>
                  </div>
                  <div v-show="expandedModels[model.id]" class="px-3.5 pb-3.5 pt-1 space-y-3 border-t" :class="isDark ? 'border-d4' : 'border-bdrL'">
                    <div class="grid grid-cols-2 model-fields-2col gap-x-5 gap-y-3 pt-3">
                      <div>
                        <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">名称</label>
                        <input v-model="model.name"
                          class="speech-param-input w-full h-8 px-2.5 text-[13px]"
                          :class="paramInputCls" :style="paramInputStyle" placeholder="显示名称" />
                      </div>
                      <div>
                        <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">模型 ID</label>
                        <input v-model="model.id"
                          class="speech-param-input w-full h-8 px-2.5 text-[13px] font-mono"
                          :class="paramInputCls" :style="paramInputStyle"
                          :placeholder="selectedProviderId === 'aliyun_bailian_asr' ? '百炼模型 ID' : 'whisper-1'" />
                      </div>
                    </div>
                    <div class="flex flex-wrap items-center gap-x-5 gap-y-2.5 pt-3 border-t" :class="isDark ? 'border-d4' : 'border-bdrL'">
                      <div class="flex items-center gap-2">
                        <span class="text-[12px] font-medium shrink-0" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">是否开始流式</span>
                        <label class="mc-switch" :class="model.capabilities.streaming ? 'on' : ''">
                          <input type="checkbox" :checked="model.capabilities.streaming" @change="toggleCapability(model, 'streaming')">
                          <span class="slider" :style="model.capabilities.streaming ? { background: accentHex } : null" />
                        </label>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="text-[12px] font-medium shrink-0" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">实时流式</span>
                        <label class="mc-switch" :class="model.capabilities.realtime ? 'on' : ''">
                          <input type="checkbox" :checked="model.capabilities.realtime" @change="toggleCapability(model, 'realtime')">
                          <span class="slider" :style="model.capabilities.realtime ? { background: accentHex } : null" />
                        </label>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="text-[11px] font-medium shrink-0" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">时间戳</span>
                        <div class="w-[200px] mc-select-wrap">
                          <SpeechOptionSelect v-model="model.capabilities.timestamps" :options="timestampOptions" :is-dark="isDark" compact drop-up menu-min-width="200px" />
                        </div>
                      </div>
                      <template v-if="selectedProviderId === 'aliyun_bailian_asr'">
                        <div class="flex items-center gap-2">
                          <span class="text-[12px] font-medium shrink-0" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">是否开始分离</span>
                          <label class="mc-switch" :class="model.capabilities.diarization ? 'on' : ''">
                            <input type="checkbox" :checked="model.capabilities.diarization" @change="toggleCapability(model, 'diarization')">
                            <span class="slider" :style="model.capabilities.diarization ? { background: accentHex } : null" />
                          </label>
                        </div>
                        <div class="flex items-center gap-2">
                          <span class="text-[12px] font-medium shrink-0" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">语言</span>
                          <div class="w-[200px] mc-select-wrap">
                            <SpeechOptionSelect v-model="model.language" :options="languageOptions" :is-dark="isDark" compact drop-up menu-min-width="220px" />
                          </div>
                        </div>
                      </template>
                    </div>
                    <div v-if="selectedProviderId === 'aliyun_bailian_asr' && getAliyunAsrModelCapability(model.id)"
                      class="flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-lg"
                      :class="isDark ? 'bg-d3 text-wt-dim' : 'bg-l3 text-lt-aux'">
                      <i class="ri-information-line" />
                      <span>{{ getAliyunAsrModelCapability(model.id).description }} · {{ formatAliyunAsrLimit(getAliyunAsrModelCapability(model.id)) }}</span>
                    </div>
                    <div class="pt-3 border-t" :class="isDark ? 'border-d4' : 'border-bdrL'">
                      <div class="flex items-center gap-1.5 mb-1.5">
                        <span class="text-[11px] font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">额外参数</span>
                        <button class="text-[11px] px-1.5 py-0.5 rounded border transition-colors"
                          :class="isDark ? 'border-d4 hover:bg-d3' : 'border-bdrL hover:bg-l3'" :style="{ color: accentHex }"
                          @click="addParamToModel(model)"><i class="ri-add-line" /> 添加</button>
                     </div>
                      <div v-for="(pv, pk) in model.customParams" :key="pk" class="flex flex-wrap items-center gap-2 mb-1.5">
                        <input :value="pk" @change="e => renameParam(model, pk, e)"
                          class="speech-param-input w-[140px] max-w-full h-8 px-2 text-[12px]"
                          :class="paramInputCls" :style="paramInputStyle" placeholder="key" />
                        <input v-model="model.customParams[pk]"
                          class="speech-param-input flex-1 min-w-0 h-8 px-2 text-[12px]"
                          :class="paramInputCls" :style="paramInputStyle" placeholder="value" />
                        <button class="w-8 h-8 rounded-md grid place-items-center text-red-400 hover:bg-red-400/8 shrink-0 transition-colors"
                          @click="delParam(model, pk)"><i class="ri-delete-bin-line text-[13px]" /></button>
                      </div>
                      <p v-if="!model.customParams || !Object.keys(model.customParams).length" class="text-[11px]"
                        :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">
                        暂无。可添加覆盖该模型的请求参数。
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>

          <footer class="config-footer">
            <div class="config-footer__status">
              <strong :class="providerReady(selectedProviderId) ? 'text-emerald-500' : isDark ? 'text-wt-dim' : 'text-lt-aux'">
                {{ providerReady(selectedProviderId) ? '配置完整，可以用于转录' : selectedForm.enabled ? '已启用，但配置尚未完整' : '当前服务商未启用' }}
              </strong>
              <small v-if="!isDefaultProvider(selectedProviderId) && defaultModelOptions.length" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">当前默认：{{ defaultModelOptions.find(o => o.value === draft.defaultModelRef)?.label || '未设置' }}</small>
              <small v-if="checkResults[selectedProviderId]" :class="checkResults[selectedProviderId].success ? 'check-result--success' : 'check-result--error'">{{ checkResults[selectedProviderId].message }}</small>
            </div>
            <div class="config-footer__actions">
              <button v-if="!isDefaultProvider(selectedProviderId)" class="secondary-button" :class="isDark ? 'secondary-button--dark' : 'secondary-button--light'" @click="setDefaultProvider()"><i class="ri-star-line" />设为默认</button>
              <button class="secondary-button" :class="isDark ? 'secondary-button--dark' : 'secondary-button--light'" :disabled="Boolean(checkingProviderId)" @click="checkSelectedProvider"><i :class="checkingProviderId === selectedProviderId ? 'ri-loader-4-line animate-spin' : 'ri-pulse-line'" />{{ checkingProviderId === selectedProviderId ? '检查中' : '检查配置' }}</button>
              <button class="primary-button" :disabled="saving || !dirty" @click="saveSettings"><i :class="saving ? 'ri-loader-4-line animate-spin' : 'ri-save-3-line'" />{{ saving ? '保存中' : '保存配置' }}</button>
            </div>

          </footer>
        </section>
      </div>
    </template>

    <section v-else class="tts-future" :class="isDark ? 'panel-dark' : 'panel-light'">
      <div class="tts-future__mark"><i class="ri-volume-up-line" /></div>
      <span class="future-label">即将支持</span>
      <h3 :class="isDark ? 'text-wt-main' : 'text-lt-main'">文本转语音配置将在后续开放</h3>
    </section>
  </div>

    <Teleport to="body">
      <div v-if="showAddModel" class="modal-overlay" @click.self="showAddModel = false">
        <div class="modal-dialog" :class="isDark ? 'modal-dialog--dark' : 'modal-dialog--light'">
          <div class="modal-head">
            <h3 :class="isDark ? 'text-wt-main' : 'text-lt-main'">添加模型</h3>
            <button class="modal-close" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'" @click="showAddModel = false"><i class="ri-close-line" /></button>
          </div>
          <div class="modal-body">
            <div class="grid grid-cols-2 gap-x-5 gap-y-3">
              <div>
                <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">名称</label>
                <input v-model="newModel.name"
                  class="speech-param-input w-full h-8 px-2.5 text-[12px]"
                  :class="paramInputCls" :style="paramInputStyle" placeholder="显示名称" />
              </div>
              <div>
                <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">模型 ID</label>
                <input v-model="newModel.id"
                  class="speech-param-input w-full h-8 px-2.5 text-[12px] font-mono"
                  :class="paramInputCls" :style="paramInputStyle"
                  :placeholder="selectedProviderId === 'aliyun_bailian_asr' ? '百炼模型 ID' : 'whisper-1'" />
              </div>
              <div>
                <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">是否开始流式</label>
                <div class="h-8 flex items-center">
                  <label class="mc-switch" :class="newModel.streaming ? 'on' : ''">
                    <input type="checkbox" :checked="newModel.streaming" @change="newModel.streaming = !newModel.streaming">
                    <span class="slider" :style="newModel.streaming ? { background: accentHex } : null" />
                  </label>
                </div>
              </div>
              <div>
                <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">时间戳</label>
                <div class="w-[200px] mc-select-wrap">
                  <SpeechOptionSelect v-model="newModel.timestamps" :options="timestampOptions" :is-dark="isDark" compact menu-min-width="200px" />
                </div>
              </div>
              <template v-if="selectedProviderId === 'aliyun_bailian_asr'">
                <div>
                  <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">是否开始分离</label>
                  <div class="h-8 flex items-center">
                    <label class="mc-switch" :class="newModel.diarization ? 'on' : ''">
                      <input type="checkbox" :checked="newModel.diarization" @change="newModel.diarization = !newModel.diarization">
                      <span class="slider" :style="newModel.diarization ? { background: accentHex } : null" />
                    </label>
                  </div>
                </div>
                <div>
                  <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">语言</label>
                  <div class="w-[200px] mc-select-wrap">
                    <SpeechOptionSelect v-model="newModel.language" :options="languageOptions" :is-dark="isDark" compact menu-min-width="220px" />
                  </div>
                </div>
              </template>
            </div>
          </div>

          <div class="modal-footer">
            <button class="secondary-button" :class="isDark ? 'secondary-button--dark' : 'secondary-button--light'" @click="showAddModel = false">取消</button>
            <button class="primary-button" @click="confirmAddModel"><i class="ri-add-line" />确认添加</button>
          </div>
        </div>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="showFetchModal" class="modal-overlay" @click.self="showFetchModal = false">
        <div class="modal-dialog" :class="isDark ? 'modal-dialog--dark' : 'modal-dialog--light'">
          <div class="modal-head">
            <h3 :class="isDark ? 'text-wt-main' : 'text-lt-main'">获取模型列表</h3>
            <button class="modal-close" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'" @click="showFetchModal = false"><i class="ri-close-line" /></button>
          </div>
          <div class="modal-body">
            <div class="space-y-3">
              <p class="text-[12px]" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">
                从 {{ selectedDefinition.name }} 获取到 {{ fetchedModels.length }} 个模型，选择要添加的模型：
              </p>
              <div class="relative">
                <i class="ri-search-line absolute left-2.5 top-[8px] text-[12px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'" />
                <input v-model="fetchSearchQuery" type="text" placeholder="搜索模型..."
                  class="w-full h-8 rounded-lg py-0 pl-7 pr-2 text-[12px] outline-none transition-colors"
                  :class="paramInputCls" :style="paramInputStyle" />
              </div>
              <div class="max-h-[300px] overflow-y-auto space-y-0.5">
                <div v-for="model in filteredFetchedModels" :key="model.id"
                  class="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors"
                  :class="existingModelIds.includes(model.id)
                    ? (isDark ? 'bg-white/4 text-wt-dim' : 'bg-l3/50 text-lt-aux')
                    : (fetchSelectedIds.includes(model.id)
                      ? (isDark ? 'bg-brand-400/8' : 'bg-brand-50')
                      : (isDark ? 'hover:bg-white/4' : 'hover:bg-l4'))"
                  @click="!existingModelIds.includes(model.id) && toggleFetchSelect(model.id)">
                  <div class="w-5 h-5 rounded-md border flex items-center justify-center shrink-0"
                    :class="existingModelIds.includes(model.id)
                      ? (isDark ? 'bg-d4 border-d4' : 'bg-l4 border-l4')
                      : (fetchSelectedIds.includes(model.id)
                        ? 'border-0'
                        : (isDark ? 'border-d4' : 'border-bdrF'))"
                    :style="fetchSelectedIds.includes(model.id) && !existingModelIds.includes(model.id) ? { background: accentHex, borderColor: accentHex } : null">
                    <i v-if="fetchSelectedIds.includes(model.id) && !existingModelIds.includes(model.id)" class="ri-check-line text-[12px] text-white" />
                    <i v-else-if="existingModelIds.includes(model.id)" class="ri-check-line text-[12px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'" />
                  </div>
                  <span class="flex-1 min-w-0 truncate text-[12px] font-mono" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">{{ model.id }}</span>
                  <span v-if="existingModelIds.includes(model.id)" class="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                    :class="isDark ? 'bg-d4 text-wt-dim' : 'bg-l4 text-lt-aux'">已添加</span>
                </div>
                <div v-if="filteredFetchedModels.length === 0" class="text-center py-6">
                  <span class="text-[12px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">无匹配模型</span>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <div class="flex-1 text-[11px]" :style="{ color: accentHex }">
              <span v-if="fetchSelectedIds.length > 0">已选择 {{ fetchSelectedIds.length }} 个模型</span>
            </div>
            <button class="secondary-button" :class="isDark ? 'secondary-button--dark' : 'secondary-button--light'" @click="showFetchModal = false">取消</button>
            <button class="primary-button" :disabled="fetchSelectedIds.length === 0" @click="confirmFetchAdd">
              <i class="ri-add-line text-[16px]"/>添加选中 ({{ fetchSelectedIds.length }})
            </button>
          </div>
        </div>
      </div>
    </Teleport>
</template>

<style scoped>
.speech-page { container-type: inline-size; --speech-control-height: 36px; --speech-control-font-size: 0.9rem; --speech-field-label-height: 16px; width: 100%; padding: clamp(12px, 2vw, 24px); overflow: hidden; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.speech-intro { flex: none; padding: 10px 12px; border: 1px solid; border-radius: 12px; display: flex; align-items: center; gap: 10px; }
.speech-intro--dark { background: rgba(var(--brand-rgb),.065); border-color: rgba(var(--brand-rgb),.22); }
.speech-intro--light { background: rgba(var(--brand-rgb),.055); border-color: rgba(var(--brand-rgb),.18); }
.speech-intro__icon { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; color: var(--brand); background: rgba(var(--brand-rgb),.12); font-size: 16px; flex: none; }
.speech-intro h2 { margin: 0; font-size: 14px; font-weight: 700; }
.speech-intro p { margin: 3px 0 0; font-size: 10.8px; line-height: 1.5; }
.speech-count, .available-badge, .future-badge, .default-pill, .future-label { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 10px; font-weight: 650; }
.speech-count, .available-badge { color: #10B981; background: rgba(16,185,129,.1); }
.default-pill { color: var(--brand); background: rgba(var(--brand-rgb),.1); }
.future-badge, .future-label { color: #D97706; background: rgba(245,158,11,.1); }
.ghost-button, .secondary-button, .primary-button { height: 32px; padding: 0 12px; border-radius: 6px; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; transition: 150ms ease; }
.ghost-button--dark, .secondary-button--dark { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); color: rgba(255,255,255,.72); }
.ghost-button--light, .secondary-button--light { background: #fff; border: 1px solid rgba(18,28,45,.1); color: #475569; }
.ghost-button:hover, .secondary-button:hover { color: var(--brand); border-color: rgba(var(--brand-rgb),.34); background: rgba(var(--brand-rgb),.07); }
.ghost-button:focus-visible, .secondary-button:focus-visible, .primary-button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(var(--brand-rgb),.14); }
.refresh-button { width: 32px; height: 32px; background-color: transparent !important; border: none; min-height: 32px; padding: 0; justify-content: center; flex: none; }
.refresh-button i { font-size: 18px; }
.refresh-icon { transform: rotate(0deg); transform-origin: center; }
.refresh-icon--spinning { animation: speech-refresh-spin 600ms linear infinite; will-change: transform; }
@keyframes speech-refresh-spin { to { transform: rotate(360deg); } }
.capability-tabs { flex: none; border: 1px solid; border-radius: 6px; padding: 3px; display: grid; grid-template-columns: 1fr 1fr; gap: 3px; }
.capability-tabs--dark { background: rgba(255,255,255,.025); border-color: rgba(255,255,255,.08); color: rgba(255,255,255,.76); }
.capability-tabs--light { background: rgba(18,28,45,.025); border-color: rgba(18,28,45,.08); color: #334155; }
.capability-tabs button { min-height: 38px; border-radius: 6px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 12px; color: inherit; opacity: .62; }
.capability-tabs button.active { background: var(--brand); color: #fff; opacity: 1; box-shadow: 0 3px 12px rgba(var(--brand-rgb),.18); }
.capability-tabs button.active .available-badge, .capability-tabs button.active .future-badge { color: inherit; background: rgba(255,255,255,.16); }
 .speech-layout { display: grid; grid-template-columns: minmax(248px, 276px) minmax(0,1fr); grid-template-rows: minmax(0, 1fr); gap: 14px; flex: 1; min-height: 0; overflow: hidden; }
.panel-dark, .panel-light { border: 1px solid; border-radius: 12px; }
.panel-dark { background: rgba(255,255,255,.025); border-color: rgba(255,255,255,.08); color: rgba(255,255,255,.76); }
.panel-light { background: rgba(255,255,255,.72); border-color: rgba(18,28,45,.085); color: #334155; }
.provider-rail { padding: 12px; overflow-y: auto; min-height: 0; }
.rail-heading { padding: 3px 3px 11px; }
.rail-heading span { display: block; font-size: 12px; font-weight: 700; }
.rail-heading small { display: block; margin-top: 4px; font-size: 10px; line-height: 1.5; }
.provider-card { width: 100%; min-height: 56px; padding: 8px 9px; border: 1px solid transparent; border-radius: 10px; display: flex; align-items: center; gap: 9px; text-align: left; color: inherit; transition: 150ms ease; position: relative; }
.provider-card + .provider-card { margin-top: 6px; }
.provider-card--dark:hover { background: rgba(255,255,255,.035); }
.provider-card--light:hover { background: rgba(18,28,45,.03); }
.provider-card--active { border-color: rgba(var(--brand-rgb),.34); background: rgba(var(--brand-rgb),.08) !important; box-shadow: inset 3px 0 0 var(--brand); }
.provider-card:focus-visible { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(var(--brand-rgb),.12); }
.provider-card__icon, .config-provider-icon { width: 38px; height: 38px; border: 1px solid rgba(128,140,160,.13); border-radius: 10px; display: grid; place-items: center; background: rgba(128,140,160,.055); flex: none; overflow: hidden; }
.config-provider-icon { width: 42px; height: 42px; border-radius: 12px; }
.config-header > .config-provider-icon { background: none !important;;  border: none;}
.provider-card__copy { min-width: 0; flex: 1; padding-right: 46px; }
.provider-card__name { display: flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 700; }
.default-star { color: #F59E0B; font-size: 11px; }
.provider-state { position: absolute; top: 50%; right: 9px; transform: translateY(-50%); font-size: 9px; opacity: .55; }
.provider-state--ready { color: #10B981; opacity: 1; }
.provider-state--warn { color: #F59E0B; opacity: 1; }
.config-panel { overflow: hidden; position: relative; display: flex; flex-direction: column; min-height: 0; }
.config-header { min-height: 72px; padding: 14px 16px; display: flex; align-items: center; gap: 11px; border-bottom: 1px solid rgba(128,140,160,.12); flex: none; }
.config-header h3 { margin: 0; font-size: 14px; font-weight: 700; }
.config-header p { margin: 4px 0 0; font-size: 10.5px; line-height: 1.5; }
.switch-control { width: 42px; height: 24px; border-radius: 999px; padding: 3px; background: rgba(128,140,160,.28); transition: background-color 160ms ease, box-shadow 160ms ease; flex: none; }
.switch-control span { display: block; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.22); transition: transform 160ms ease; }
.switch-control:hover { background: rgba(128,140,160,.38); }
.switch-control.on { background: var(--brand); }
.switch-control.on:hover { background: var(--brand-hover); }
.switch-control.on span { transform: translateX(18px); }
.switch-control:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(var(--brand-rgb),.14); }
.model-card { transition: border-color 150ms ease, background 150ms ease; }
.model-card--light { background: rgba(var(--brand-rgb), 0.03); border-color: rgba(var(--brand-rgb), 0.2); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.model-card--light:hover { background: rgba(var(--brand-rgb), 0.05); border-color: rgba(var(--brand-rgb), 0.32); }
.model-card--dark { background: rgba(255,255,255, 0.03); border-color: rgba(var(--brand-rgb), 0.15); box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
.model-card--dark:hover { background: rgba(255,255,255, 0.045); border-color: rgba(var(--brand-rgb), 0.28); }
.model-card--default { border-color: rgba(var(--brand-rgb), 0.3) !important; box-shadow: inset 3px 0 0 var(--brand), 0 1px 3px rgba(var(--brand-rgb), 0.08); }
.config-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; flex: 1; overflow-y: auto; min-height: 0; }
.config-body--aliyun { padding: 14px 16px; gap: 10px; }
.config-body--aliyun .field-grid { gap: 10px; }
.config-body--aliyun .provider-note { padding: 8px 10px; }
.config-body--disabled { opacity: .48; pointer-events: none; }
.field-grid { display: grid; gap: 12px; align-items: start; }
.field-grid.two-col { grid-template-columns: repeat(2,minmax(0,1fr)); }
.field-block { display: grid; gap: 6px; }
.field-grid.two-col > .field-block { grid-template-rows: var(--speech-field-label-height) var(--speech-control-height) auto; align-content: start; }
.field-grid.two-col > .aliyun-capability-field { grid-template-rows: var(--speech-field-label-height) auto; }
.field-block > span { min-height: var(--speech-field-label-height); font-size: 10.5px; font-weight: 650; line-height: var(--speech-field-label-height); }
.field-block em { font-style: normal; font-weight: 400; opacity: .55; }
.field-block small { font-size: 9.6px; line-height: 1.45; opacity: .58; }
.field-block input { width: 100%; height: var(--speech-control-height); min-height: var(--speech-control-height); padding: 0 11px; border-radius: 4px; border: 1px solid rgba(128,140,160,.2); background: rgba(128,140,160,.045); color: inherit; font-size: var(--speech-control-font-size); outline: none; transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease; }
.field-block input:hover { border-color: rgba(var(--brand-rgb),.34); }
.field-block input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(var(--brand-rgb),.11); background: rgba(var(--brand-rgb),.025); }
.field-block input::placeholder { color: rgba(128,140,160,.72); }
.custom-model-field { padding: 11px 12px; border: 1px solid rgba(var(--brand-rgb),.2); border-radius: 10px; background: rgba(var(--brand-rgb),.045); }
.custom-model-field > span em { margin-left: 5px; padding: 2px 6px; border-radius: 5px; color: #D97706; background: rgba(245,158,11,.11); opacity: 1; font-size: 8.5px; font-weight: 650; }
.speech-param-input:focus { border-color: var(--brand) !important; box-shadow: 0 0 0 3px rgba(var(--brand-rgb),.12); }
.input-with-icon { position: relative; }
.input-with-icon i { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); opacity: .5; }
.input-with-icon input { padding-left: 32px; }
.secret-input { display: flex; height: var(--speech-control-height); min-height: var(--speech-control-height); border: 1px solid rgba(128,140,160,.2); background: rgba(128,140,160,.045); border-radius: 8px; overflow: hidden; transition: border-color 160ms ease, box-shadow 160ms ease; }
.secret-input:hover { border-color: rgba(var(--brand-rgb),.34); }
.secret-input:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(var(--brand-rgb),.11); }
.secret-input input { height: 100%; flex: 1; min-width: 0; border: 0; background: transparent; box-shadow: none; }
.secret-input button { width: 40px; opacity: .55; transition: color 150ms ease, background-color 150ms ease, opacity 150ms ease; }
.secret-input button:hover { color: var(--brand); background: rgba(var(--brand-rgb),.08); opacity: 1; }
.secret-input button:focus-visible { outline: none; color: var(--brand); background: rgba(var(--brand-rgb),.08); }
.option-toggle-group { height: var(--speech-control-height); min-height: var(--speech-control-height); display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 6px; }
.check-control { min-width: 0; height: var(--speech-control-height); min-height: var(--speech-control-height); padding: 3px 7px; border: 1px solid rgba(128,140,160,.16); border-radius: 8px; display: flex; align-items: center; gap: 7px; text-align: left; color: inherit; background: rgba(128,140,160,.035); transition: border-color 150ms ease, background-color 150ms ease, box-shadow 150ms ease; }
.check-control:hover { border-color: rgba(var(--brand-rgb),.34); background: rgba(var(--brand-rgb),.045); }
.check-control.checked { border-color: rgba(var(--brand-rgb),.38); background: rgba(var(--brand-rgb),.075); }
.check-control.disabled { cursor: not-allowed; opacity: .48; border-color: rgba(128,140,160,.12); background: rgba(128,140,160,.025); }
.check-control.disabled:hover { border-color: rgba(128,140,160,.12); background: rgba(128,140,160,.025); }
.check-control:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(var(--brand-rgb),.12); }
.check-control__box { width: 18px; height: 18px; flex: none; border: 1px solid rgba(128,140,160,.3); border-radius: 5px; display: grid; place-items: center; color: transparent; background: rgba(128,140,160,.06); font-size: 11px; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease; }
.check-control.checked .check-control__box { color: #fff; border-color: var(--brand); background: var(--brand); }
.check-control strong, .check-control small { display: block; }
.check-control > span:last-child { min-width: 0; }
.check-control strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 680; }
.check-control small { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 8.2px; line-height: 1.05; opacity: .56; }
.provider-note { padding: 10px 12px; border-radius: 10px; display: flex; gap: 8px; background: rgba(245,158,11,.075); color: #D97706; font-size: 10px; line-height: 1.5; }
.provider-note--brand { color: var(--brand); background: rgba(var(--brand-rgb),.075); }
.config-footer { min-height: 64px; padding: 12px 16px; border-top: 1px solid rgba(128,140,160,.12); display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: none; }
.config-footer__status { min-width: 0; flex: 1; }
.config-footer__actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.config-footer strong, .config-footer small { display: block; font-size: 9.8px; }
.config-footer small { margin-top: 3px; }
.check-result--success { color: #10B981; }
.check-result--error { color: #EF4444; }
.primary-button { color: #fff; border: 0; background: var(--brand); }
.primary-button:not(:disabled):hover { background: var(--brand-hover); transform: translateY(-1px); box-shadow: 0 5px 14px rgba(var(--brand-rgb),.2); }
.primary-button:not(:disabled):active { transform: translateY(0); box-shadow: none; }
.primary-button:disabled { opacity: .45; cursor: not-allowed; }
.tts-future { min-height: 430px; padding: 52px 28px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.tts-future__mark { width: 64px; height: 64px; border-radius: 18px; display: grid; place-items: center; background: rgba(245,158,11,.1); color: #F59E0B; font-size: 28px; margin-bottom: 16px; }
.tts-future h3 { margin: 14px 0 0; font-size: 18px; font-weight: 700; }

@media (min-width: 1081px) {
  .provider-rail { border-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
}
@media (max-width: 1080px) {
  .speech-layout { grid-template-columns: minmax(0,1fr); align-items: start; }
  .provider-rail { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; }
  .rail-heading { grid-column: 1 / -1; }
  .provider-card + .provider-card { margin-top: 0; }
  .provider-card__copy { padding-right: 0; }
  .provider-state { display: none; }
}
@media (max-width: 820px) {
  .speech-page { padding: 14px; }
  .speech-intro { align-items: flex-start; }
  .speech-intro .refresh-button { margin-left: auto; }
  .config-footer { align-items: flex-start; flex-direction: column; }
  .config-footer__actions { width: 100%; }
  .config-footer__actions > button { min-height: 40px; }
}
@media (max-width: 680px) {
  .speech-page { --speech-control-height: 44px; padding: 10px; }
  .speech-intro { padding: 10px; }
  .speech-intro .refresh-button { width: 34px; height: 34px; min-height: 34px; margin-left: 0; }
  .capability-tabs button { min-height: 44px; padding: 0 8px; }
  .provider-rail, .field-grid.two-col, .tts-placeholder-grid, .option-toggle-group { grid-template-columns: minmax(0,1fr); }
  .provider-card { min-height: 56px; }
  .config-header { padding: 12px; }
  .config-body { padding: 12px; }
  .option-toggle-group { height: auto; min-height: 0; }
  .config-footer { padding: 12px; }
  .config-footer__actions > button { flex: 1 1 140px; justify-content: center; }
  .tts-future { min-height: 360px; padding: 36px 16px; }
}
@media (max-width: 420px) {
  .speech-page { padding: 8px; }
  .speech-count { display: none; }
  .capability-tabs button { gap: 5px; font-size: 11px; }
  .available-badge, .future-badge { display: none; }
  .config-provider-icon { width: 38px; height: 38px; }
  .config-header p { max-width: 210px; }
  .config-footer__actions { display: grid; grid-template-columns: minmax(0,1fr); }
  .config-footer__actions > button { width: 100%; min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) { .ghost-button, .secondary-button, .primary-button, .provider-card, .switch-control, .switch-control span, .field-block input, .secret-input, .check-control, .check-control__box { transition: none; } .refresh-icon--spinning { animation: none; } }

/* ── Model Cards ── */
.mc-switch { position: relative; width: 32px; height: 18px; display: inline-block; flex: none; }
.mc-switch input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; position: absolute; inset: 0; }
.mc-switch .slider { position: absolute; inset: 0; background: var(--ui-bg-4); border-radius: 20px; transition: background-color .15s; }
.mc-switch .slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; background: #fff; border-radius: 50%; transition: transform .15s; }
.mc-switch input:checked + .slider::before { transform: translateX(14px); }

/* SpeechOptionSelect height override inside mc-select-wrap */
.mc-select-wrap .speech-select { width: 100% !important; }
.mc-select-wrap .speech-select__trigger { width: 100% !important; height: 32px !important; min-height: 32px !important; }
.mc-select-wrap .speech-select--compact .speech-select__trigger { padding-top: 2px; padding-bottom: 2px; }

/* ── Modal ── */
.modal-overlay { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; background: rgba(0,0,0,.4); backdrop-filter: blur(2px); }
.modal-dialog { width: min(480px, 92vw); max-height: 80vh; overflow-y: auto; border-radius: 14px; border: 1px solid rgba(128,140,160,.15); box-shadow: 0 20px 60px rgba(0,0,0,.3); }
.modal-dialog--dark { background: #1a1a2e; border-color: rgba(255,255,255,.1); color: rgba(255,255,255,.85); }
.modal-dialog--light { background: #fff; color: #1a1a2e; }
.modal-head { padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(128,140,160,.1); }
.modal-head h3 { margin: 0; font-size: 14px; font-weight: 700; }
.modal-close { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; cursor: pointer; font-size: 18px; opacity: .5; }
.modal-close:hover { background: rgba(128,140,160,.1); opacity: 1; }
.modal-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.modal-footer { padding: 12px 18px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid rgba(128,140,160,.1); }


@media (prefers-reduced-motion: reduce) { .mc-switch .slider, .mc-switch .slider::before { transition: none; } }

/* 响应式：窄屏时堆叠布局，服务商列表限高+滚动 */
@container (max-width: 680px) {
  .speech-layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }
  .provider-rail {
    max-height: 180px;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .field-grid.two-col {
    grid-template-columns: 1fr;
  }
  .field-grid.two-col > .field-block {
    grid-template-rows: var(--speech-field-label-height) var(--speech-control-height) auto;
  }
  .speech-intro { flex-wrap: wrap; }
  .speech-intro p { font-size: 10px; }
  .config-header { min-height: 56px; padding: 10px 12px; }
  .config-body { padding: 12px; gap: 10px; }
}

/* 极窄屏：进一步压缩间距 */
@container (max-width: 480px) {
  .speech-page { padding: 8px; }
  .speech-layout { gap: 8px; }
  .provider-rail { max-height: 140px; padding: 8px; }
  .config-header h3 { font-size: 13px; }
  .config-body { padding: 10px; gap: 8px; }
}

/* Narrow widths: switch to natural document flow so the whole page scrolls
   instead of clipping inside fixed-height internal scroll areas.
   Overrides the viewport-fit / internal-scroll rules above for <=820px. */
@container (max-width: 820px) {
  .speech-page { height: auto; min-height: 100%; overflow: visible; }
  .speech-layout { flex: none; min-height: 0; overflow: visible; grid-template-columns: minmax(0,1fr); grid-template-rows: none; }
  .provider-rail { overflow: visible; max-height: none; }
  .config-panel { overflow: visible; }
 .config-body { overflow: visible; flex: none; }
}

/* Collapse the name/id 2-column grid on very narrow widths. */
@container (max-width: 520px) {
  .model-fields-2col { grid-template-columns: minmax(0,1fr) !important; }
}
</style>
