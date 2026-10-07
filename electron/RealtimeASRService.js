// electron/RealtimeASRService.js
// Main-process WebSocket bridge for Aliyun Paraformer real-time ASR.
// Browser WebSocket cannot set custom headers, so we use `ws` here and
// bridge audio chunks / results via IPC.

import WebSocket from 'ws'
import crypto from 'node:crypto'

/** @type {Map<string, { sender: any, taskId: string, sendAudio: (b:Buffer)=>void, finish: ()=>Promise<void>, destroy: ()=>void }>} */
const sessions = new Map()

export function registerRealtimeASRHandlers(ipcMain) {
  ipcMain.handle('realtimeASR:start', async (event, config) => {
    // Clean up any existing session for this sender
    for (const [id, s] of sessions) {
      if (s.sender === event.sender) { s.destroy(); sessions.delete(id) }
    }
    const session = createSession(config, event.sender)
    sessions.set(session.taskId, session)
    try {
      await session.connect()
      return { ok: true, taskId: session.taskId }
    } catch (e) {
      sessions.delete(session.taskId)
      return { ok: false, error: e?.message || 'Connection failed' }
    }
  })

  ipcMain.on('realtimeASR:sendAudio', (event, arrayBuffer) => {
    for (const s of sessions.values()) {
      if (s.sender === event.sender && !s.sender.isDestroyed()) {
        s.sendAudio(Buffer.from(arrayBuffer))
        break
      }
    }
  })

  ipcMain.handle('realtimeASR:stop', async (event) => {
    for (const [id, s] of sessions) {
      if (s.sender === event.sender) {
        await s.finish()
        sessions.delete(id)
        return { ok: true }
      }
    }
    return { ok: false, error: 'No active session' }
  })
}

/** Clean up all sessions when a BrowserWindow is closed */
export function cleanupRealtimeASRForSender(sender) {
  for (const [id, s] of sessions) {
    if (s.sender === sender) { s.destroy(); sessions.delete(id) }
  }
}

function createSession(config, sender) {
  const taskId = crypto.randomUUID()
  let ws = null
  let audioReady = false
  let closed = false
  let stopResolve = null
  let stopTimeout = null

  function send(channel, data) {
    if (!sender.isDestroyed()) sender.send(channel, data)
  }

  function destroy() {
    if (closed) return
    closed = true
    if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null }
    if (ws) {
      ws.removeAllListeners()
      try { ws.close() } catch {}
      ws = null
    }
    stopResolve = null
  }

  return {
    taskId,
    sender,
    connect() {
      return new Promise((resolve, reject) => {
        const wsUrl = `wss://${config.workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
        ws = new WebSocket(wsUrl, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          handshakeTimeout: 10000,
        })

        ws.on('open', () => {
          const runTask = {
            header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
            payload: {
              task_group: 'audio', task: 'asr', function: 'recognition',
              model: config.model,
              parameters: {
                format: config.format || 'pcm',
                sample_rate: config.sampleRate || 16000,
                ...((config.language && config.language !== 'auto')
                  ? { language_hints: [config.language] } : {}),
              },
              input: {},
            },
          }
          ws.send(JSON.stringify(runTask))
        })

        ws.on('message', (data, isBinary) => {
          if (isBinary) return
          try {
            const msg = JSON.parse(data.toString())
            const evt = msg.header?.event
            if (evt === 'task-started') {
              audioReady = true
              send('realtimeASR:started', { taskId })
              resolve({ taskId })
            } else if (evt === 'result-generated') {
              const sentence = msg.payload?.output?.sentence
              if (sentence && !sentence.heartbeat) {
                send('realtimeASR:partial', {
                  text: sentence.text || '',
                  isFinal: sentence.sentence_end === true,
                })
              }
            } else if (evt === 'task-finished') {
              send('realtimeASR:complete', { taskId })
              if (stopResolve) { stopResolve(); stopResolve = null }
              if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null }
              destroy()
            } else if (evt === 'task-failed') {
              send('realtimeASR:error', { message: msg.header?.error_message || 'Task failed' })
              if (stopResolve) { stopResolve(); stopResolve = null }
              if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null }
              destroy()
            }
          } catch {}
        })

        ws.on('error', (err) => {
          if (!closed) send('realtimeASR:error', { message: err.message || 'WebSocket error' })
          if (!audioReady) reject(err)
          if (stopResolve) { stopResolve(); stopResolve = null }
          if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null }
          destroy()
        })

        ws.on('close', () => {
          if (!closed) send('realtimeASR:closed', {})
          if (stopResolve) { stopResolve(); stopResolve = null }
          if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null }
          destroy()
        })
      })
    },
    sendAudio(buffer) {
      if (ws && ws.readyState === WebSocket.OPEN && audioReady && !closed) {
        ws.send(buffer)
      }
    },
    finish() {
      return new Promise((resolve) => {
        if (!ws || ws.readyState !== WebSocket.OPEN || closed) { resolve(); return }
        stopResolve = resolve
        ws.send(JSON.stringify({
          header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: {} },
        }))
        stopTimeout = setTimeout(() => {
          if (stopResolve) { stopResolve(); stopResolve = null }
          destroy()
          resolve()
        }, 5000)
      })
    },
    destroy,
  }
}
