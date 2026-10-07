// electron/agents/langchainTools.js — LangChain tool definitions using Zod schemas
// Custom tools for DeepAgents that supplement the built-in filesystem tools
// DeepAgents provides ls/read_file/write_file/edit_file/glob/grep via FilesystemBackend natively

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { tool } from 'langchain'
import { z } from 'zod'
import { create, all } from 'mathjs'
import { ToolsetRegistry } from '../tools/ToolsetRegistry.js'
import { createFfmpegTool } from '../tools/FfmpegToolService.js'
import { createPandocTool } from '../tools/PandocToolService.js'
import { createManimTool } from '../tools/ManimToolService.js'
import { createOfficeWriteTool } from '../tools/officecli/index.js'
import { createPdfReadTool } from '../tools/pdf/PdfReadTool.js'
import { createDocumentReadTool } from '../tools/document/DocumentReadTool.js'
import { createNoteTool } from '../tools/note/NoteTool.js'
import { createMediaReadTool } from '../media/tools/MediaReadTool.js'
import { extractOfficeImages, queryOfficeImages } from '../tools/officecli/OfficeImageExtractor.js'
import { PptxExportService } from '../PptxExportService.js'
import { getOfficeCliCommandCandidates, getOfficeCliSpawnEnv } from '../officeCliResolver.js'
import { getSystemEnv } from '../systemEnv.js'
import { SAFE_COMMAND_TOOL_DESCRIPTION, runSafeCommand, runSafeStructuredCommand, validateSafeCommand } from '../security/SafeCommandRunner.js'
import { createVfsPathResolver } from '../security/VfsPathResolver.js'

// Restricted mathjs instance — import/createUnit/evaluate/parse banned for safety
const math = create(all)
math.import({
  import: function () { throw new Error('Function import is disabled') },
  createUnit: function () { throw new Error('Function createUnit is disabled') },
  reviver: function () { throw new Error('Function reviver is disabled') },
}, { override: true })

// Per-agent tool provider config: { web_search_tavily: { apiKey, baseUrl, userParams }, ... }
let _toolProviderConfigs = {}

// WorkDirService injection for delete_file path validation
let _workDirService = null
// DatabaseService injection for reading security settings
let _dbService = null
let _wikiService = null
let _mcpService = null
let _mediaQueryService = null
let _noteFileService = null
let _toolRunContext = { agentEnglishName: '_shared', permissions: {} }
let _skillService = null
let _visionAnalyzeHandler = null
const _toolsetRegistry = new ToolsetRegistry()

// Per-task invocation counters (reset per agent run)
// All search tools share a combined counter
let _taskCounters = { web_search: 0, file_op: 0 }
let _taskLimits = { web_search: 10, file_op: 30 }

export function setToolProviderConfig(configs) {
  _toolProviderConfigs = configs || {}
}

export function setWorkDirService(wd) {
  _workDirService = wd
}

export function setDbService(db) {
  _dbService = db
}

export function setWikiService(service) {
  _wikiService = service
}

export function setMcpService(service) {
  _mcpService = service
}

export function setMediaQueryService(service) {
  _mediaQueryService = service || null
}

export function setNoteFileService(service) {
  _noteFileService = service || null
}

export function setSkillService(service) {
  _skillService = service || null
}

export function setVisionAnalyzeHandler(handler) {
  _visionAnalyzeHandler = typeof handler === 'function' ? handler : null
}

