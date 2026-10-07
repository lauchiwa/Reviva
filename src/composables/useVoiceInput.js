/**
 * 语音输入组合式函数
 * 管理录音状态 + 语音转录（流式/非流式自动选择）
 */

import { ref, computed, onBeforeUnmount } from 'vue'
import { useMediaStore } from '@/stores/media'
import {
  startRecording,
  stopRecording,
  cancelRecording,
  startStreamingRecording,
  stopStreamingRecording,
  cancelStreamingRecording,
} from '@/utils/audioRecorder'
import { createRealtimeSession } from '@/utils/realtimeASRService'
import { getAliyunAsrModelCapability } from '@/constants/aliyunAsrModels'

const STORAGE_KEY = 'voiceInput.selectedModelRef'

export function useVoiceInput() {
  const mediaStore = useMediaStore()

  const status = ref('idle') // idle | recording | transcribing | error
  const errorMsg = ref('')
  const duration = ref(0)
  const audioLevel = ref(0)
  const partialText = ref('')
  const selectedModelRef = ref(localStorage.getItem(STORAGE_KEY) || '')

  let timerId = null
  let cancelFn = null
  let realtimeSession = null

  // 麦克风短音频输入：百炼的异步录音文件模型只接受公网 URL，无法用于麦克风，从语音输入候选里排除。
  function isModelMicSuitable(m) {
    if (!m) return false
    if (m.providerId === 'aliyun_bailian_asr') {
      const cap = getAliyunAsrModelCapability(m.modelId)
      if (cap) return cap.inputModes.includes('local_file') || cap.inputModes.includes('realtime_stream')
      return false // 未知百炼模型按异步文件处理
    }
    return true // 本地 / OpenAI 兼容 / 硅基流动均支持文件上传
  }

  const availableModels = computed(() => mediaStore.configuredModels.filter(isModelMicSuitable))
  const hasModels = computed(() => availableModels.value.length > 0)

  const selectedModel = computed(() => {
    if (selectedModelRef.value) {
      const found = availableModels.value.find(m => m.ref === selectedModelRef.value)
      if (found) return found
    }
    // 默认模型若不适合麦克风输入（如百炼异步文件模型），退回到第一个可用模型
    const def = mediaStore.defaultModel
    if (def && isModelMicSuitable(def)) return def
    return availableModels.value[0] || def || null
  })

  const isStreamingModel = computed(() => selectedModel.value?.streaming === true)
  const isRealtimeModel = computed(() => selectedModel.value?.realtime === true)

  function selectModel(ref) {
    selectedModelRef.value = ref
    try { localStorage.setItem(STORAGE_KEY, ref) } catch { /* ignore */ }
  }

  function buildRealtimeConfig() {
    const model = selectedModel.value
    if (!model) return null
    const provider = mediaStore.speechSettings.providers[model.providerId]
    if (!provider) return null
    if (model.providerId === 'aliyun_bailian_asr') {
      return {
        workspaceId: provider.workspaceId || '',
        apiKey: provider.apiKey || '',
        model: model.modelId,
        format: 'pcm',
        sampleRate: 16000,
        language: 'auto',
      }
    }
    return null
  }

  async function ensureSettingsLoaded() {
    if (!mediaStore.speechSettingsLoaded) {
      await mediaStore.loadSpeechSettings()
    }
  }

  async function start() {
    if (status.value !== 'idle' && status.value !== 'error') return false

    await ensureSettingsLoaded()

    if (!hasModels.value) {
      errorMsg.value = '未配置可用的语音模型，请先在设置中启用'
      status.value = 'error'
      return false
    }

    errorMsg.value = ''
    status.value = 'recording'
    duration.value = 0
    partialText.value = ''
    audioLevel.value = 0

    try {
      if (isRealtimeModel.value) {
        const rtConfig = buildRealtimeConfig()
        if (!rtConfig) {
          errorMsg.value = 'Realtime ASR not configured for this model'
          status.value = 'error'
          return false
        }
        let sendAudioFn = null
        const { sampleRate } = await startStreamingRecording(
          (arrayBuffer) => { sendAudioFn?.(arrayBuffer) },
          (level) => { audioLevel.value = level }
        )
        rtConfig.sampleRate = sampleRate
        realtimeSession = createRealtimeSession(rtConfig, {
          onPartial: (_delta, full) => { partialText.value = full },
          onComplete: (full) => { partialText.value = full },
          onError: (e) => { errorMsg.value = e?.message || 'Realtime ASR error' },
        })
        await realtimeSession.start()
        sendAudioFn = (arrayBuffer) => { realtimeSession?.sendAudio(arrayBuffer) }
      } else {
        await startRecording((level) => {
          audioLevel.value = level
        })
      }
      timerId = setInterval(() => {
        duration.value++
      }, 1000)
      return true
    } catch (e) {
      errorMsg.value = e?.name === 'NotAllowedError'
        ? '麦克风访问被拒绝，请在系统设置中允许'
        : (e?.message || '无法访问麦克风')
      status.value = 'error'
      if (isRealtimeModel.value) {
        cancelStreamingRecording()
        if (realtimeSession) {
          realtimeSession.stop().catch(() => {})
          realtimeSession.cleanup()
          realtimeSession = null
        }
      } else {
        cancelRecording()
      }
      return false
    }
  }

  async function stop() {
    if (status.value !== 'recording') return ''

    if (timerId) {
      clearInterval(timerId)
      timerId = null
    }

    if (isRealtimeModel.value && realtimeSession) {
      status.value = 'transcribing'
      audioLevel.value = 0
      try {
        stopStreamingRecording()
        await realtimeSession.stop()
        const finalText = partialText.value
        realtimeSession.cleanup()
        realtimeSession = null
        partialText.value = ''
        status.value = 'idle'
        return (finalText || '').trim()
      } catch (e) {
        errorMsg.value = e?.message || 'Realtime ASR error'
        status.value = 'error'
        return ''
      } finally {
        cancelFn = null
      }
    }

    status.value = 'transcribing'
    audioLevel.value = 0

    try {
      const { blob, audioFormat } = await stopRecording()
      if (!blob) {
        status.value = 'idle'
        return ''
      }

      const modelRef = selectedModelRef.value || undefined

      // 走主进程转录：渲染进程直连百炼/OpenAI 兼容接口会触发 CORS，且百炼不同模型走不同协议。
      const api = window.electronAPI?.media
      if (!api?.transcribeAudio) {
        throw new Error('语音识别服务不可用（需要桌面端环境）')
      }
      const arrayBuffer = await blob.arrayBuffer()
      const result = await api.transcribeAudio(arrayBuffer, { ref: modelRef, audioFormat })
      if (!result?.success) {
        throw new Error(result?.message || '语音识别失败')
      }
      const finalText = result.text || ''

      partialText.value = ''
      status.value = 'idle'
      return (finalText || '').trim()
    } catch (e) {
      errorMsg.value = e?.message || '语音识别失败'
      status.value = 'error'
      return ''
    } finally {
      cancelFn = null
    }
  }

  function cancel() {
    if (timerId) {
      clearInterval(timerId)
      timerId = null
    }
    if (cancelFn) {
      cancelFn()
      cancelFn = null
    }
    if (realtimeSession) {
      realtimeSession.stop().catch(() => {})
      realtimeSession.cleanup()
      realtimeSession = null
    }
    cancelStreamingRecording()
    cancelRecording()
    status.value = 'idle'
    partialText.value = ''
    audioLevel.value = 0
    errorMsg.value = ''
  }

  function resetError() {
    if (status.value === 'error') {
      status.value = 'idle'
      errorMsg.value = ''
    }
  }

  onBeforeUnmount(() => cancel())

  function formatDuration() {
    const m = Math.floor(duration.value / 60)
    const s = duration.value % 60
    return m + ':' + String(s).padStart(2, '0')
  }

  return {
    status,
    errorMsg,
    duration,
    audioLevel,
    partialText,
    selectedModelRef,
    availableModels,
    hasModels,
    selectedModel,
    isStreamingModel,
    isRealtimeModel,
    start,
    stop,
    cancel,
    selectModel,
    resetError,
    formatDuration,
  }
}
