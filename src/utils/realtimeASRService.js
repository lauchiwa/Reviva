/**
 * Renderer-side realtime ASR session manager.
 * Wraps IPC calls to the main-process WebSocket bridge (electron/RealtimeASRService.js).
 *
 * Usage:
 *   const session = createRealtimeSession(config, {
 *     onPartial: (delta, fullText, isFinal) => updateUI(fullText),
 *     onComplete: (fullText) => done(fullText),
 *     onError: (e) => console.error(e),
 *   })
 *   await session.start()
 *   session.sendAudio(pcmChunk)
 *   await session.stop()
 *   session.cleanup()
 */

export function createRealtimeSession(config, callbacks) {
  const { onPartial, onComplete, onError } = callbacks

  const api = window.electronAPI?.realtimeASR
  if (!api) {
    throw new Error('Realtime ASR API not available (requires Electron preload)')
  }

  let finalizedText = ''
  let currentSentence = ''

  api.onStarted(() => {})

  api.onPartial(({ text, isFinal }) => {
    if (isFinal) {
      finalizedText += text
      currentSentence = ''
    } else {
      currentSentence = text
    }
    const full = finalizedText + currentSentence
    onPartial(text, full, isFinal)
  })

  api.onComplete(() => {
    onComplete(finalizedText + currentSentence)
  })

  api.onError(({ message }) => {
    onError(new Error(message))
  })

  api.onClosed(() => {})

  return {
    async start() {
      const result = await api.start(config)
      if (!result.ok) {
        throw new Error(result.error || 'Failed to start realtime ASR')
      }
      return result
    },
    sendAudio(arrayBuffer) {
      api.sendAudio(arrayBuffer)
    },
    async stop() {
      return api.stop()
    },
    cleanup() {
      api.removeListeners()
    },
  }
}