export function setToolRunContext(ctx = {}) {
  const toolIds = (ctx.toolIds || ctx.tools || [])
    .filter(item => typeof item === 'string')
  const boundSkillIds = (ctx.boundSkillIds || ctx.skills || [])
    .map(item => String(item || '').replace(/\\/g, '/').replace(/^\/?skills\//i, '').replace(/\/+$/, ''))
    .filter(Boolean)
  const mcpServerIds = []
  for (const item of toolIds) {
    if (typeof item !== 'string' || !item.startsWith('mcp:')) continue
    const serverId = item.split(':')[1]
    if (serverId) mcpServerIds.push(serverId)
  }
  _toolRunContext = {
    agentEnglishName: ctx.agentEnglishName || '_shared',
    permissions: ctx.permissions || {},
    wikiContext: ctx.wikiContext || {},
    boundSkillIds,
    mcpServerIds: [...new Set(mcpServerIds)],
    toolIds: [...new Set(toolIds)],
    allowedMediaIds: [...new Set((ctx.allowedMediaIds || []).map(item => String(item || '')).filter(Boolean))],
    vision: ctx.vision || {},
  }
}

export const mediaRead = createMediaReadTool({
  getQueryService: () => _mediaQueryService,
  getRunContext: () => _toolRunContext,
})

export const noteTool = createNoteTool({
  getNoteService: () => _noteFileService,
  getRunContext: () => _toolRunContext,
})

function createRunScopedMediaRead() {
  const runContext = Object.freeze({
    ..._toolRunContext,
    allowedMediaIds: Object.freeze([...(_toolRunContext.allowedMediaIds || [])]),
  })
  return createMediaReadTool({
    getQueryService: () => _mediaQueryService,
    getRunContext: () => runContext,
  })
}

function createRunScopedNoteTool() {
  const runContext = Object.freeze({
    ..._toolRunContext,
    permissions: Object.freeze({ ...(_toolRunContext.permissions || {}) }),
  })
  return createNoteTool({
    getNoteService: () => _noteFileService,
    getRunContext: () => runContext,
  })
}

// Cloud API context for kb_search: { baseUrl, token, defaultKbIds, defaultDocIds }
let _cloudCtx = { baseUrl: '', token: '', defaultKbIds: [], defaultDocIds: [], activeSourceId: '', externalKbId: '' }
let _externalKbBodyFields = '' // human-readable field list from the active source's search body
export function setCloudContext(ctx) {
  _cloudCtx = {
    baseUrl: ctx?.baseUrl || '',
    token: ctx?.token || '',
    defaultKbIds: Array.isArray(ctx?.defaultKbIds) ? ctx.defaultKbIds : [],
    defaultDocIds: Array.isArray(ctx?.defaultDocIds) ? ctx.defaultDocIds : [],
    activeSourceId: ctx?.activeSourceId || '',
    externalKbId: ctx?.externalKbId || '',
  }
  // When an external source is active, extract its search body field names
  // so we can describe them to the agent in the kb_search tool schema.
  _externalKbBodyFields = ''
  if (_cloudCtx.activeSourceId && _kbRegistry) {
    try {
      const src = _kbRegistry.getSource(_cloudCtx.activeSourceId)
      const body = src?.config?.endpoints?.search?.body
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const fields = Object.keys(body)
          .filter(k => !['query', 'top_k'].includes(k)) // skip runtime placeholders
        if (fields.length) {
          _externalKbBodyFields = fields.map(k => {
            const v = body[k]
            const valStr = typeof v === 'string' ? v : JSON.stringify(v)
            return `${k} (当前: ${valStr.length > 40 ? valStr.slice(0,40)+'…' : valStr})`
          }).join(', ')
        }
      }
    } catch {}
  }
}

// KnowledgeSourceRegistry — set by AgentService.init() so kb_search can route
// to non-builtin knowledge sources when activeSourceId is set.
let _kbRegistry = null
export function setKnowledgeSourceRegistry(registry) {
  _kbRegistry = registry
}
export function getKnowledgeSourceRegistry() {
  return _kbRegistry
}

export function resetTaskCounters() {
  _taskCounters = { web_search: 0, file_op: 0 }
  // Read limits from DB settings
  const searchLimit = _dbService?.getSetting('searchLimit')
  const fileOpLimit = _dbService?.getSetting('fileOpLimit')
  if (searchLimit && searchLimit !== '10') _taskLimits.web_search = Number(searchLimit) || 10
  if (fileOpLimit && fileOpLimit !== '30') _taskLimits.file_op = Number(fileOpLimit) || 30
}

// ── Execution Tool ──────────────────────────────────────────────

let _execCommandConfig = { whitelist: null, blacklist: null }
export function setExecCommandConfig(config) {
  _execCommandConfig = config || { whitelist: null, blacklist: null }
}

function _safeCommandContext() {
  return {
    dbService: _dbService,
    workDirService: _workDirService,
    execConfig: _execCommandConfig,
    vfsResolver: _vfsResolver(),
    vfsContext: _vfsContext(),
    hitlEnabled: !!(_toolRunContext.permissions?.execCommand),
  }
}

function _validateCommand(command) {
  return validateSafeCommand(command, _safeCommandContext())
}

function _execCommandUnavailableMessage() {
  const toolIds = new Set(_toolRunContext.toolIds || [])
  if (!toolIds.has('exec_command')) {
    return '当前 Agent 未绑定“执行命令(exec_command)”工具，不能执行 shell 命令。请先在 Agent 工具中启用“执行命令”。'
  }
  const permissions = _toolRunContext.permissions || {}
  if (Object.prototype.hasOwnProperty.call(permissions, 'execCommand') && !permissions.execCommand) {
    return '当前 Agent 未开启 execCommand 权限，不能执行 shell 命令。请先在 Agent 权限中开启“执行命令”。'
  }
  return ''
}

export async function invokeCommandCompatibilityTool(input = {}, sourceTool = 'execute') {
  const unavailable = _execCommandUnavailableMessage()
  if (unavailable) {
    return JSON.stringify({
      status: 'unavailable',
      source_tool: sourceTool,
      message: unavailable,
    })
  }

  const args = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : { command: String(input || '') }

  if (args.cmd) {
    const result = await runSafeStructuredCommand({
      cmd: args.cmd,
      args: Array.isArray(args.args) ? args.args : [],
      cwd: args.cwd,
    }, _safeCommandContext())
    return JSON.stringify({ ...result, routed_from: sourceTool })
  }

  const command = args.command || ''
  if (!command) {
    return JSON.stringify({
      status: 'error',
      source_tool: sourceTool,
      message: `${sourceTool}: missing command or cmd`,
    })
  }
  const result = await runSafeCommand(command, _safeCommandContext())
  return JSON.stringify({ ...result, routed_from: sourceTool })
}

function _vfsResolver() {
  return _workDirService ? createVfsPathResolver({ workDirService: _workDirService }) : null
}

function _vfsContext(extra = {}) {
  const wikiContext = _toolRunContext.wikiContext || {}
  return {
    agentDirName: _toolRunContext.agentEnglishName || '_shared',
    boundSkillIds: _toolRunContext.boundSkillIds || [],
    allowedWikiIds: Array.isArray(wikiContext.wikiIds) ? wikiContext.wikiIds.filter(Boolean) : [],
    wikiContext,
    ...extra,
  }
}

function _resolveVfsPath(inputPath, op, toolName) {
  const resolver = _vfsResolver()
  if (!resolver) throw new Error('No workspace initialized')
  return resolver.resolve(inputPath, _vfsContext({ op, toolName }))
}

function _toVirtualWorkspacePath(absPath) {
  const resolver = _vfsResolver()
  if (resolver) return resolver.toVirtualPath(absPath, _vfsContext({ op: 'read' }))
  const root = _workDirService?.getRootPath?.()
  if (!root) return absPath.replace(/\\/g, '/')
  const rel = path.relative(root, absPath).replace(/\\/g, '/')
  return rel && !rel.startsWith('..') ? '/' + rel : absPath.replace(/\\/g, '/')
}

export const execCommand = tool(
  async ({ command, cmd, args, cwd }) => {
    const unavailable = _execCommandUnavailableMessage()
    if (unavailable) {
      return JSON.stringify({ status: 'unavailable', message: unavailable })
    }
    if (cmd) {
      const result = await runSafeStructuredCommand({ cmd, args, cwd }, _safeCommandContext())
      return JSON.stringify(result)
    }
    if (!command) throw new Error('exec_command: missing command or cmd')

    const result = await runSafeCommand(command, _safeCommandContext())
    return JSON.stringify(result)
  },
  {
    name: 'exec_command',
    description: SAFE_COMMAND_TOOL_DESCRIPTION,
    schema: z.object({
      command: z.string().optional().describe('兼容旧版：要执行的单条 shell 命令字符串。推荐改用 cmd/args/cwd。'),
      cmd: z.string().optional().describe('推荐：命令名，如 pnpm、node、python、git。不包含参数。'),
      args: z.array(z.string()).optional().describe('推荐：命令参数数组。文件路径请使用 /project、/docs、/context、/agents/... 虚拟路径。'),
      cwd: z.string().optional().describe('推荐：工作目录虚拟路径，如 /project 或 /agents/{agent}/outputs/YYYY-MM-DD。默认 /。'),
    }),
  },
)

const commandCompatibilitySchema = z.object({
  command: z.string().optional().describe('兼容输入：要执行的命令字符串。'),
  cmd: z.string().optional().describe('兼容输入：命令名。'),
  args: z.array(z.string()).optional().describe('兼容输入：命令参数数组。'),
  cwd: z.string().optional().describe('兼容输入：工作目录虚拟路径。'),
  description: z.string().optional().describe('兼容部分模型传入的说明字段，会被忽略。'),
})

function createHiddenCommandCompatibilityTool(name) {
  return tool(
    async (input) => invokeCommandCompatibilityTool(input, name),
    {
      name,
      description: 'Reviva 内部兼容工具。不要主动调用；命令执行请使用 exec_command。',
      schema: commandCompatibilitySchema,
    },
  )
}

export const hiddenCommandCompatibilityTools = [
  createHiddenCommandCompatibilityTool('bash'),
  createHiddenCommandCompatibilityTool('command'),
  createHiddenCommandCompatibilityTool('shell'),
]

// ── Web Search — Tavily ──────────────────────────────────────────

export const webSearchTavily = tool(
  async ({ query, max_results, language }) => {
    _taskCounters.web_search++
    if (_taskCounters.web_search > _taskLimits.web_search) {
      return JSON.stringify({ status: 'limit_reached', message: `本任务搜索次数已达上限 (${_taskLimits.web_search} 次)，请总结已有信息继续回答。` })
    }
    const config = _toolProviderConfigs.web_search_tavily || {}
    const apiKey = config.apiKey || ''
    const baseUrl = (config.baseUrl || 'https://api.tavily.com').replace(/\/+$/, '')
    const maxRes = max_results || config.userParams?.max_results || 5
    const lang = language || config.userParams?.language || 'zh-CN'

    if (!apiKey) {
      return JSON.stringify({ status: 'not_configured', message: '请先在工具设置中配置 Tavily API Key' })
    }

    try {
      // Use direct HTTP request to support custom baseUrl
      // Tavily API: POST /search with api_key in body or Authorization header
      const resp = await fetch(`${baseUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: maxRes,
          search_depth: 'basic',
          include_answer: false,
          language: lang,
        }),
      })
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        return JSON.stringify({ status: 'error', message: `HTTP ${resp.status}: ${errBody.substring(0, 200)}`, query })
      }
      const data = await resp.json()
      if (data.results) {
        const results = data.results.slice(0, maxRes).map(r => ({ title: r.title, url: r.url, snippet: r.content }))
        return JSON.stringify(results)
      }
      return JSON.stringify({ status: 'error', message: data.detail || data.error || '未知错误', query })
    } catch (e) {
      return JSON.stringify({ status: 'error', message: e.message, query })
    }
  },
  {
    name: 'web_search_tavily',
    description: '使用 Tavily 高质量搜索 API 搜索互联网。专为 AI 应用设计，支持自定义 API 地址。返回搜索结果标题、URL和摘要。',
    schema: z.object({
      query: z.string().describe('搜索关键词'),
      max_results: z.number().optional().describe('最大返回结果数，默认5'),
      language: z.string().optional().describe('搜索语言偏好，如 zh-CN / en-US'),
    }),
  },
)

// ── Web Search — SearXNG ─────────────────────────────────────────

export const webSearchSearxng = tool(
  async ({ query, max_results, language }) => {
    _taskCounters.web_search++
    if (_taskCounters.web_search > _taskLimits.web_search) {
      return JSON.stringify({ status: 'limit_reached', message: `本任务搜索次数已达上限 (${_taskLimits.web_search} 次)，请总结已有信息继续回答。` })
    }
    const config = _toolProviderConfigs.web_search_searxng || {}
    const baseUrl = (config.baseUrl || 'https://searx.be').replace(/\/+$/, '')
    const apiKey = config.apiKey || ''
    const maxRes = max_results || config.userParams?.max_results || 5
    const lang = language || config.userParams?.language || 'zh-CN'

    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        language: lang,
      })
      const headers = { 'Accept': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const resp = await fetch(`${baseUrl}/search?${params}`, {
        signal: AbortSignal.timeout(15000),
        headers,
      })
      const data = await resp.json()
      const results = (data.results || []).slice(0, maxRes).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      }))
      return JSON.stringify(results)
    } catch (e) {
      return JSON.stringify({ status: 'error', message: e.message, query })
    }
  },
  {
    name: 'web_search_searxng',
    description: '使用 SearXNG 开源元搜索引擎搜索互联网。可自建实例，免费使用。部分实例需要 API Key。返回搜索结果标题、URL和摘要。',
    schema: z.object({
      query: z.string().describe('搜索关键词'),
      max_results: z.number().optional().describe('最大返回结果数，默认5'),
      language: z.string().optional().describe('搜索语言偏好，如 zh-CN / en-US'),
    }),
  },
)

// ── Web Search — Bing ─────────────────────────────────────────────

function _parseBingHtml(html, maxRes) {
  const results = []
  // Split HTML into b_algo blocks using a non-greedy approach
  // Bing wraps each organic result in <li class="b_algo">
  const blocks = html.split(/<li class="b_algo"/gi).slice(1) // skip preamble
  for (const block of blocks) {
    if (results.length >= maxRes) break
    // Find the closing </li> for this block
    const endIdx = block.indexOf('</li>')
    if (endIdx === -1) continue
    const content = block.substring(0, endIdx)

    // Extract title from <h2> — Bing wraps each result in <li class="b_algo"><h2><a href="...">
    // Some results have a <div class="b_tpcn"> with site icon/domain before the title text
    const h2Match = content.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    if (!h2Match) continue
    const h2Content = h2Match[1]
    const hrefMatch = h2Content.match(/href="([^"]+)"/i)
    if (!hrefMatch) continue
    const url = hrefMatch[1]
    // Skip non-http URLs (javascript:, /search, etc.)
    if (!url.startsWith('http')) continue
    // Iteratively strip inner <div>...</div> blocks to handle nesting (b_tpcn etc.)
    let stripped = h2Content
    let prev = ''
    while (prev !== stripped) {
      prev = stripped
      stripped = stripped.replace(/<div[^>]*>[\s\S]*?<\/div\s*>/gi, '')
    }
    const title = stripped.replace(/<[^>]+>/g, '').trim()
    if (!title) continue

    // Extract snippet — try b_caption > p first, then any <p> in the block
    let snippet = ''
    const capPMatch = content.match(/<div class="b_caption[^"]*"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i)
    if (capPMatch) {
      snippet = capPMatch[1].replace(/<[^>]+>/g, '').trim()
    } else {
      // Fallback: first <p> in the block after the h2
      const h2End = content.indexOf('</h2>')
      const pMatch = content.substring(h2End + 5).match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      if (pMatch) snippet = pMatch[1].replace(/<[^>]+>/g, '').trim()
    }

    // Decode common HTML entities in snippet
    snippet = snippet
      .replace(/&ensp;/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, '')
      .trim()

    // Remove date prefixes like "2024年5月20日 · "
    snippet = snippet.replace(/^\d{4}[年月日]+\s*[·•—–-]\s*/, '')

    results.push({ title, url, snippet })
  }
  return results
}

export const webSearchBing = tool(
  async ({ query, max_results, language }) => {
    _taskCounters.web_search++
    if (_taskCounters.web_search > _taskLimits.web_search) {
      return JSON.stringify({ status: 'limit_reached', message: `本任务搜索次数已达上限 (${_taskLimits.web_search} 次)，请总结已有信息继续回答。` })
    }
    const config = _toolProviderConfigs.web_search_bing || {}
    const maxRes = max_results || config.userParams?.max_results || 5
    const lang = language || config.userParams?.language || 'zh-CN'

    try {
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(maxRes + 5, 15)), // request extra to filter out non-http URLs
        setlang: lang,
      })
      // Use cn.bing.com directly to avoid redirect issues and get China-optimized results
      const resp = await fetch(
        'https://cn.bing.com/search?' + params,
        {
          signal: AbortSignal.timeout(15000),
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': lang + ',en;q=0.9',
          },
        },
      )
      const html = await resp.text()

      // Check if we got a real search page
      if (!html.includes('b_algo') || html.length < 5000) {
        return JSON.stringify({ status: 'error', message: 'Bing 返回了非搜索页面，可能被验证拦截', query })
      }

      const results = _parseBingHtml(html, maxRes)
      if (results.length === 0) {
        return JSON.stringify({ status: 'no_results', message: '未找到相关搜索结果', query })
      }
      return JSON.stringify(results)
    } catch (e) {
      return JSON.stringify({ status: 'error', message: e.message, query })
    }
  },
  {
    name: 'web_search_bing',
    description: '通过本地请求 Bing 搜索互联网，免费无需 API Key。返回搜索结果标题、URL和摘要。',
    schema: z.object({
      query: z.string().describe('搜索关键词'),
      max_results: z.number().optional().describe('最大返回结果数，默认5'),
      language: z.string().optional().describe('搜索语言偏好，如 zh-CN / en-US'),
    }),
  },
)

// ── Knowledge Base Search ───────────────────────────────────────

const DEFAULT_KB_SEARCH_MODES = ['vector', 'fulltext', 'graph', 'summary']

function _cloudSearchQueryUrl(baseUrl) {
  const root = String(baseUrl || '').replace(/\/+$/, '')
  if (/\/api\/v1\/app$/i.test(root)) return `${root}/search/query`
  if (/\/api\/v1$/i.test(root)) return `${root}/app/search/query`
  return `${root}/api/v1/app/search/query`
}

function _normalizeSearchTopK(topK) {
  const n = Number(topK)
  if (!Number.isFinite(n)) return 5
  return Math.min(100, Math.max(1, Math.trunc(n)))
}

function _formatSearchErrorDetail(detail) {
  if (!detail) return ''
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object') {
    if (detail.code === 'INSUFFICIENT_POINTS') {
      return `积分不足：本次需要 ${detail.required_points ?? '-'}，当前余额 ${detail.points_balance ?? '-'}`
    }
    return detail.message || detail.error || detail.code || JSON.stringify(detail)
  }
  return String(detail)
}

export const kbSearch = tool(
  async ({ query, kb_ids, doc_ids, top_k, search_mode, search_modes, rerank, save_to_history }) => {
    const ctx = _cloudCtx
    // When a knowledge source is activated via the Registry, route through it
   // instead of the legacy inline ApeRAG path.
    if (ctx.activeSourceId && _kbRegistry) {
      try {
        const result = await _kbRegistry.search(ctx.activeSourceId, {
          query, top_k,
          kbId: ctx.externalKbId || '',
        })
       return JSON.stringify(result)
      } catch (e) {
        return JSON.stringify({ status: 'error', message: e?.message || 'Registry search failed' })
      }
    }
    if (!ctx.baseUrl || !ctx.token) {
      return JSON.stringify({
        status: 'unavailable',
        message: '云端知识库未登录或未配置 baseUrl。请用户先登录 Reviva 账号。',
      })
    }
    const hasSelectedScope = ctx.defaultKbIds.length || ctx.defaultDocIds.length
    if (!hasSelectedScope) {
      return JSON.stringify({
        status: 'unavailable',
        message: '当前未选择云端知识库或知识库文档，不能进行知识库检索。请用户先在侧边栏选择知识库范围。',
      })
    }
    const effectiveKbIds = (Array.isArray(kb_ids) && kb_ids.length) ? kb_ids : ctx.defaultKbIds
    const effectiveDocIds = (Array.isArray(doc_ids) && doc_ids.length) ? doc_ids : ctx.defaultDocIds
    const payload = {
      query,
      top_k: _normalizeSearchTopK(top_k),
      rerank: !!rerank,
      save_to_history: !!save_to_history,
    }
    if (effectiveKbIds.length) payload.kb_ids = effectiveKbIds
    if (effectiveDocIds.length) payload.doc_ids = effectiveDocIds
    if (Array.isArray(search_modes) && search_modes.length) payload.search_modes = search_modes
    else if (search_mode) payload.search_mode = search_mode
    else payload.search_modes = DEFAULT_KB_SEARCH_MODES

    try {
      const url = _cloudSearchQueryUrl(ctx.baseUrl)
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ctx.token}`,
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        let body = null
        try { body = await res.json() } catch (_) {}
        const detail = body?.detail || body?.message || body?.error || ''
        return JSON.stringify({
          status: 'error',
          httpStatus: res.status,
          message: _formatSearchErrorDetail(detail) || `搜索请求失败 (HTTP ${res.status})`,
          detail,
        })
      }
      const data = await res.json()
      return JSON.stringify({
        status: 'ok',
        query: data?.query,
        scope: data?.scope,
        result: data?.result,
        charged_points: data?.charged_points,
        points_balance: data?.points_balance,
      })
    } catch (e) {
      return JSON.stringify({ status: 'error', message: e?.message || '网络错误' })
    }
  },
  {
   name: 'kb_search',
    description: '在云端知识库中检索相关内容。用户选择云端知识库或云端知识库文档后，必须用此工具获取内容；不要改用 read_file/file_read/document_read/office_read/pdf_read 读取云端知识库。通常只传 query，系统会自动使用当前选择的 kb_ids/doc_ids。默认 top_k=5；可根据任务用不同 query 多次检索，只有问题范围较宽、用户要求更全面或命中不足时才适度上调 top_k。',
  schema: z.object({
    query: z.string().describe('检索查询语句'),
      kb_ids: z.array(z.string()).optional().describe('限定知识库 ID 列表；不传则使用用户当前选择的范围'),
      doc_ids: z.array(z.string()).optional().describe('限定文档 ID 列表；不传则不限'),
     top_k: z.number().int().min(1).max(100).optional().describe('返回条数；不传默认 5。一般保持 5；复杂或宽泛问题可用 8-10，只有用户明确要求大量结果时才更高'),
     search_mode: z.enum(['vector', 'fulltext', 'graph', 'summary', 'vision', 'hybrid']).optional()
        .describe('单选检索模式；通常不需要传，默认使用 search_modes 的四种混合检索'),
     search_modes: z.array(z.enum(['vector', 'fulltext', 'graph', 'summary', 'vision'])).optional()
        .describe('检索模式组合；不传默认 vector/fulltext/graph/summary，不默认启用 vision'),
     rerank: z.boolean().optional().describe('是否对结果重排，默认 false'),
     save_to_history: z.boolean().optional().describe('是否保存检索历史，默认 false'),
   }),
},
)

// ── Calculator ──────────────────────────────────────────────────
// Powered by mathjs: arithmetic, scientific functions, statistics, unit conversion,
// combinatorics, constants. Single expression entry point — let the LLM compose
// the right mathjs syntax based on the description below.

// ── External KB Search (Dify / FastGPT / Custom HTTP / MCP) ────────────────
// Minimal schema: only query, top_k, and extra_body.
// getLangchainTools swaps this in when _cloudCtx.activeSourceId is set.
// Factory: creates a fresh kb_search tool instance with a dynamic description
// that includes the actual body fields of the active external knowledge source.
export function createKbSearchExternal() {
  const fieldHint = _externalKbBodyFields
    ? `当前知识库支持的 extra_body 字段：${_externalKbBodyFields}。`
    : ''
  const noKbHint = !_cloudCtx.externalKbId
    ? '注意：当前未选择具体知识库，检索可能无法定位到正确的数据集。如果检索失败，请提示用户在侧边栏选择一个知识库。'
    : ''
  return tool(
    async ({ query, top_k, extra_body }) => {
      const ctx = _cloudCtx
      if (!ctx.activeSourceId || !_kbRegistry) {
        return JSON.stringify({ status: 'error', message: 'No external knowledge source active' })
      }
      try {
        const result = await _kbRegistry.search(ctx.activeSourceId, {
          query, top_k, extra_body,
          kbId: ctx.externalKbId || '',
        })
        return JSON.stringify(result)
      } catch (e) {
        return JSON.stringify({ status: 'error', message: e?.message || 'Registry search failed' })
      }
    },
    {
      name: 'kb_search',
      description: '在外部知识库中检索相关内容（Dify/FastGPT/自定义 HTTP/MCP）。通常只需传 query；默认 top_k=5，命中不足或问题宽泛时可上调。如需根据用户意图调整检索范围，可通过 extra_body 传递额外请求体字段，覆盖知识源配置中的默认值。' + fieldHint + noKbHint,
      schema: z.object({
        query: z.string().describe('检索查询语句'),
        top_k: z.number().int().min(1).max(100).optional().describe('返回条数；不传默认 5'),
        extra_body: z.record(z.any()).optional().describe('额外请求体字段，键名必须与目标 API 的 body 字段名一致。传入的值会覆盖配置中的默认值'),
      }),
    },
  )
}

export const calculator = tool(
  async ({ expression }) => {
    if (!expression) throw new Error('calculator: missing expression')
    try {
      const raw = math.evaluate(expression)
      // Normalize result: BigNumber / Unit / Matrix / Complex → string via mathjs format
      let result
      if (raw === null || raw === undefined) {
        result = String(raw)
      } else if (typeof raw === 'number' || typeof raw === 'boolean') {
        result = raw
      } else if (typeof raw === 'string') {
        result = raw
      } else if (raw && typeof raw.toString === 'function') {
        result = math.format(raw, { precision: 14 })
      } else {
        result = String(raw)
      }
      return JSON.stringify({ expression, result })
    } catch (err) {
      throw new Error(`calculator error: ${err.message}`)
    }
  },
  {
    name: 'calculator',
    description: [
      '科学计算器，基于 mathjs 表达式求值。一个 expression 字段即可表达所有计算。支持：',
      '• 基础运算：2+3*4、2^10、(5-1)/2',
      '• 科学函数：sin(45 deg)、cos(pi/2)、log(100, 10)、ln(e)、exp(1)、sqrt(16)、abs(-5)、pow(2,8)',
      '• 统计与概率：mean([1,2,3,4,5])、median(...)、std(...)、variance(...)、sum(...)、min/max(...)、combinations(10,3)、permutations(10,3)、factorial(5)',
      '• 单位换算：12 inch to cm、5 km/h to m/s、100 fahrenheit to celsius、1 kJ to kcal、30 degC to K',
      '• 常量：pi、e、tau、phi、i',
      '• 矩阵与复数：[[1,2],[3,4]] * [[5],[6]]、(2+3i) * (4-i)',
      '注意角度计算需带 deg（如 sin(30 deg)），否则按弧度处理。返回 JSON {expression, result}。',
    ].join('\n'),
    schema: z.object({
      expression: z.string().describe('mathjs 表达式，如 "sin(45 deg) + sqrt(2)"、"mean([1,2,3,4])"、"12 inch to cm"'),
    }),
  },
)

// ── Vision Analyze ───────────────────────────────────────────────

export const visionAnalyze = tool(
  async ({ path: imagePath, paths = [], question = '', context = '', mode = 'auto', detail = 'auto', maxImages }) => {
    if (!_visionAnalyzeHandler) {
      return JSON.stringify({
        success: false,
        code: 'VISION_UNAVAILABLE',
        message: '当前运行环境未启用图片理解工具。',
      })
    }
    return JSON.stringify(await _visionAnalyzeHandler({ path: imagePath, paths, question, context, mode, detail, maxImages }, _toolRunContext))
  },
  {
    name: 'vision_analyze',
    description: [
      '按需理解工作区内图片内容。当前主模型支持视觉或已配置默认视觉理解模型时可用。',
      '用于分析 document_read/office_read 导出的文档图片、PDF 截图、视频关键帧或用户提供的图片；普通文字读取不要调用本工具。',
      '当用户要求分析图表、解释图片、比较多张图、提取图片中的文字/结构/视觉信息时调用；少量图片 OCR 也可以使用本工具。',
      '支持单图 path 或多图 paths；question 可由你根据用户问题和上下文生成，留空时会使用默认问题。默认最多 4 张，maxImages 硬上限 8 张。',
      '不要为了“图文并茂展示”而默认调用；只展示图片时使用 Markdown 图片路径即可。',
    ].join('\n'),
    schema: z.object({
      path: z.string().optional().describe('单张图片路径，支持工作区虚拟路径，如 /context/office-images/.../chart.png。'),
      paths: z.array(z.string()).optional().describe('多张图片路径。与 path 可同时传，工具会合并去重。默认最多分析 4 张，硬上限 8 张。'),
      question: z.string().optional().describe('希望视觉模型回答的问题；通常由 Agent 根据用户需求生成。为空时默认描述图片并提取与任务相关的信息。'),
      context: z.string().optional().describe('可选上下文，如图片来自哪个文档、页面、幻灯片或用户当前任务。'),
      mode: z.enum(['auto', 'per_image', 'compare']).optional().describe('分析模式：auto 综合分析；per_image 逐图说明；compare 多图对比。默认 auto。'),
      detail: z.enum(['auto', 'low', 'high']).optional().describe('视觉细节偏好，预留给支持该参数的模型。默认 auto。'),
      maxImages: z.number().int().min(1).max(8).optional().describe('最多分析图片数，默认 4，硬上限 8。'),
    }),
  },
)

// ── Delete File (with safety constraints) ───────────────────────

function _hasPathSegment(filePath, segment) {
  const expected = String(segment || '').toLowerCase()
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some(part => part.toLowerCase() === expected)
}

export const deleteFile = tool(
  async ({ path: filePath }) => {
    if (!_workDirService) return JSON.stringify({ error: 'No workspace initialized' })

    // Check file op limit
    _taskCounters.file_op++
    if (_taskCounters.file_op > _taskLimits.file_op) {
      return JSON.stringify({ error: `本任务文件操作次数已达上限 (${_taskLimits.file_op} 次)，请减少文件操作。` })
    }

    // Check global security settings from DB
    const allowFileDelete = _dbService?.getSetting('allowFileDelete') ?? true
    if (!allowFileDelete) {
      return JSON.stringify({ error: '安全限制：文件删除功能已被全局禁用。请在设置 > 沙箱保护 > Agent 安全策略中开启"允许文件删除"。' })
    }

    const deleteScope = _dbService?.getSetting('deleteScope') ?? 'outputs-only'

    let resolved
    let virtualPath = filePath
    try {
      const vfsPath = _resolveVfsPath(filePath, 'delete', 'delete_file')
      resolved = vfsPath.realPath
      virtualPath = vfsPath.virtualPath
    } catch (e) {
      return JSON.stringify({ error: `安全限制：${e.message}，只能删除当前 Agent 输出目录内的文件` })
    }

    const normalized = resolved.replace(/\\/g, '/').toLowerCase()

    // Safety: protect app metadata, memory, skills, memories directories — always enforced
    if (normalized.includes('/.reviva/') || normalized.includes('/memory/') || normalized.includes('/skills/') || normalized.includes('/memories/')) {
      return JSON.stringify({ error: '安全限制：不能删除系统目录、记忆目录或技能目录下的文件' })
    }

    // Enforce deleteScope setting
    if (deleteScope === 'outputs-only') {
      // Allow deleting files under authorized outputs/ or tmp/ directories.
      if (!_hasPathSegment(resolved, 'outputs') && !_hasPathSegment(resolved, 'tmp')) {
        return JSON.stringify({ error: '安全限制：当前删除范围设置为"仅 outputs/tmp 目录"，只能删除授权 outputs/ 或 tmp/ 目录内的文件或目录。如需更宽范围请在设置中调整。' })
      }
    }
    // VFS policy keeps Agent deletes scoped to this agent's outputs even if the legacy setting says workspace.

    try {
      const stat = fs.statSync(resolved)
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true })
      } else {
        fs.unlinkSync(resolved)
      }
      return JSON.stringify({ success: true, path: virtualPath, message: `已删除: ${virtualPath}` })
    } catch (err) {
      return JSON.stringify({ error: `删除失败: ${err.message}` })
    }
  },
  {
    name: 'delete_file',
    description: '删除当前 Agent 输出目录内的文件或目录。受全局安全设置约束，系统目录、记忆目录、技能目录始终受保护。此操作需要用户授权确认。',
    schema: z.object({
      path: z.string().describe('要删除的文件路径'),
    }),
  },
)

