import { parseModelRef } from './modelRef.js'

// 从服务商配置 + 默认模型引用，解析出实际使用的模型，并拍平成可直接读取的 provider config。
//
// 选择规则：优先 defaultModelRef 指向的、属于该服务商且启用的模型；否则取该服务商第一个启用模型。
// 拍平后带上 model / language / enableDiarization / customParams，供 AliyunBailianAsrProvider、
// OpenAiWhisperProvider 等直接读取（它们读的是顶层 config.model，而不是 models[] 卡片）。
//
// @param {object} provider 服务商表单（含 models[]）
// @param {string} defaultModelRef 形如 "aliyun_bailian_asr::paraformer-v2"
// @param {string} providerId 当前服务商 id
// @returns {object} 拍平后的 provider config；解析不到模型时返回原始字段，交由 provider 抛“缺少模型”
export function resolveProviderModelConfig(provider, defaultModelRef = '', providerId = '') {
  const base = provider && typeof provider === 'object' ? provider : {}
  const models = Array.isArray(base.models) ? base.models : []
  const ref = parseModelRef(defaultModelRef)
  const preferredId = ref.scoped && ref.providerId === providerId ? ref.modelId : ''
  const preferred = preferredId ? models.find(m => m.id === preferredId && m.enabled) : null
  const model = preferred || models.find(m => m.enabled) || null
  if (!model) return { ...base }
  const caps = model.capabilities && typeof model.capabilities === 'object' ? model.capabilities : {}
  return {
    ...base,
    model: model.id,
    language: model.language || base.language || 'auto',
    enableDiarization: Boolean(caps.diarization),
    customParams: { ...(model.customParams || {}) },
  }
}
