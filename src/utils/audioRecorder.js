/**
 * 麦克风录音工具
 * 封装 getUserMedia + MediaRecorder，产出 audio Blob 供语音识别使用
 */

let mediaRecorder = null
let audioStream = null
let audioContext = null
let analyser = null
let animationFrame = null
let chunks = []
let currentMimeType = ''

function pickMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]
  for (const t of types) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t
    } catch { /* ignore */ }
  }
  return ''
}

/**
 * 开始录音
 * @param {(level: number) => void} [onLevel] 音量回调 0..1
 */
export async function startRecording(onLevel) {
  if (mediaRecorder) throw new Error('已在录音中')

  audioStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  chunks = []

  const mimeType = pickMimeType()
  currentMimeType = mimeType
  mediaRecorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : {})
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  mediaRecorder.start(100)

  if (onLevel && typeof AudioContext !== 'undefined') {
    audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(audioStream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]
      onLevel(Math.min(1, sum / data.length / 128))
      animationFrame = requestAnimationFrame(tick)
    }
    tick()
  }
}

/**
 * 停止录音并返回 Blob
 * @returns {Promise<{ blob: Blob, mimeType: string, audioFormat: string }>}
 */
export function stopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder) {
      return resolve({ blob: null, mimeType: '', audioFormat: '' })
    }

    const mimeType = currentMimeType || 'audio/webm'
    mediaRecorder.onstop = () => {
      cleanup()
      resolve({
        blob: new Blob(chunks, { type: mimeType }),
        mimeType,
        audioFormat: mimeToFormat(mimeType),
      })
    }

    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
    } else {
      cleanup()
      resolve({ blob: null, mimeType: '', audioFormat: '' })
    }
  })
}

/** 取消录音，丢弃数据 */
export function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null
    try { mediaRecorder.stop() } catch { /* ignore */ }
  }
  cleanup()
  chunks = []
}

export function isRecording() {
  return !!mediaRecorder && mediaRecorder.state === 'recording'
}

function cleanup() {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
    animationFrame = null
  }
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop())
    audioStream = null
  }
  if (audioContext) {
    audioContext.close().catch(() => {})
    audioContext = null
  }
  analyser = null
  mediaRecorder = null
}

function mimeToFormat(mime) {
  if (!mime) return 'wav'
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('wav')) return 'wav'
  return 'wav'
}


// ==================== PCM Streaming Mode (for realtime ASR) ====================

const PCM_WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      const float32 = input[0]
      const int16 = new Int16Array(float32.length)
      for (let i = 0; i < float32.length; i++) {
        let s = Math.max(-1, Math.min(1, float32[i]))
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }
      this.port.postMessage(int16.buffer)
    }
    return true
  }
}
registerProcessor('pcm-processor', PCMProcessor)
`

let streamContext = null
let streamWorklet = null
let streamSource = null
let streamAnalyser = null
let streamAnimFrame = null
let streamMediaStream = null
let chunkBuffer = []
let chunkBufferSize = 0
let onChunkCallback = null
let streamSampleRate = 16000

/**
 * Start streaming PCM recording for realtime ASR.
 * @param {(arrayBuffer: ArrayBuffer, sampleRate: number) => void} onChunk
 * @param {(level: number) => void} [onLevel]
 * @returns {Promise<{ sampleRate: number }>}
 */
export async function startStreamingRecording(onChunk, onLevel) {
  if (streamContext) throw new Error('Already streaming')

  streamMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  streamContext = new AudioContext()
  streamSampleRate = streamContext.sampleRate
  streamSource = streamContext.createMediaStreamSource(streamMediaStream)
  onChunkCallback = onChunk

  // Audio level metering
  if (onLevel) {
    streamAnalyser = streamContext.createAnalyser()
    streamAnalyser.fftSize = 256
    streamSource.connect(streamAnalyser)
    const data = new Uint8Array(streamAnalyser.frequencyBinCount)
    const tick = () => {
      streamAnalyser.getByteFrequencyData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]
      onLevel(Math.min(1, sum / data.length / 128))
      streamAnimFrame = requestAnimationFrame(tick)
    }
    tick()
  }

  // PCM worklet via inline Blob URL
  const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await streamContext.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }

  streamWorklet = new AudioWorkletNode(streamContext, 'pcm-processor')
  streamSource.connect(streamWorklet)
  // Zero-gain sink so worklet runs without audio playback
  const sink = streamContext.createGain()
  sink.gain.value = 0
  streamWorklet.connect(sink)
  sink.connect(streamContext.destination)

  streamWorklet.port.onmessage = (e) => {
    const pcmBuffer = e.data
    chunkBuffer.push(pcmBuffer)
    chunkBufferSize += pcmBuffer.byteLength

    // Buffer ~100ms of audio before sending to reduce IPC overhead
    const targetSize = Math.floor(streamSampleRate * 0.1) * 2 // 100ms, 16-bit
    if (chunkBufferSize >= targetSize) {
      const merged = mergeInt16Buffers(chunkBuffer, chunkBufferSize)
      onChunkCallback(merged.buffer, streamSampleRate)
      chunkBuffer = []
      chunkBufferSize = 0
    }
  }

  return { sampleRate: streamSampleRate }
}

function mergeInt16Buffers(buffers, totalBytes) {
  const result = new Int16Array(totalBytes / 2)
  let offset = 0
  for (const buf of buffers) {
    const arr = new Int16Array(buf)
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/** Stop streaming, flush remaining audio, then cleanup. */
export function stopStreamingRecording() {
  if (chunkBufferSize > 0 && onChunkCallback) {
    const merged = mergeInt16Buffers(chunkBuffer, chunkBufferSize)
    onChunkCallback(merged.buffer, streamSampleRate)
  }
  chunkBuffer = []
  chunkBufferSize = 0
  cleanupStreaming()
}

/** Cancel streaming without flushing. */
export function cancelStreamingRecording() {
  chunkBuffer = []
  chunkBufferSize = 0
  cleanupStreaming()
}

export function isStreamingRecording() {
  return !!streamContext
}

function cleanupStreaming() {
  if (streamAnimFrame) {
    cancelAnimationFrame(streamAnimFrame)
    streamAnimFrame = null
  }
  if (streamWorklet) {
    streamWorklet.port.onmessage = null
    try { streamWorklet.disconnect() } catch {}
    streamWorklet = null
  }
  if (streamSource) {
    try { streamSource.disconnect() } catch {}
    streamSource = null
  }
  if (streamAnalyser) {
    try { streamAnalyser.disconnect() } catch {}
    streamAnalyser = null
  }
  if (streamMediaStream) {
    streamMediaStream.getTracks().forEach(t => t.stop())
    streamMediaStream = null
  }
  if (streamContext) {
    streamContext.close().catch(() => {})
    streamContext = null
  }
  onChunkCallback = null
}