// ── Office Read (officecli, read-only) ──────────────────────────

const OFFICE_EXTS = new Set(['.docx', '.xlsx', '.pptx'])
const OFFICE_MODES = new Set(['overview', 'text', 'outline', 'stats', 'issues', 'images'])
const OFFICE_DEFAULT_MAX_CHARS = 40000
const OFFICE_MAX_CHARS = 80000
const OFFICE_DEFAULT_MAX_LINES = 100
const OFFICE_MAX_LINES = 300
const OFFICE_DEFAULT_MAX_IMAGES = 200
const OFFICE_MAX_IMAGES = 500

function _clipText(text, maxChars) {
  const content = String(text || '')
  if (content.length <= maxChars) return { content, truncated: false }
  return { content: content.slice(0, maxChars), truncated: true }
}

function _parseOfficeCliOutput(stdout, stderr) {
  const raw = (stdout || stderr || '').trim()
  if (!raw) return { raw: '', structured: null }
  try {
    return { raw, structured: JSON.parse(raw) }
  } catch {
    return { raw, structured: null }
  }
}

function _safeOfficeSegment(value, fallback = 'document') {
  const raw = String(value || '').trim().toLowerCase()
  const safe = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return safe || fallback
}

async function _getOfficeCliEnv() {
  try {
    return getOfficeCliSpawnEnv(await getSystemEnv())
  } catch {
    return getOfficeCliSpawnEnv(process.env)
  }
}

