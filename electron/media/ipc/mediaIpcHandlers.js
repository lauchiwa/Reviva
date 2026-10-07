import { MEDIA_ERROR_CODES, MediaError, normalizeMediaError } from '../core/MediaErrors.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveProviderModelConfig } from '../../../src/utils/speechModelResolver.js'

function publicError(error) {
  return (error instanceof MediaError ? error : normalizeMediaError(error)).toPublicResult()
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MediaError(MEDIA_ERROR_CODES.INVALID_ARGUMENT, `${label} 必须是对象。`)
  }
  return value
}

function requireId(value, label) {
  const id = String(value || '').trim()
  if (!id || !/^[a-z0-9_]+$/i.test(id)) throw new MediaError(MEDIA_ERROR_CODES.INVALID_ARGUMENT, `${label} 无效。`)
  return id
}

export function registerMediaIpcHandlers(ipcMain, mediaModule) {
  if (!ipcMain?.handle || !mediaModule?.ingestion || !mediaModule?.query) return false
  const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args)
    } catch (error) {
      return publicError(error)
    }
  })

  handle('media:register', async (sourceInput = {}) => ({
    success: true,
    ...(await mediaModule.ingestion.registerSource(requireObject(sourceInput, 'sourceInput'))),
  }))
  handle('media:registerAndAnalyze', async (sourceInput = {}, options = {}) => ({
    success: true,
    ...(await mediaModule.ingestion.registerAndAnalyze(
      requireObject(sourceInput, 'sourceInput'),
      requireObject(options, 'options'),
    )),
  }))
  handle('media:resolveOwner', async (owner = {}) => {
    const input = requireObject(owner, 'owner')
    const link = mediaModule.repositories?.media?.findActiveMediaSourceLink?.({
      ownerType: String(input.type || ''),
      ownerId: String(input.id || ''),
      ownerLocator: String(input.locator || ''),
      pathPlatform: input.pathPlatform,
    })
    if (!link) return { success: true, found: false }
    const source = mediaModule.repositories.media.getMediaSource(link.media_id)
    if (!source) return { success: true, found: false }
    return {
      success: true,
      found: true,
      link: { id: link.id, ownerType: link.owner_type, ownerId: link.owner_id, ownerLocator: link.owner_locator },
      source: {
        id: source.id,
        mediaType: source.media_type || '',
        title: source.title || source.file_name || '',
        fileName: source.file_name || '',
        contentAvailability: source.content_availability || 'none',
      },
    }
  })
  handle('media:attachOwner', async (mediaId, owner = {}) => {
    const normalizedMediaId = requireId(mediaId, 'mediaId')
    const input = requireObject(owner, 'owner')
    const source = mediaModule.repositories?.media?.getMediaSource?.(normalizedMediaId)
    if (!source) throw new MediaError(MEDIA_ERROR_CODES.SOURCE_NOT_FOUND, '媒体来源不存在。')
    const link = mediaModule.repositories.media.upsertMediaSourceLink({
      mediaId: normalizedMediaId,
      ownerType: String(input.type || ''),
      ownerId: String(input.id || ''),
      ownerLocator: String(input.locator || ''),
      pathPlatform: input.pathPlatform,
    })
    return {
      success: true,
      link: { id: link.id, ownerType: link.owner_type, ownerId: link.owner_id, ownerLocator: link.owner_locator },
    }
  })
  handle('media:analyze', async (mediaId, options = {}) => ({
    success: true,
    run: mediaModule.ingestion.reanalyze(requireId(mediaId, 'mediaId'), requireObject(options, 'options')),
  }))
  handle('media:cancel', async (runId) => {
    const run = mediaModule.ingestion.cancelRun(requireId(runId, 'runId'))
    if (!run) throw new MediaError(MEDIA_ERROR_CODES.RUN_NOT_FOUND, '媒体解析任务不存在。')
    return { success: true, run }
  })
  handle('media:getRun', async (runId) => {
    const run = mediaModule.ingestion.getRunStatus(requireId(runId, 'runId'))
    if (!run) throw new MediaError(MEDIA_ERROR_CODES.RUN_NOT_FOUND, '媒体解析任务不存在。')
    return { success: true, run }
  })
  handle('media:query', async (request = {}) => mediaModule.query.query(requireObject(request, 'request'), { trustedInternal: true }))
  handle('media:history', async (mediaId, options = {}) => mediaModule.query.history(
    requireId(mediaId, 'mediaId'),
    requireObject(options, 'options'),
    { trustedInternal: true },
  ))
  handle('media:restoreRun', async (mediaId, runId) => ({
    success: true,
    ...(await mediaModule.artifacts.restoreRun(requireId(mediaId, 'mediaId'), requireId(runId, 'runId'))),
  }))
  handle('media:exportTranscript', async (mediaId, options = {}) => mediaModule.query.exportTranscript(
    requireId(mediaId, 'mediaId'),
    requireObject(options, 'options'),
    { trustedInternal: true },
  ))
  handle('media:readFrame', async (mediaId, frameId, options = {}) => mediaModule.artifacts.readFrameAsset(
    requireId(mediaId, 'mediaId'),
    requireId(frameId, 'frameId'),
    requireObject(options, 'options'),
  ))
  handle('media:checkSpeechProvider', async (providerId, config = {}) => mediaModule.speechToText.check(
    requireId(providerId, 'providerId'),
    requireObject(config, 'config'),
  ))
  handle('media:fetchSpeechModels', async (providerId, config = {}) => mediaModule.speechToText.listModels(
    requireId(providerId, 'providerId'),
    requireObject(config, 'config'),
  ))
  // 语音输入（麦克风短音频）转录：必须走主进程，避免渲染进程直连百炼/OpenAI 兼容接口触发 CORS，
  // 同时复用各 provider 的正确协议（百炼 async/qwen-flash/fun-asr-flash/realtime）。
  handle('media:transcribeAudio', async (arrayBuffer, options = {}) => {
    const data = arrayBuffer && arrayBuffer.byteLength != null ? arrayBuffer : null
    if (!data || !data.byteLength) {
      throw new MediaError(MEDIA_ERROR_CODES.INVALID_ARGUMENT, '语音音频数据为空。', { stage: 'stt' })
    }
    const settings = mediaModule.dependencies?.database?.getSetting?.('mediaSpeechSettings') || {}
    const ref = String(options?.ref || settings?.defaultModelRef || '')
    const idx = ref.indexOf('::')
    const providerId = idx > 0 ? ref.slice(0, idx) : ref
    const providers = settings?.providers && typeof settings.providers === 'object' ? settings.providers : {}
    const provider = providers[providerId]
    if (!provider?.enabled) {
      throw new MediaError(MEDIA_ERROR_CODES.STT_NOT_CONFIGURED, '所选语音识别服务未启用，请在设置中启用。', { stage: 'stt', provider: providerId })
    }
    const config = resolveProviderModelConfig(provider, ref, providerId)
    const providerImpl = mediaModule.speechToText?.get(providerId)
    if (!providerImpl) {
      throw new MediaError(MEDIA_ERROR_CODES.STT_PROVIDER_UNAVAILABLE, '未找到语音转文字服务商。', { stage: 'stt', provider: providerId })
    }
    const audioFormat = String(options?.audioFormat || 'wav').toLowerCase() || 'wav'
    const tmpPath = path.join(os.tmpdir(), `voice-input-${Date.now()}.${audioFormat}`)
    await fs.promises.writeFile(tmpPath, Buffer.from(data))
    try {
      const result = await providerImpl.transcribe({
        mode: 'local_file',
        localPath: tmpPath,
        language: String(options?.language || config.language || 'auto'),
        sizeBytes: data.byteLength,
        durationMs: 0,
      }, config, {})
      return {
        success: true,
        text: String(result?.text || ''),
        segments: Array.isArray(result?.segments) ? result.segments : [],
        model: result?.model || config.model || '',
        language: result?.language || '',
      }
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {})
    }
  })
  handle('media:getBilibiliCookieStatus', async () => ({
    success: true,
    status: mediaModule.bilibili.cookies.getStatus(),
    cookie: mediaModule.bilibili.cookies.getCookie({ includeInvalid: true }),
  }))
  handle('media:saveBilibiliCookie', async (cookie) => {
    mediaModule.bilibili.cookies.assertStorageAvailable()
    const profile = await mediaModule.bilibili.client.validateCookie(String(cookie || ''))
    return {
      success: true,
      status: mediaModule.bilibili.cookies.save(cookie, profile),
    }
  })
  return true
}