async function _spawnOfficeCli(command, args, { timeoutMs = 20000, maxBuffer = 2 * 1024 * 1024, shell = true, label = '' } = {}) {
  const env = await _getOfficeCliEnv()
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell,
      windowsHide: true,
      env,
    })
    const stdoutChunks = []
    const stderrChunks = []
    let collected = 0
    let done = false

    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }

    const append = (chunks, data) => {
      collected += data.length
      if (collected <= maxBuffer) chunks.push(data)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ code: 124, stdout: '', stderr: 'officecli timeout', via: label })
    }, timeoutMs)

    child.stdout.on('data', d => append(stdoutChunks, d))
    child.stderr.on('data', d => append(stderrChunks, d))
    child.on('error', err => finish({ code: err.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: err.message, via: label }))
    child.on('close', code => finish({
      code: code ?? 0,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      via: label,
    }))
  })
}

async function _runOfficeCli(args, options = {}) {
  const attempts = getOfficeCliCommandCandidates(args)
  let lastResult = { code: 127, stdout: '', stderr: 'officecli not found' }
  let bundledFailure = null
  for (const attempt of attempts) {
    const result = await _spawnOfficeCli(attempt.cmd, attempt.args, {
      ...options,
      shell: attempt.shell !== false,
      label: attempt.label,
    })
    lastResult = result
    if (_isOfficeCliNotFound(result)) continue
    if (attempt.source === 'bundled' && result.code !== 0) {
      bundledFailure = result
      continue
    }
    return result
  }
  return bundledFailure || lastResult
}

async function _runOfficeCliWithRetry(args, options = {}, retries = 1) {
  let result = await _runOfficeCli(args, options)
  for (let attempt = 0; attempt < retries && [124, 127].includes(result.code); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    result = await _runOfficeCli(args, options)
  }
  return result
}

function _isOfficeCliNotFound(result) {
  if (result.code === 127) return true
  const out = `${result.stdout || ''}\n${result.stderr || ''}`
  return [
    /is not recognized as an internal or external command/i,
    /command not found/i,
    /不是内部或外部命令/,
    /系统找不到/,
    /no such file or directory/i,
  ].some(re => re.test(out))
}

async function _runOfficeView(resolvedPath, mode, options = {}) {
  const args = ['view', resolvedPath, mode, '--json']
  if (mode === 'text') {
    if (options.start) args.push('--start', String(options.start))
    if (options.end) args.push('--end', String(options.end))
    if (options.maxLines) args.push('--max-lines', String(options.maxLines))
  }
  if (mode === 'issues') {
    args.push('--limit', String(Math.min(Number(options.maxLines) || 50, 100)))
  }
  return _runOfficeCli(args)
}

function _officeError(code, message, extra = {}) {
  return JSON.stringify({ success: false, code, message, ...extra })
}

async function invokeOfficeRead(input = {}, { countFileOp = true, toolName = 'office_read' } = {}) {
    const { path: filePath, mode = 'overview', start, end, maxLines, maxChars, exportImages = false, imagePath = '', maxImages } = input || {}
    const readToolLabel = toolName === 'document_read' ? 'document_read' : 'office_read'
    if (!_workDirService) {
      return _officeError('NO_WORKSPACE', '未初始化工作空间，无法读取 Office 文档。')
    }

    if (countFileOp) {
      _taskCounters.file_op++
      if (_taskCounters.file_op > _taskLimits.file_op) {
        return _officeError('FILE_OP_LIMIT_REACHED', `本任务文件操作次数已达上限 (${_taskLimits.file_op} 次)，请减少文件操作。`)
      }
    }

    if (!filePath) return _officeError('MISSING_PATH', 'office_read 缺少 path 参数。')

    let resolved
    let virtualPath
    try {
      const vfsPath = _resolveVfsPath(filePath, 'read', toolName)
      resolved = vfsPath.realPath
      virtualPath = vfsPath.virtualPath
    } catch (e) {
      return _officeError('PATH_NOT_ALLOWED', `安全限制：${e.message}，只能读取授权目录内的文件。`)
    }

    const ext = path.extname(resolved).toLowerCase()
    if (!OFFICE_EXTS.has(ext)) {
      return _officeError('UNSUPPORTED_OFFICE_FORMAT', 'office_read 仅支持 .docx、.xlsx、.pptx 文件。', { path: filePath })
    }
    if (!fs.existsSync(resolved)) {
      return _officeError('FILE_NOT_FOUND', '文件不存在。', { path: filePath })
    }

    const safeMode = OFFICE_MODES.has(mode) ? mode : 'overview'
    const safeMaxChars = Math.min(Math.max(Number(maxChars) || OFFICE_DEFAULT_MAX_CHARS, 1000), OFFICE_MAX_CHARS)
    const safeMaxLines = Math.min(Math.max(Number(maxLines) || OFFICE_DEFAULT_MAX_LINES, 1), OFFICE_MAX_LINES)
    const safeMaxImages = Math.min(Math.max(Number(maxImages) || OFFICE_DEFAULT_MAX_IMAGES, 1), OFFICE_MAX_IMAGES)
    const safeStart = Math.max(Number(start) || 1, 1)
    const safeEnd = end ? Math.max(Number(end), safeStart) : undefined
    const format = ext.slice(1)

    const versionCheck = await _runOfficeCliWithRetry(['--version'], { timeoutMs: 5000, maxBuffer: 64 * 1024 }, 1)
    if (versionCheck.code === 127) {
      return _officeError(
        'OFFICECLI_NOT_INSTALLED',
        '读取 Office 文档需要 officecli。请到 设置 > 环境检测 检查本机或内置 officecli。',
        { path: virtualPath, format },
      )
    }
    if (versionCheck.code !== 0) {
      return _officeError('OFFICECLI_UNAVAILABLE', 'officecli 当前不可用，无法读取 Office 文档。', {
        path: virtualPath,
        format,
        detail: (versionCheck.stderr || versionCheck.stdout || '').slice(0, 1000),
      })
    }

    if (safeMode === 'overview') {
      const stats = await _runOfficeView(resolved, 'stats')
      const outline = await _runOfficeView(resolved, 'outline')
      if (stats.code !== 0 && outline.code !== 0) {
        return _officeError('OFFICECLI_READ_FAILED', 'officecli 无法读取该 Office 文档。', {
          path: virtualPath,
          format,
          detail: (stats.stderr || outline.stderr || '').slice(0, 1200),
        })
      }

      const parsedStats = _parseOfficeCliOutput(stats.stdout, stats.stderr)
      const parsedOutline = _parseOfficeCliOutput(outline.stdout, outline.stderr)
      const combined = [
        parsedStats.raw ? `## Stats\n${parsedStats.raw}` : '',
        parsedOutline.raw ? `## Outline\n${parsedOutline.raw}` : '',
      ].filter(Boolean).join('\n\n')
      const clipped = _clipText(combined, safeMaxChars)
      return JSON.stringify({
        success: true,
        path: virtualPath,
        format,
        mode: safeMode,
        content: clipped.content,
        structured: clipped.truncated ? null : { stats: parsedStats.structured, outline: parsedOutline.structured },
        truncated: clipped.truncated,
        next: { mode: 'text', start: 1, maxLines: safeMaxLines, maxChars: safeMaxChars },
        note: `默认只返回结构概览。需要正文时请按 next 分段调用 ${readToolLabel}(mode="text")，不要一次性读取全文。`,
      })
    }

    if (safeMode === 'images') {
      const listed = await queryOfficeImages(resolved, { maxImages: safeMaxImages })
      const imageNeedle = String(imagePath || '').trim()
      const images = imageNeedle
        ? listed.images.filter(item => [item.path, item.name, item.relId].some(value => String(value || '') === imageNeedle || String(value || '').includes(imageNeedle)))
        : listed.images
      let exportResult = null
      if (exportImages === true) {
        const root = _workDirService.getRootPath()
        const docBase = _safeOfficeSegment(path.basename(resolved, ext), 'document')
        const outputDir = path.join(root, 'context', 'office-images', docBase)
        const outputRelDir = _toVirtualWorkspacePath(outputDir)
        exportResult = await extractOfficeImages(resolved, {
          outputDir,
          outputRelDir,
          sourceId: docBase,
          imagePath: imageNeedle,
          maxImages: safeMaxImages,
        })
      }
      return JSON.stringify({
        success: true,
        path: virtualPath,
        format,
        mode: safeMode,
        images,
        image_count: images.length,
        exported: exportResult ? exportResult.assets : [],
        exported_count: exportResult ? exportResult.assets.length : 0,
        cache: exportResult ? exportResult.cache : null,
        errors: exportResult ? exportResult.errors : listed.errors,
        note: exportImages === true
          ? '已通过 officecli get --save 导出文档内图片。exported[].path 可作为工作区图片路径供支持视觉的模型读取。'
          : `图片路径是 officecli DOM path；需要本地图片文件时再次调用 ${readToolLabel}(mode="images", exportImages=true)，可用 imagePath 指定单张图片。`,
      })
    }

    const result = await _runOfficeView(resolved, safeMode, {
      start: safeStart,
      end: safeEnd,
      maxLines: safeMaxLines,
    })
    if (result.code !== 0) {
      return _officeError('OFFICECLI_READ_FAILED', 'officecli 读取失败。', {
        path: virtualPath,
        format,
        mode: safeMode,
        detail: (result.stderr || result.stdout || '').slice(0, 1200),
      })
    }

    const parsed = _parseOfficeCliOutput(result.stdout, result.stderr)
    const clipped = _clipText(parsed.raw, safeMaxChars)
    const nextStart = safeMode === 'text' ? safeStart + safeMaxLines : null
    const hasContent = clipped.content.trim().length > 0
    return JSON.stringify({
      success: true,
      path: virtualPath,
      format,
      mode: safeMode,
      content: clipped.content,
      structured: clipped.truncated ? null : parsed.structured,
      truncated: clipped.truncated,
      next: safeMode === 'text' && hasContent && (clipped.truncated || safeMaxLines)
        ? { mode: 'text', start: nextStart, maxLines: safeMaxLines, maxChars: safeMaxChars }
        : null,
    })
}

export const officeRead = tool(
  async (input = {}) => invokeOfficeRead(input, { countFileOp: true, toolName: 'office_read' }),
  {
    name: 'office_read',
    description: [
      '读取 Office 文档的底层精确工具，支持 .docx、.xlsx、.pptx。常规 Office/PDF 资料读取优先使用 document_read；只有需要 Office 专属模式、精确诊断或用户明确要求底层工具时才直接调用 office_read。',
      '默认 mode=overview，只返回结构概览和下一步建议，避免长文档撑爆上下文。',
      '需要正文时使用 mode=text，并用 start/maxLines 分段读取。还支持 outline、stats、issues。',
      '需要文档内图片或图文并茂回答时，使用 mode=images；需要把图片保存为可渲染本地 Markdown 图片时传 exportImages=true，返回 exported[].path，可写成 ![说明](/context/office-images/.../xxx.png)。',
      '图片导出会在对应目录写入 .manifest.json 缓存；同一文档同一 DOM path 再次导出会优先返回已有图片路径。',
      '只需要定位图片时先用 mode=images；只需要单张图片时传 imagePath 匹配 DOM path、图片名或 relId。',
      '依赖本机或随应用内置的 officecli；不可用时会返回 OFFICECLI_NOT_INSTALLED。',
    ].join('\n'),
    schema: z.object({
      path: z.string().describe('Office 文件路径，必须位于授权工作空间内。'),
      mode: z.enum(['overview', 'text', 'outline', 'stats', 'issues', 'images']).optional().describe('读取模式。默认 overview；正文用 text 分段读取；images 默认只列出嵌入图片 DOM 路径。'),
      start: z.number().optional().describe('text/html 等支持分页/分段模式的起始位置，默认 1。'),
      end: z.number().optional().describe('text/html 等支持分页/分段模式的结束位置。'),
      maxLines: z.number().optional().describe('text 模式最多读取行数，默认 100，最大 300。'),
      maxChars: z.number().optional().describe('返回内容最大字符数，默认 40000，最大 80000。'),
      exportImages: z.boolean().optional().describe('仅 mode=images 有效。true 时通过 officecli get --save 将文档内图片导出到 /context/office-images/...。默认 false。'),
      imagePath: z.string().optional().describe('仅 mode=images 有效。可传 officecli DOM path、图片名称或 relId 片段，只列出/导出匹配图片。'),
      maxImages: z.number().optional().describe('仅 mode=images 有效。最多列出/导出图片数，默认 200，最大 500。'),
    }),
  },
)

// ── PDF Read (shared PDF service) ───────────────────────────────

export const pdfRead = createPdfReadTool({
  getWorkDirService: () => _workDirService,
  getDbService: () => _dbService,
  resolveVfsPath: (inputPath, op, toolName) => _resolveVfsPath(inputPath, op, toolName),
  incrementFileOp: () => {
    _taskCounters.file_op++
    if (_taskCounters.file_op > _taskLimits.file_op) {
      return { success: false, code: 'FILE_OP_LIMIT_REACHED', message: `本任务文件操作次数已达上限 (${_taskLimits.file_op} 次)，请减少文件操作。` }
    }
    return null
  },
})

export const documentRead = createDocumentReadTool({
  getWorkDirService: () => _workDirService,
  getDbService: () => _dbService,
  resolveVfsPath: (inputPath, op, toolName) => _resolveVfsPath(inputPath, op, toolName),
  incrementFileOp: () => {
    _taskCounters.file_op++
    if (_taskCounters.file_op > _taskLimits.file_op) {
      return { success: false, code: 'FILE_OP_LIMIT_REACHED', message: `本任务文件操作次数已达上限 (${_taskLimits.file_op} 次)，请减少文件操作。` }
    }
    return null
  },
  readOffice: (input = {}) => invokeOfficeRead(input, { countFileOp: false, toolName: 'document_read' }),
})

// ── PPTX Export (local, pptxgenjs) ───────────────────────────────

function _isInsideDir(filePath, dirPath) {
  const rel = path.relative(dirPath, filePath)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function _resolvePptxOutputPath(htmlPath, outputPath) {
  const requested = String(outputPath || '').trim()
  if (!requested) {
    return path.join(path.dirname(htmlPath), `${path.basename(htmlPath, path.extname(htmlPath))}.pptx`)
  }

  const resolved = _resolveVfsPath(requested, 'tool_output', 'pptx_export_local').realPath
  const ext = path.extname(resolved).toLowerCase()
  if (!ext) return `${resolved}.pptx`
  if (ext !== '.pptx') throw new Error('outputPath 必须是 .pptx 文件路径')
  return resolved
}

export const pptxExportLocal = tool(
  async ({ htmlPath, outputPath }) => {
    if (!_workDirService) {
      return JSON.stringify({ success: false, code: 'NO_WORKSPACE', message: '未初始化工作空间，无法导出 PPTX。' })
    }

    _taskCounters.file_op++
    if (_taskCounters.file_op > _taskLimits.file_op) {
      return JSON.stringify({ success: false, code: 'FILE_OP_LIMIT_REACHED', message: `本任务文件操作次数已达上限 (${_taskLimits.file_op} 次)，请减少文件操作。` })
    }

    if (!htmlPath) {
      return JSON.stringify({ success: false, code: 'MISSING_HTML_PATH', message: 'pptx_export_local 缺少 htmlPath 参数。' })
    }

    let resolvedHtml
    let resolvedOutput
    try {
      resolvedHtml = _resolveVfsPath(htmlPath, 'read', 'pptx_export_local').realPath
      const htmlExt = path.extname(resolvedHtml).toLowerCase()
      if (!['.html', '.htm'].includes(htmlExt)) {
        return JSON.stringify({ success: false, code: 'UNSUPPORTED_INPUT', message: 'pptx_export_local 仅支持 .html / .htm 输入。', path: htmlPath })
      }
      if (!fs.existsSync(resolvedHtml)) {
        return JSON.stringify({ success: false, code: 'HTML_NOT_FOUND', message: 'HTML 文件不存在。', path: htmlPath })
      }

      resolvedOutput = _resolvePptxOutputPath(resolvedHtml, outputPath)
      const agentsRoot = path.join(_workDirService.getRootPath(), 'agents')
      if (!_isInsideDir(resolvedOutput, agentsRoot)) {
        return JSON.stringify({ success: false, code: 'OUTPUT_SCOPE_DENIED', message: 'PPTX 导出只能写入 /agents/ 下的 Agent 输出目录。' })
      }
      fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true })
      _resolveVfsPath(resolvedOutput, 'tool_output', 'pptx_export_local')
    } catch (e) {
      return JSON.stringify({ success: false, code: 'PATH_NOT_ALLOWED', message: `安全限制：${e.message}` })
    }

    try {
      const exporter = new PptxExportService()
      const result = await exporter.exportLocal(resolvedHtml, resolvedOutput)
      return JSON.stringify({
        success: true,
        path: _toVirtualWorkspacePath(resolvedOutput),
        slideCount: result.slideCount || 0,
      })
    } catch (e) {
      return JSON.stringify({ success: false, code: 'PPTX_EXPORT_FAILED', message: e.message })
    }
  },
  {
    name: 'pptx_export_local',
    description: [
      '将 Agent 输出目录中的 HTML 演示文稿导出为可编辑的 PPTX 文件。',
      'htmlPath 必须是授权工作空间内的 .html/.htm 文件；outputPath 可省略，默认与 HTML 同目录同名 .pptx。',
      '输出路径只能位于当前 Agent 的 /agents/{agent}/outputs/ 下，返回 JSON {success, path, slideCount}。',
    ].join('\n'),
    schema: z.object({
      htmlPath: z.string().describe('HTML 演示文稿路径，如 /agents/ppt-generator/outputs/2026-06-03/demo.html'),
      outputPath: z.string().optional().describe('输出 PPTX 路径，必须位于 /agents/ 下；省略则与 HTML 同目录同名 .pptx'),
    }),
  },
)

export const wikiTool = tool(
  async (input = {}) => {
    if (!_wikiService?.wikiTool) {
      return JSON.stringify({
        success: false,
        code: 'WIKI_NOT_AVAILABLE',
        message: '本地 LLM-Wiki 服务不可用或工作区尚未初始化。',
      })
    }
    const runWikiContext = _toolRunContext.wikiContext || {}
    const allowedWikiIds = Array.isArray(runWikiContext.wikiIds)
      ? runWikiContext.wikiIds.filter(Boolean)
      : []
    const result = await _wikiService.wikiTool({
      ...(input || {}),
      wikiContext: runWikiContext,
      allowedWikiIds,
      enforceWikiSelection: true,
      allowWrite: false,
    })
    return JSON.stringify(result)
  },
  {
    name: 'wiki_tool',
    description: [
      '只读查询本地 LLM-Wiki 的统一工具。普通聊天 Agent 不能写入 Wiki。',
      '只能访问用户在本轮聊天输入区选择的 Wiki；未选择 Wiki 时不能读取任何 Wiki。模型传入 wikiIds 只能在已选择范围内缩小，不能扩大到全部 Wiki。',
      '先用 action=list_wikis 查看本轮允许访问的 Wiki；聊天界面选择了 Wiki 时，可直接用 search_wikis/query_wikis，系统会使用默认范围。',
      '常用动作：query_wikis 会先读取 index.md/overview.md 导航页，返回导航链接、优先页面和兜底搜索结果；search_wikis 是显式关键词兜底搜索；read_page/read_source 用于深读具体页面或来源。',
      '回答用户问题时必须引用 wiki_name、页面路径、source_id 或图片路径。',
    ].join('\n'),
    schema: z.object({
      action: z.enum([
        'list_wikis',
        'search',
        'search_wikis',
        'query_wikis',
        'list_pages',
        'read_page',
        'list_sources',
        'read_source',
        'list_assets',
        'recent_changes',
      ]).describe('要执行的 Wiki 动作。'),
      wikiId: z.string().optional().describe('Wiki id。action=list_wikis 不需要。'),
      wikiIds: z.array(z.string()).optional().describe('跨 Wiki 查询的 Wiki id 列表；不传时使用聊天界面选择的默认范围。'),
      query: z.string().optional().describe('search 动作的检索问题。'),
      scope: z.enum(['all', 'pages', 'sources', 'wiki', 'source', 'assets']).optional().describe('search 范围。'),
      limit: z.number().optional().describe('返回数量上限。'),
      maxChars: z.number().optional().describe('query_wikis 返回上下文最大字符数。'),
      pagePath: z.string().optional().describe('read_page 的相对 Markdown 路径，如 index.md 或 pages/concepts/topic.md。'),
      sourceId: z.string().optional().describe('read_source 的来源 id。'),
      kind: z.string().optional().describe('list_assets 的资产类型过滤，例如 ocr_image 或 source_image。'),
    }),
  },
)

// ── Aggregate custom tools ──────────────────────────────────────

const MCP_TOOL_OUTPUT_LIMIT = 60000

function _clipMcpText(value, limit = MCP_TOOL_OUTPUT_LIMIT) {
  const text = String(value || '')
  return text.length > limit ? `${text.slice(0, limit)}\n\n[内容已截断：超过 ${limit} 字符]` : text
}

function _mcpServerAllowed(serverId) {
  const allowed = _toolRunContext.mcpServerIds || []
  return allowed.includes(String(serverId || ''))
}

export const mcpResourceRead = tool(
  async (input = {}) => {
    const serverId = String(input.serverId || '').trim()
    const uri = String(input.uri || '').trim()
    if (!_mcpService?.readResource) {
      return JSON.stringify({ success: false, code: 'MCP_NOT_AVAILABLE', message: 'MCP 服务不可用。' })
    }
    if (!serverId || !uri) {
      return JSON.stringify({ success: false, code: 'TOOL_INVALID_ARGUMENT', message: 'serverId 和 uri 不能为空。' })
    }
    if (!_mcpServerAllowed(serverId)) {
      return JSON.stringify({ success: false, code: 'TOOL_OPERATION_NOT_ALLOWED', message: `当前 Agent 未绑定 MCP 服务器：${serverId}` })
    }
    const result = await _mcpService.readResource(serverId, uri)
    if (!result?.success) {
      return JSON.stringify({ success: false, code: 'MCP_RESOURCE_READ_FAILED', message: result?.error || '读取 MCP resource 失败。', serverId, uri })
    }
    return JSON.stringify({
      success: true,
      operation: 'read_resource',
      serverId,
      uri,
      contents: (result.contents || []).map(c => ({
        uri: c.uri,
        mimeType: c.mimeType || '',
        text: c.text ? _clipMcpText(c.text) : '',
        blob: c.blob ? _clipMcpText(c.blob, 12000) : '',
      })),
    })
  },
  {
    name: 'mcp_resource_read',
    description: [
      '读取当前 Agent 已绑定 MCP 服务器暴露的 resource 内容。',
      '先查看 MCP 管理页或已同步缓存中的 resource uri；resourceTemplates 需要先填好参数形成具体 uri。',
      '只能读取当前 Agent 工具配置中已绑定的 mcp:{serverId} 服务器。',
    ].join('\n'),
    schema: z.object({
      serverId: z.string().describe('MCP 服务器 ID，对应 Agent 工具里的 mcp:{serverId}。'),
      uri: z.string().describe('要读取的 MCP resource URI。'),
    }),
  },
)

export const mcpPromptGet = tool(
  async (input = {}) => {
    const serverId = String(input.serverId || '').trim()
    const name = String(input.name || '').trim()
    const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments) ? input.arguments : {}
    if (!_mcpService?.getPrompt) {
      return JSON.stringify({ success: false, code: 'MCP_NOT_AVAILABLE', message: 'MCP 服务不可用。' })
    }
    if (!serverId || !name) {
      return JSON.stringify({ success: false, code: 'TOOL_INVALID_ARGUMENT', message: 'serverId 和 name 不能为空。' })
    }
    if (!_mcpServerAllowed(serverId)) {
      return JSON.stringify({ success: false, code: 'TOOL_OPERATION_NOT_ALLOWED', message: `当前 Agent 未绑定 MCP 服务器：${serverId}` })
    }
    const result = await _mcpService.getPrompt(serverId, name, args)
    if (!result?.success) {
      return JSON.stringify({ success: false, code: 'MCP_PROMPT_GET_FAILED', message: result?.error || '获取 MCP prompt 失败。', serverId, name })
    }
    return JSON.stringify({
      success: true,
      operation: 'get_prompt',
      serverId,
      name,
      description: result.description || '',
      messages: (result.messages || []).map(m => ({
        role: m.role,
        content: m.content?.type === 'text'
          ? { ...m.content, text: _clipMcpText(m.content.text) }
          : m.content,
      })),
    })
  },
  {
    name: 'mcp_prompt_get',
    description: [
      '获取当前 Agent 已绑定 MCP 服务器提供的 prompt 模板实例。',
      '用于把 MCP prompt 转成可执行的消息内容；需要按该 prompt 的 arguments 填参数。',
      '只能访问当前 Agent 工具配置中已绑定的 mcp:{serverId} 服务器。',
    ].join('\n'),
    schema: z.object({
      serverId: z.string().describe('MCP 服务器 ID，对应 Agent 工具里的 mcp:{serverId}。'),
      name: z.string().describe('MCP prompt 名称。'),
      arguments: z.record(z.string(), z.any()).optional().describe('prompt 参数对象。'),
    }),
  },
)

// 鈹€鈹€ Skill Install 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function _skillDbPayload(skillId, config, promptContent) {
  return {
    id: skillId,
    name: config.name || skillId,
    icon: config.icon,
    color: config.color,
    description: config.description,
    prompt_template: promptContent || '',
    prompt_content: promptContent || '',
    output_types: config.outputTypes || [],
    allowed_tools: config.allowedTools || [],
    source: 'custom',
    category: config.category || '',
    version: config.version || '',
    author: config.author || '',
    license: config.license || '',
    builtin: 0,
    enabled: 1,
  }
}

function _cloneGitRepo(repoUrl, targetDir, options = {}) {
  return new Promise((resolve) => {
    const gitArgs = options.noProxy ? ['-c', 'http.proxy=', '-c', 'https.proxy=', 'clone', '--depth', '1', repoUrl, targetDir] : ['clone', '--depth', '1', repoUrl, targetDir]
    const child = spawn('git', gitArgs, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); resolve(result) }
    const timer = setTimeout(() => { try { child.kill() } catch {} finish({ error: new Error('git clone timeout (60s)'), stdout, stderr }) }, 60000)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', err => finish({ error: err, stdout, stderr }))
    child.on('close', code => finish({ error: code !== 0 ? new Error(`git clone exited with code ${code}`) : null, stdout, stderr }))
  })
}

const GITHUB_MIRRORS = [
  '',
  'https://gh-proxy.com/',
  'https://mirror.ghproxy.com/',
  'https://ghproxy.net/',
]

function _parseGitHubUrl(url) {
  // Accept: https://github.com/owner/repo, https://github.com/owner/repo.git,
  //         https://github.com/owner/repo/tree/branch, https://github.com/owner/repo/refs/heads/branch
  const m = String(url || '').match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|refs\/heads)\/([^/]+))?\/?$/)
  if (!m) return null
  return { owner: m[1], repo: m[2], branch: m[3] || 'main' }
}

function _normalizeGitUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url) && /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(url) && !/[:\\]/.test(url)) {
    return 'https://github.com/' + url
  }
  return url
}
async function _downloadZip(zipUrl, destPath, timeoutMs) {
  const resp = await fetch(zipUrl, {
    signal: AbortSignal.timeout(timeoutMs || 30000),
    redirect: 'follow',
  })
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + resp.statusText)
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length < 100) throw new Error('Downloaded file too small (' + buf.length + ' bytes), likely an error page')
  await fs.promises.writeFile(destPath, buf)
  return buf.length
}

async function _cloneOrDownload(repoUrl, tempDir) {
  // Try git clone first
  const cloneResult = await _cloneGitRepo(repoUrl, tempDir)
  if (!cloneResult.error) return { method: 'git', path: tempDir }

  const gitErr = cloneResult.error.message || ''
  const isGitMissing = /ENOENT|not found|spawn/i.test(gitErr) && !/Repository|404|exist/i.test(gitErr)

  const stderrMsg = cloneResult.stderr || ''
  const combined = gitErr + ' ' + stderrMsg
  const isNetworkError = /Failed to connect|Couldnt connect|Connection refused|Could not resolve host|port \d+ after/i.test(combined)

  if (!isGitMissing && isNetworkError && !/timeout/i.test(gitErr)) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    await fs.promises.mkdir(tempDir, { recursive: true })
    console.log('[skillInstall] Git clone failed (proxy/network), retrying without proxy...')
    const retryResult = await _cloneGitRepo(repoUrl, tempDir, { noProxy: true })
    if (!retryResult.error) return { method: 'git', path: tempDir }
    console.warn('[skillInstall] Retry without proxy also failed:', retryResult.error.message)
  }

  // If git is available but clone failed for other reasons (repo not found, auth), don't retry with zip
  if (!isGitMissing && !isNetworkError && !/timeout/i.test(gitErr)) {
    return { method: 'git', error: cloneResult.error, stderr: cloneResult.stderr }
  }

  // Fallback: download ZIP from GitHub
  const gh = _parseGitHubUrl(repoUrl)
  if (!gh) {
    // Not a GitHub URL and git is unavailable
    return {
      method: 'git',
      error: new Error(gitErr + '。非 GitHub URL 且 git 不可用，无法下载 ZIP 降级。请安装 git 或手动下载后用 install_path 安装'),
      stderr: cloneResult.stderr,
    }
  }

  const zipPath = path.join(os.tmpdir(), 'reviva-skill-' + Date.now() + '.zip')
  // Try branch from URL first, then common defaults. Use simple archive/{ref}.zip format
  // which works for both branches and tags.
  const branchCandidates = [...new Set([gh.branch, 'main', 'master'])]
  let lastError = null
  let downloaded = false

  for (const branch of branchCandidates) {
    if (downloaded) break
    const archiveSlug = 'archive/' + branch + '.zip'
    for (const mirror of GITHUB_MIRRORS) {
      const fullUrl = mirror
        ? mirror + 'https://github.com/' + gh.owner + '/' + gh.repo + '/' + archiveSlug
        : 'https://github.com/' + gh.owner + '/' + gh.repo + '/' + archiveSlug
      try {
        const size = await _downloadZip(fullUrl, zipPath, 60000)
        console.log('[skillInstall] Downloaded ZIP via', mirror || 'direct', 'branch=' + branch, '-', size, 'bytes')
        return { method: 'zip', path: zipPath, isZip: true }
      } catch (err) {
        lastError = err
        console.warn('[skillInstall] ZIP download failed via', mirror || 'direct', 'branch=' + branch, ':', err.message)
      }
    }
  }

  // All mirrors failed
  return {
    method: 'zip',
    error: new Error((isGitMissing ? 'git 不可用且 ' : '') + 'ZIP 下载失败: ' + (lastError?.message || 'unknown') + '。请手动下载 ZIP 后用 install_path 安装，或配置代理后重试'),
    stderr: cloneResult.stderr,
  }
}

export const skillInstall = tool(
  async (input = {}) => {
    if (!_skillService) return JSON.stringify({ success: false, error: 'SkillService 未初始化' })
    const action = String(input.action || '').trim()
    try {
      switch (action) {
        case 'list': {
          const builtin = await _skillService.listBuiltinSkills()
          const dbSkills = _dbService?.listSkills?.() || []
          const installedIds = new Set(dbSkills.map(s => s.id))
          return JSON.stringify({
            success: true,
            installed: dbSkills.map(s => ({
              id: s.id, name: s.name || s.id, description: s.description || '',
              source: s.source || 'custom', enabled: s.enabled !== 0,
            })),
            builtinAvailable: builtin.filter(b => !installedIds.has(b.id)).map(b => ({
              id: b.id, name: b.name || b.id, description: b.description || '',
            })),
          })
        }
        case 'install_url': {
          const url = _normalizeGitUrl(input.url)
          if (!url) return JSON.stringify({ success: false, error: '缺少 url 参数' })
          if (!/^https?:\/\//.test(url)) return JSON.stringify({ success: false, error: 'url 必须是 http/https 开头的 Git 仓库地址' })
          const repoName = url.replace(/\.git$/, '').split('/').pop() || 'skill'
          const skillId = _skillService.normalizeSkillId(input.skillId || repoName)
          if (!_skillService.isValidSkillId(skillId)) return JSON.stringify({ success: false, error: `无效的 Skill ID: ${skillId}` })
          if (_skillService.isBuiltinSkillId(skillId)) return JSON.stringify({ success: false, error: `不能覆盖内置 Skill: ${skillId}` })
          if (_skillService.isInstalled(skillId)) return JSON.stringify({ success: false, error: `Skill "${skillId}" 已存在`, conflict: true })
          const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reviva-skill-clone-'))
          const fetchResult = await _cloneOrDownload(url, tempDir)
          if (fetchResult.error) {
            await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
            return JSON.stringify({ success: false, error: fetchResult.error.message, stderr: (fetchResult.stderr || '').slice(0, 500) })
          }
          // Unify: for zip, extract first; for git clone, scan directly
          let scanDir = tempDir
          let zipExtractedDir = null
          if (fetchResult.isZip) {
            try {
              zipExtractedDir = await _skillService._extractZip(fetchResult.path)
              scanDir = zipExtractedDir
            } catch (err) {
              await fs.promises.rm(fetchResult.path, { force: true }).catch(() => {})
              return JSON.stringify({ success: false, error: 'ZIP 解压失败: ' + err.message })
            }
            // GitHub ZIPs wrap contents in repo-branch/ directory — descend if needed
            if (!fs.existsSync(path.join(scanDir, 'SKILL.md'))) {
              const entries = await fs.promises.readdir(scanDir, { withFileTypes: true })
              const dirs = entries.filter(e => e.isDirectory())
              if (dirs.length === 1) scanDir = path.join(scanDir, dirs[0].name)
            }
          }
          const installed = []
          const hasRootSkill = fs.existsSync(path.join(scanDir, 'SKILL.md'))
          if (hasRootSkill) {
            try {
              const result = await _skillService.importSkillSource(scanDir, { id: skillId, source: 'custom', sourceUrl: url })
              installed.push({ skillId, ...result })
            } catch (err) {
              console.warn('[skillInstall] Import failed:', err.message)
            }
          } else {
            // Multi-skill repo: find subdirs with SKILL.md
            const entries = await fs.promises.readdir(scanDir, { withFileTypes: true })
            for (const entry of entries) {
              if (!entry.isDirectory() || entry.name.startsWith('.')) continue
              if (!fs.existsSync(path.join(scanDir, entry.name, 'SKILL.md'))) continue
              const subId = _skillService.normalizeSkillId(entry.name)
              if (_skillService.isBuiltinSkillId(subId) || _skillService.isInstalled(subId)) continue
              try {
                const result = await _skillService.importSkillSource(path.join(scanDir, entry.name), { id: subId, source: 'custom', sourceUrl: url })
                installed.push({ skillId: subId, ...result })
              } catch (err) {
                console.warn(`[skillInstall] Failed to import ${subId}:`, err.message)
              }
            }
          }
          await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
          if (zipExtractedDir) await fs.promises.rm(zipExtractedDir, { recursive: true, force: true }).catch(() => {})
          if (fetchResult.isZip) await fs.promises.rm(fetchResult.path, { force: true }).catch(() => {})
          if (!installed.length) return JSON.stringify({ success: false, error: '仓库中未找到有效的 Skill（缺少 SKILL.md）' })
          // Sync each to DB
          const results = []
          for (const item of installed) {
            if (!item.spec?.valid) { results.push({ skillId: item.skillId, success: false, issues: item.spec?.issues }); continue }
            const promptResult = await _skillService.readSkillFile(item.skillId, 'SKILL.md')
            const promptContent = promptResult.success ? promptResult.data : ''
            const dbPayload = _skillDbPayload(item.skillId, item.config, promptContent)
           const existing = (_dbService?.listSkills?.() || []).find(s => s.id === item.skillId)
           if (existing) _dbService?.updateSkill?.(item.skillId, dbPayload)
           else _dbService?.createSkill?.(dbPayload)
            let adaptation = null
            try { adaptation = await _skillService.adaptExternalSkill(item.skillId) } catch (e) { console.warn('[skillInstall] Adaptation scan failed:', e.message) }
            results.push({ skillId: item.skillId, success: true, name: item.config?.name || item.skillId, description: item.config?.description || '', adaptation })
         }
          const needsAttention = results.some(r => r.adaptation?.needsAttention)
          let adaptHint = ''
          if (needsAttention) adaptHint = ' 部分安装的 Skill 引用了非 Reviva 工具或平台路径，可能需要适配后才能正常使用。'
          return JSON.stringify({ success: true, results, message: `安装了 ${results.length} 个 Skill。建议关闭并重新打开 Reviva 使新 Skill 完全生效，或在 Agent 设置中手动绑定。${adaptHint}` })
        }
        case 'install_path': {
          const sourcePath = String(input.sourcePath || input.path || '').trim()
          if (!sourcePath) return JSON.stringify({ success: false, error: '缺少 sourcePath 参数' })
          const customSkills = (_dbService?.listSkills?.() || []).filter(s => s.source !== 'platform')
          const preview = await _skillService.inspectSkillSource(sourcePath, { customSkills })
          const skillId = _skillService.normalizeSkillId(input.skillId || preview.id)
          if (!_skillService.isValidSkillId(skillId)) return JSON.stringify({ success: false, error: `无效的 Skill ID: ${skillId}` })
          if (_skillService.isBuiltinSkillId(skillId)) return JSON.stringify({ success: false, error: `不能覆盖内置 Skill: ${skillId}` })
          if (_skillService.isInstalled(skillId)) return JSON.stringify({ success: false, error: `Skill "${skillId}" 已存在`, conflict: true, preview })
          const result = await _skillService.importSkillSource(sourcePath, { id: skillId, source: 'custom', sourceUrl: url })
          if (!result.spec?.valid) return JSON.stringify({ success: false, error: result.spec?.issues?.join('; ') || 'Skill 验证失败', spec: result.spec })
          const promptResult = await _skillService.readSkillFile(skillId, 'SKILL.md')
          const promptContent = promptResult.success ? promptResult.data : ''
          const dbPayload = _skillDbPayload(skillId, result.config, promptContent)
         _dbService?.createSkill?.(dbPayload)
          let adaptation = null
          try { adaptation = await _skillService.adaptExternalSkill(skillId) } catch (e) { console.warn('[skillInstall] Adaptation scan failed:', e.message) }
          let adaptHint = adaptation?.needsAttention ? ` 该 Skill 可能引用了非 Reviva 工具或平台路径，检查 adaptation 报告中的警告。` : ''
          return JSON.stringify({ success: true, skillId, name: result.config?.name || skillId, description: result.config?.description || '', spec: result.spec, adaptation, message: `Skill "${skillId}" 安装成功。建议关闭并重新打开 Reviva 使新 Skill 完全生效，或在 Agent 设置中手动绑定。${adaptHint}` })
        }
        case 'create': {
          const skillId = _skillService.normalizeSkillId(input.skillId || input.id || '')
          if (!_skillService.isValidSkillId(skillId)) return JSON.stringify({ success: false, error: `无效的 Skill ID: ${skillId}` })
          if (_skillService.isBuiltinSkillId(skillId)) return JSON.stringify({ success: false, error: `不能覆盖内置 Skill: ${skillId}` })
          if (_skillService.isInstalled(skillId)) return JSON.stringify({ success: false, error: `Skill "${skillId}" 已存在`, conflict: true })
          const skillData = {
            name: input.name || skillId,
            description: input.description || '',
            promptContent: input.promptContent || input.content || '',
            source: 'custom',
            icon: input.icon || 'ri-brain-line',
            color: input.color || '#6C8AFF',
            category: input.category || '',
            allowedTools: input.allowedTools || [],
            outputTypes: input.outputTypes || [],
            version: input.version || '1.0',
            author: input.author || '',
          }
          const result = await _skillService.installSkill(skillId, skillData)
          const promptResult = await _skillService.readSkillFile(skillId, 'SKILL.md')
          const promptContent = promptResult.success ? promptResult.data : ''
          _dbService?.createSkill?.(_skillDbPayload(skillId, result.config, promptContent))
          return JSON.stringify({ success: true, skillId, name: result.config?.name || skillId, description: result.config?.description || '', spec: result.spec, message: `Skill "${skillId}" 创建成功。建议关闭并重新打开 Reviva 使新 Skill 完全生效，或在 Agent 设置中手动绑定。` })
        }
        case 'validate': {
          const skillId = _skillService.normalizeSkillId(input.skillId || '')
          if (!_skillService.isValidSkillId(skillId)) return JSON.stringify({ success: false, error: '缺少或无效的 skillId' })
          const spec = _skillService.validateSkillSpec(skillId)
          return JSON.stringify({ success: true, skillId, spec })
        }
        case 'info': {
          const skillId = _skillService.normalizeSkillId(input.skillId || '')
          if (!_skillService.isValidSkillId(skillId)) return JSON.stringify({ success: false, error: '缺少或无效的 skillId' })
          const relativePath = input.filePath || 'SKILL.md'
          const result = await _skillService.readSkillFile(skillId, relativePath)
          if (!result.success) return JSON.stringify({ success: false, error: result.error })
          return JSON.stringify({ success: true, skillId, filePath: relativePath, content: result.data })
        }
        case 'uninstall': {
          const skillId = _skillService.normalizeSkillId(input.skillId || '')
          if (!_skillService.isValidSkillId(skillId)) return JSON.stringify({ success: false, error: '缺少或无效的 skillId' })
          if (_skillService.isBuiltinSkillId(skillId)) return JSON.stringify({ success: false, error: `不能删除内置 Skill: ${skillId}` })
          const existing = (_dbService?.listSkills?.() || []).find(s => s.id === skillId)
          if (existing?.source === 'platform' || existing?.builtin) return JSON.stringify({ success: false, error: `不能删除内置 Skill: ${skillId}` })
          await _skillService.uninstallSkill(skillId)
          _dbService?.deleteSkill?.(skillId)
          return JSON.stringify({ success: true, skillId, message: `Skill "${skillId}" 已删除` })
        }

        case 'update': {
          const skillId = _skillService.normalizeSkillId(input.skillId || '')
          if (!_skillService.isValidSkillId(skillId)) return JSON.stringify({ success: false, error: '缺少或无效的 skillId。请提供合法的 Skill ID（小写字母、数字、连字符）' })
          if (_skillService.isBuiltinSkillId(skillId)) return JSON.stringify({ success: false, error: '内置 Skill 不能通过此方式更新: ' + skillId + '。内置 Skill 随应用更新自动刷新' })
          if (!_skillService.isInstalled(skillId)) return JSON.stringify({ success: false, error: 'Skill "' + skillId + '" 未安装，请先使用 install_url 安装' })
          const url = _normalizeGitUrl(input.url)
          if (!url) return JSON.stringify({ success: false, error: '更新需要提供 url（GitHub 仓库地址）。如果不记得 URL，请用 list 查看已安装的 Skill，或请用户提供' })
          if (!/^https?:\/\//.test(url)) return JSON.stringify({ success: false, error: 'url 必须是 http/https 开头的 Git 仓库地址' })

          const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reviva-skill-update-'))
          const fetchResult = await _cloneOrDownload(url, tempDir)
          if (fetchResult.error) {
            await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
            return JSON.stringify({ success: false, error: fetchResult.error.message, stderr: (fetchResult.stderr || '').slice(0, 500) })
          }

          // Determine source path: for zip, importSkillSource handles extraction; for git, scan directory
          let sourcePath = fetchResult.isZip ? fetchResult.path : tempDir
          if (!fetchResult.isZip && !fs.existsSync(path.join(tempDir, 'SKILL.md'))) {
            const subDir = path.join(tempDir, skillId)
            if (fs.existsSync(path.join(subDir, 'SKILL.md'))) {
              sourcePath = subDir
            } else {
              const entries = await fs.promises.readdir(tempDir, { withFileTypes: true })
              const skillSubdir = entries.find(e => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(tempDir, e.name, 'SKILL.md')))
              if (skillSubdir) {
                sourcePath = path.join(tempDir, skillSubdir.name)
              } else {
                await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
                return JSON.stringify({ success: false, error: '仓库中未找到与 "' + skillId + '" 匹配的 Skill（缺少 SKILL.md）。请检查仓库结构或确认 Skill ID 是否正确' })
              }
            }
          }

          try {
            const result = await _skillService.importSkillSource(sourcePath, { id: skillId, source: 'custom' })
            await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
            if (fetchResult.isZip) await fs.promises.rm(fetchResult.path, { force: true }).catch(() => {})
            if (!result.spec?.valid) return JSON.stringify({ success: false, error: result.spec?.issues?.join('; ') || 'Skill 验证失败，请检查 SKILL.md 是否符合规范', spec: result.spec })
            const promptResult = await _skillService.readSkillFile(skillId, 'SKILL.md')
            const promptContent = promptResult.success ? promptResult.data : ''
            const dbPayload = _skillDbPayload(skillId, result.config, promptContent)
           _dbService?.updateSkill?.(skillId, dbPayload)
            let adaptation = null
            try { adaptation = await _skillService.adaptExternalSkill(skillId) } catch (e) { console.warn('[skillInstall] Adaptation scan failed:', e.message) }
            let adaptHint = adaptation?.needsAttention ? ' 该 Skill 可能引用了非 Reviva 工具或平台路径，检查 adaptation 报告中的警告。' : ''
            return JSON.stringify({ success: true, skillId, name: result.config?.name || skillId, description: result.config?.description || '', spec: result.spec, adaptation, message: 'Skill "' + skillId + '" 更新成功。建议关闭并重新打开 Reviva 使更新完全生效。' + adaptHint })
          } catch (err) {
            await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
            return JSON.stringify({ success: false, error: '更新失败: ' + err.message })
          }
        }
        default:
          return JSON.stringify({ success: false, error: `未知操作: ${action}。可用: list, install_url, install_path, create, validate, info, uninstall, update` })
      }
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message })
    }
  },
  {
    name: 'skill_install',
    description: [
      '安装、创建和管理 Reviva Skills。当用户说"安装 skill""帮我安装 xxx""我下载了 skill""创建一个 skill"时使用。',
      '操作：list=列出已安装和可用内置 Skills；install_url=从 GitHub URL 克隆安装（自动 clone，无 git 时自动下载 ZIP）；install_path=从本地文件夹/ZIP 导入；create=从名称和内容创建新 Skill；validate=验证 Skill 结构；info=读取 Skill 文件；uninstall=删除自定义 Skill。；update=从 GitHub URL 重新拉取并更新已安装的 Skill。',
    ].join('\n'),
    schema: z.object({
      action: z.enum(['list', 'install_url', 'install_path', 'create', 'validate', 'info', 'uninstall', 'update']).describe('要执行的 Skill 操作'),
      url: z.string().optional().describe('install_url/update: GitHub 仓库 URL'),
      sourcePath: z.string().optional().describe('install_path: 本地文件夹或 ZIP 文件绝对路径'),
      skillId: z.string().optional().describe('Skill ID（小写字母、数字、连字符），不传时从来源自动推断'),
      name: z.string().optional().describe('create: Skill 显示名称'),
      description: z.string().optional().describe('create: Skill 触发描述'),
      promptContent: z.string().optional().describe('create: SKILL.md 正文内容'),
      content: z.string().optional().describe('create: 同 promptContent'),
      icon: z.string().optional().describe('create: 图标'),
      color: z.string().optional().describe('create: 颜色'),
      category: z.string().optional().describe('create: 分类'),
      allowedTools: z.array(z.string()).optional().describe('create: 允许的工具 ID 列表'),
      outputTypes: z.array(z.string()).optional().describe('create: 输出类型'),
      version: z.string().optional().describe('create: 版本号'),
      author: z.string().optional().describe('create: 作者'),
      filePath: z.string().optional().describe('info: 要读取的文件相对路径（默认 SKILL.md）'),
    }),
  },
)

const CUSTOM_TOOLS = [execCommand, webSearchTavily, webSearchSearxng, webSearchBing, kbSearch, wikiTool, noteTool, calculator, deleteFile, documentRead, mediaRead, officeRead, pdfRead, visionAnalyze, pptxExportLocal, mcpResourceRead, mcpPromptGet, skillInstall]
const TOOL_ID_ALIASES = {
  file_delete: 'delete_file',
}

const CUSTOM_SCRIPT_TOOLS_ENABLED = false
const CUSTOM_TOOL_OUTPUT_LIMIT = 30000
const CUSTOM_SCRIPT_MAX_BUFFER = 1024 * 1024
const CUSTOM_SCRIPT_TIMEOUT_MS = 30000
const CUSTOM_SCRIPT_EXTS = new Set(['.py', '.js', '.mjs', '.cjs'])

function _clipOutput(value, limit = CUSTOM_TOOL_OUTPUT_LIMIT) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text || text.length <= limit) return { text: text || '', truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

function _normalizeCustomToolRecord(row) {
  return {
    id: row?.id || '',
    name: row?.name || row?.id || '自定义工具',
    description: row?.description || row?.desc || '',
    type: row?.type || 'api',
    apiUrl: row?.apiUrl || row?.api_url || '',
    method: String(row?.method || 'POST').toUpperCase(),
    headers: row?.headers || {},
    params: Array.isArray(row?.params) ? row.params : [],
    responseFormat: row?.responseFormat || row?.response_format || 'JSON',
    scriptPath: row?.scriptPath || row?.script_path || '',
    permReq: row?.permReq || row?.perm_required || '',
    enabled: row?.enabled !== false && row?.enabled !== 0,
  }
}

function _customToolSchema(params = []) {
  const shape = {}
  for (const p of params) {
    const name = String(p?.name || '').trim()
    if (!name) continue
    let schema = z.any()
    if (p?.desc) schema = schema.describe(String(p.desc))
    shape[name] = p?.required ? schema : schema.optional()
  }
  return z.object(shape).passthrough()
}

function _normalizeHeaders(headers) {
  const parsed = typeof headers === 'string'
    ? (() => { try { return JSON.parse(headers) } catch { return {} } })()
    : headers
  const out = {}
  for (const [key, value] of Object.entries(parsed || {})) {
    if (!key || value === undefined || value === null || value === '') continue
    out[key] = String(value)
  }
  return out
}

function _hasToolPermission(required) {
  if (!required) return true
  const permissions = _toolRunContext.permissions
  if (!permissions || !Object.prototype.hasOwnProperty.call(permissions, required)) return true
  return !!permissions[required]
}

async function _runApiCustomTool(def, input = {}) {
  if (!def.apiUrl) {
    return JSON.stringify({ success: false, code: 'CUSTOM_TOOL_NOT_CONFIGURED', message: '自定义 API 工具缺少 API URL。' })
  }
  if (!_hasToolPermission(def.permReq)) {
    return JSON.stringify({ success: false, code: 'TOOL_PERMISSION_DENIED', message: `当前 Agent 未开启 ${def.permReq} 权限。` })
  }

  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(def.method) ? def.method : 'POST'

  try {
    const url = new URL(def.apiUrl)
    const headers = _normalizeHeaders(def.headers)
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(30000),
    }

    if (method === 'GET') {
      for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null) continue
        url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
      }
    } else {
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json'
      }
      init.body = JSON.stringify(args)
    }

    const resp = await fetch(url, init)
    const contentType = resp.headers.get('content-type') || ''
    const raw = await resp.text()
    let body = raw
    if (contentType.includes('application/json')) {
      try { body = JSON.parse(raw) } catch { body = raw }
    }
    const clipped = _clipOutput(body)
    return JSON.stringify({
      success: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      contentType,
      body: clipped.text,
      truncated: clipped.truncated,
    })
  } catch (e) {
    return JSON.stringify({ success: false, code: 'CUSTOM_API_TOOL_FAILED', message: e.message })
  }
}

function _scriptRunnerFor(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.py') return { command: 'python', args: [filePath], kind: 'python' }
  if (['.js', '.mjs', '.cjs'].includes(ext)) return { command: 'node', args: [filePath], kind: 'node' }
  return null
}

async function _runScriptCustomTool(def, input = {}) {
  if (!CUSTOM_SCRIPT_TOOLS_ENABLED) {
    return JSON.stringify({ success: false, code: 'CUSTOM_SCRIPT_TOOL_DISABLED', message: '自定义脚本工具暂未开放运行。' })
  }
  const required = def.permReq || 'execCommand'
  if (!_hasToolPermission(required)) {
    return JSON.stringify({ success: false, code: 'TOOL_PERMISSION_DENIED', message: `当前 Agent 未开启 ${required} 权限。` })
  }
  if (!_workDirService) {
    return JSON.stringify({ success: false, code: 'NO_WORKSPACE', message: '未初始化工作空间，无法执行自定义脚本工具。' })
  }
  if (!def.scriptPath) {
    return JSON.stringify({ success: false, code: 'CUSTOM_TOOL_NOT_CONFIGURED', message: '自定义脚本工具缺少脚本路径。' })
  }

  let resolved
  try {
    resolved = _workDirService.resolveAndValidate(def.scriptPath, 'any')
  } catch (e) {
    return JSON.stringify({ success: false, code: 'TOOL_INPUT_NOT_ALLOWED', message: `安全限制：${e.message}` })
  }

  const normalized = resolved.replace(/\\/g, '/').toLowerCase()
  if (normalized.includes('/.reviva/')) {
    return JSON.stringify({ success: false, code: 'TOOL_INPUT_NOT_ALLOWED', message: '安全限制：自定义脚本不能位于系统元数据目录。' })
  }
  if (!fs.existsSync(resolved)) {
    return JSON.stringify({ success: false, code: 'FILE_NOT_FOUND', message: '自定义脚本文件不存在。' })
  }
  const ext = path.extname(resolved).toLowerCase()
  if (!CUSTOM_SCRIPT_EXTS.has(ext)) {
    return JSON.stringify({ success: false, code: 'UNSUPPORTED_SCRIPT_TYPE', message: '自定义脚本工具当前仅支持 .py、.js、.mjs、.cjs。' })
  }

  const runner = _scriptRunnerFor(resolved)
  const validationError = _validateCommand(`${runner.command} ${resolved}`)
  if (validationError) {
    return JSON.stringify({ success: false, exitCode: 126, stdout: '', stderr: validationError })
  }

  return new Promise((resolve) => {
    const child = spawn(runner.command, runner.args, {
      cwd: path.dirname(resolved),
      shell: false,
      windowsHide: true,
      env: { ...process.env },
    })
    const stdoutChunks = []
    const stderrChunks = []
    let stdoutSize = 0
    let stderrSize = 0
    let done = false

    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(JSON.stringify(result))
    }

    const append = (chunks, data, kind) => {
      if (kind === 'stdout') {
        stdoutSize += data.length
        if (stdoutSize <= CUSTOM_SCRIPT_MAX_BUFFER) chunks.push(data)
      } else {
        stderrSize += data.length
        if (stderrSize <= CUSTOM_SCRIPT_MAX_BUFFER) chunks.push(data)
      }
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ success: false, exitCode: 124, stdout: '', stderr: 'custom script timeout' })
    }, CUSTOM_SCRIPT_TIMEOUT_MS)

    child.stdout.on('data', d => append(stdoutChunks, d, 'stdout'))
    child.stderr.on('data', d => append(stderrChunks, d, 'stderr'))
    child.on('error', err => finish({ success: false, exitCode: err.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: err.message }))
    child.on('close', code => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      finish({
        success: code === 0,
        exitCode: code ?? 0,
        stdout: _clipOutput(stdout).text,
        stderr: _clipOutput(stderr, 8000).text,
        stdoutTruncated: stdoutSize > CUSTOM_SCRIPT_MAX_BUFFER,
        stderrTruncated: stderrSize > CUSTOM_SCRIPT_MAX_BUFFER,
      })
    })

    try {
      child.stdin.write(JSON.stringify(input && typeof input === 'object' ? input : {}))
      child.stdin.end()
    } catch (e) {
      finish({ success: false, exitCode: 1, stdout: '', stderr: e.message })
    }
  })
}

function _createUserDefinedTool(row) {
  const def = _normalizeCustomToolRecord(row)
  const typeText = def.type === 'script'
    ? '本地脚本工具暂未开放运行。'
    : '工具会把参数作为 HTTP 请求参数发送，并返回响应正文。'
  return tool(
    async (input) => {
      if (def.type === 'script') return _runScriptCustomTool(def, input)
      return _runApiCustomTool(def, input)
    },
    {
      name: def.id,
      description: [
        def.description || def.name,
        typeText,
        def.params.length ? `参数：${def.params.map(p => `${p.name}${p.required ? '(必填)' : ''}`).join(', ')}` : '',
      ].filter(Boolean).join('\n'),
      schema: _customToolSchema(def.params),
    },
  )
}

export function getUserDefinedLangchainTools(toolIds, customToolRows = []) {
  if (!toolIds?.length || !customToolRows?.length) return []
  const idSet = new Set((toolIds || []).filter(id => typeof id === 'string'))
  return customToolRows
    .map(_normalizeCustomToolRecord)
    .filter(t => t.enabled && idSet.has(t.id) && (CUSTOM_SCRIPT_TOOLS_ENABLED || t.type !== 'script'))
    .map(_createUserDefinedTool)
}

function _normalizeToolIds(toolIds) {
  const normalized = new Set()
  for (const id of toolIds || []) {
    normalized.add(id)
    if (TOOL_ID_ALIASES[id]) normalized.add(TOOL_ID_ALIASES[id])
    if (typeof id === 'string' && id.startsWith('mcp:')) {
      normalized.add('mcp_resource_read')
      normalized.add('mcp_prompt_get')
    }
  }
  return normalized
}

function _createRouterTool(toolset) {
  const options = { agentDirName: _toolRunContext.agentEnglishName || '_shared', permissions: _toolRunContext.permissions || {} }
  if (toolset.id === 'ffmpeg') return createFfmpegTool(_workDirService, toolset.allowedOperations, options)
  if (toolset.id === 'pandoc') return createPandocTool(_workDirService, toolset.allowedOperations, options)
  if (toolset.id === 'manim') return createManimTool(_workDirService, toolset.allowedOperations, options)
  if (toolset.id === 'office') return createOfficeWriteTool(_workDirService, toolset.allowedOperations, options)
  return null
}

function _createToolsetTools(toolIds) {
  return _toolsetRegistry
    .resolveRouterTools(toolIds)
    .map(_createRouterTool)
    .filter(Boolean)
}

/**
 * Get custom LangChain tool instances by tool IDs
 * Note: DeepAgents provides filesystem tools (ls/read_file/write_file/edit_file/glob/grep) via FilesystemBackend
 * These custom tools supplement the built-in ones
 * @param {string[]} toolIds - Optional filter by tool ID
 * @returns {StructuredTool[]} LangChain tool instances
 */
export function getLangchainTools(toolIds) {
  const mediaReadAvailable = (_toolRunContext.allowedMediaIds || []).length > 0
  const bindRunScopedTools = tools => tools.flatMap((item) => {
    if (item === mediaRead) return mediaReadAvailable ? [createRunScopedMediaRead()] : []
    if (item === noteTool) return [createRunScopedNoteTool()]
   return [item]
 })
  // Swap kb_search tool based on whether an external knowledge source is active
  const useExternalKb = !!_cloudCtx.activeSourceId
  const effectiveTools = useExternalKb
    ? CUSTOM_TOOLS.map(t => t === kbSearch ? createKbSearchExternal() : t)
    : CUSTOM_TOOLS
  if (!toolIds?.length) return bindRunScopedTools(effectiveTools)
  const toolsetTools = _createToolsetTools(toolIds)
  const idSet = _normalizeToolIds(toolIds)
  return bindRunScopedTools([
    ...effectiveTools.filter(t => idSet.has(t.name)),
    ...toolsetTools,
  ])
}

export { CUSTOM_TOOLS }
