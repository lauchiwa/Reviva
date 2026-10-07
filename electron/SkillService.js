// electron/SkillService.js — Skill directory management: install, list files, read content
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'

// Text file extensions that can be previewed
const PREVIEWABLE_EXTENSIONS = [
  'md', 'txt', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt', 'scala',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bash',
  'sql', 'html', 'css', 'scss', 'less', 'vue', 'svelte',
  'xml', 'svg', 'graphql', 'gql', 'proto', 'dockerfile',
  'gitignore', 'editorconfig', 'prettierrc', 'eslintrc',
]

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_DESCRIPTION_LENGTH = 1024
const MAX_IMPORT_FILE_COUNT = 500
const MAX_IMPORT_FILE_SIZE = 20 * 1024 * 1024
const MAX_IMPORT_TOTAL_SIZE = 100 * 1024 * 1024
const CONFIG_DEFAULTS = {
  version: '1.0.0', author: '', license: '', allowedTools: [], outputTypes: [],
  createdAt: '', updatedAt: '', trustStatus: '',
}

// Mapping from external platform tool names to Reviva tool IDs.
// Used when importing skills from Claude, Codex, GitHub, or other Agent platforms.
const EXTERNAL_TOOL_MAP = {
  bash: 'exec_command', shell: 'exec_command', execute: 'exec_command',
  command: 'exec_command', terminal: 'exec_command', subprocess: 'exec_command',
  read: 'file_read', read_file: 'file_read', readfile: 'file_read',
  write: 'file_write', write_file: 'file_write', writefile: 'file_write',
  edit: 'file_write', create_file: 'file_write', save_file: 'file_write',
  pdf: 'document_read', docx: 'document_read', xlsx: 'document_read',
  pptx: 'document_read',
  vision: 'vision_analyze', image: 'vision_analyze', screenshot: 'vision_analyze',
  kb: 'kb_search', knowledge: 'kb_search', knowledge_base: 'kb_search',
  exa: 'mcp:exa', firecrawl: 'mcp:firecrawl-mcp-server',
  bing: 'web_search_bing', web_search: 'web_search_bing', websearch: 'web_search_bing',
  search: 'web_search_bing', tavily: 'web_search_tavily',
}

// Known valid Reviva tool IDs — anything not in this set after mapping is "unmapped".
const REVIVA_TOOL_IDS = new Set([
  'file_read', 'file_write', 'file_delete', 'delete_file', 'file_list', 'file_rename', 'file_move', 'file_copy',
  'document_read', 'office_read', 'office_write', 'pdf_read',
  'vision_analyze', 'exec_command', 'kb_search', 'wiki', 'note', 'calculator',
  'media_read', 'pptx_export_local', 'mcp_resource_read', 'mcp_prompt_get',
  'skill_install', 'web_search_tavily', 'web_search_searxng', 'web_search_bing',
])

// Patterns in external SKILL.md body that may need manual adaptation.
const ADAPTATION_PATTERNS = [
  { re: /\/home\/[A-Za-z]/g, label: '系统用户路径(/home/...)', severity: 'warn' },
  { re: /~\/\.claude\//g, label: 'Claude 平台路径(~/.claude/)', severity: 'warn' },
  { re: /~\/\.codex\//g, label: 'Codex 平台路径(~/.codex/)', severity: 'warn' },
  { re: /C:\\Users\\/g, label: 'Windows 用户路径', severity: 'warn' },
  { re: /localhost|127\.0\.0\.1/g, label: 'localhost 服务引用', severity: 'warn' },
  { re: /pip\s+install/g, label: '自动 pip install', severity: 'warn' },
  { re: /npm\s+install/g, label: '自动 npm install', severity: 'warn' },
  { re: /\{date\}|YYYY-MM-DD/g, label: '日期占位符未替换', severity: 'warn' },
  { re: /tempfile\.gettempdir/g, label: '系统临时目录作为输出', severity: 'warn' },
]

// Icon inference based on description/name keywords
const ICON_KEYWORDS = [
  { re: /学习|study|learn|课程|知识|记忆|memor/i, icon: 'ri-book-open-line' },
  { re: /写作|write|文档|报告|essay|article/i, icon: 'ri-file-text-line' },
  { re: /代码|code|develop|编程|program|build/i, icon: 'ri-code-s-slash-line' },
  { re: /分析|analy|chart|数据|统计|stat/i, icon: 'ri-chart-line' },
  { re: /创意|design|设计|创意|art/i, icon: 'ri-palette-line' },
  { re: /科学|science|实验|experiment|flask|lab/i, icon: 'ri-flask-line' },
  { re: /数学|math|计算|calculate|算/i, icon: 'ri-calculator-line' },
  { re: /视频|video|动画|animation|media|render/i, icon: 'ri-video-line' },
  { re: /考试|exam|quiz|测试|test|模拟/i, icon: 'ri-file-list-3-line' },
  { re: /笔记|note|memo|卡片|flash/i, icon: 'ri-sticky-note-line' },
  { re: /搜索|search|research|研究|find/i, icon: 'ri-search-line' },
  { re: /安装|install|skill|工具|tool|manage/i, icon: 'ri-tools-line' },
  { re: /思维|mind|脑图|map|concept/i, icon: 'ri-mind-map' },
  { re: /音频|audio|voice|speech|tts|配音/i, icon: 'ri-volume-up-line' },
]

// Category inference from description
const CATEGORY_KEYWORDS = [
  { re: /学习|study|课程|知识|考试|quiz|exam|学习|记忆/i, cat: '学习' },
  { re: /写作|write|文档|报告|essay|article/i, cat: '写作' },
  { re: /代码|code|develop|编程|program/i, cat: '开发' },
  { re: /视频|video|动画|animation|media/i, cat: '媒体' },
  { re: /分析|analy|数据|统计|stat/i, cat: '分析' },
  { re: /科学|science|实验|experiment/i, cat: '科学' },
  { re: /安装|install|skill|工具|tool/i, cat: '工具' },
  { re: /搜索|search|research|研究/i, cat: '研究' },
]

// Color palette for deterministic assignment from skillId hash
const SKILL_COLORS = ['#6C8AFF', '#FF7676', '#FACC15', '#4ADE80', '#A78BFA', '#38BDF8', '#FB923C', '#EC4899', '#14B8A6', '#818CF8', '#F472B6', '#34D399']

function _inferIcon(text) {
  for (const { re, icon } of ICON_KEYWORDS) {
    if (re.test(text)) return icon
  }
  return 'ri-brain-line'
}

function _inferCategory(text) {
  for (const { re, cat } of CATEGORY_KEYWORDS) {
    if (re.test(text)) return cat
  }
  return '通用'
}

function _inferColor(skillId) {
  let hash = 0
  for (const ch of String(skillId || '')) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return SKILL_COLORS[Math.abs(hash) % SKILL_COLORS.length]
}

function _inferOutputTypes(text) {
  const types = []
  if (/markdown|\.md|文档|note/i.test(text)) types.push('Markdown')
  if (/html|网页|web page/i.test(text)) types.push('HTML')
  if (/docx|word/i.test(text)) types.push('DOCX')
  if (/pptx|slide|幻灯/i.test(text)) types.push('PPTX')
  if (/xlsx|excel|表格/i.test(text)) types.push('XLSX')
  if (/pdf/i.test(text)) types.push('PDF')
  if (/txt|纯文本/i.test(text)) types.push('TXT')
  return types.length ? types : ['Markdown']
}

function _extractAuthorFromUrl(url) {
  if (!url) return ''
  const m = String(url).match(/github\.com\/([^/]+)\//)
  return m ? m[1] : ''
}

function _isTopLevelYamlKey(line) {
  return /^[A-Za-z0-9_-]+:\s*/.test(line)
}

function _stripYamlQuotes(value) {
  const str = String(value || '').trim()
  if (!str) return ''
  if (str.startsWith('"') && str.endsWith('"')) {
    try {
      return JSON.parse(str)
    } catch {
      return str.slice(1, -1)
    }
  }
  if (str.startsWith("'") && str.endsWith("'")) {
    return str.slice(1, -1).replace(/''/g, "'")
  }
  return str
}

function _quoteYamlString(value) {
  return JSON.stringify(String(value || '').replace(/\r?\n/g, ' ').trim())
}

function _parseSimpleFrontmatter(raw) {
  const meta = {}
  const lines = String(raw || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue

    const key = match[1]
    const value = match[2].trim()
    if (value === '>' || value === '|') {
      const block = []
      while (i + 1 < lines.length && !_isTopLevelYamlKey(lines[i + 1])) {
        block.push(lines[++i].replace(/^\s{1,4}/, ''))
      }
      meta[key] = value === '>' ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim()
      continue
    }

    if (!value) {
      const list = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        list.push(lines[++i].replace(/^\s*-\s+/, '').trim())
      }
      meta[key] = list.length ? list : ''
      continue
    }

    meta[key] = _stripYamlQuotes(value)
  }
  return meta
}

function _extractSkillFrontmatter(content) {
  const text = String(content || '').replace(/^\uFEFF/, '')
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) return { meta: null, raw: '', body: text, error: 'missing YAML frontmatter at the start of SKILL.md' }
  return {
    meta: _parseSimpleFrontmatter(match[1]),
    raw: match[1],
    body: text.slice(match[0].length).replace(/^\s+/, ''),
    error: '',
  }
}

function _removeFrontmatterKeys(raw, keys) {
  const removeKeys = new Set(keys)
  const kept = []
  const lines = String(raw || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (match && removeKeys.has(match[1])) {
      while (i + 1 < lines.length && !_isTopLevelYamlKey(lines[i + 1])) i++
      continue
    }
    kept.push(lines[i])
  }
  return kept.join('\n').trim()
}

export class SkillService {
  constructor(workDirService, options = {}) {
    this._wd = workDirService
    // Absolute path to the bundled built-in skills directory (electron/builtin-assets/skills in dev,
    // resources/builtin-assets/skills in production). Set by main.js based on app.isPackaged.
    this._builtinSkillsDir = options.builtinSkillsDir || null
  }

  getSkillsRoot() {
    const root = this._wd.getRootPath()
    return root ? path.join(root, 'skills') : null
  }

  getSkillDir(skillId) {
    const root = this.getSkillsRoot()
    return root && this.isValidSkillId(skillId) ? path.join(root, skillId) : null
  }

  // Absolute path to the bundled built-in skills source folder.
  getBuiltinSkillsDir() {
    return this._builtinSkillsDir
  }

  normalizeSkillId(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  }

  isValidSkillId(value) {
    return SKILL_NAME_PATTERN.test(String(value || ''))
  }

  isBuiltinSkillId(skillId) {
    const normalized = String(skillId || '').trim()
    return !!(this.isValidSkillId(normalized) && this._builtinSkillsDir && fs.existsSync(path.join(this._builtinSkillsDir, normalized)))
  }

  _normalizeConfig(skillId, skillData = {}, existing = {}) {
    const source = skillData.source === 'platform' ? 'platform' : 'custom'
    return {
      id: skillId,
      name: String(skillData.name || existing.name || '').trim(),
      description: String(skillData.description || skillData.desc || existing.description || '').trim(),
      source,
      icon: skillData.icon || existing.icon || _inferIcon(String(skillData.name || '') + ' ' + String(skillData.description || '')),
      color: skillData.color || existing.color || _inferColor(skillId),
      category: String(skillData.category || existing.category || _inferCategory(String(skillData.name || '') + ' ' + String(skillData.description || ''))).trim(),
      version: String(skillData.version ?? existing.version ?? CONFIG_DEFAULTS.version),
      author: String(skillData.author || existing.author || _extractAuthorFromUrl(skillData.sourceUrl) || ''),
      license: String(skillData.license ?? existing.license ?? CONFIG_DEFAULTS.license),
      allowedTools: this._resolveAllowedTools(skillData, existing),
      outputTypes: Array.isArray(skillData.outputTypes) && skillData.outputTypes.length ? skillData.outputTypes : Array.isArray(skillData.output_types) && skillData.output_types.length ? skillData.output_types : (Array.isArray(existing.outputTypes) && existing.outputTypes.length ? existing.outputTypes : _inferOutputTypes(String(skillData.description || '') + ' ' + String(skillData.promptContent || '').slice(0, 500))),
      createdAt: String(skillData.createdAt || existing.createdAt || new Date().toISOString().slice(0, 10)),
      updatedAt: new Date().toISOString().slice(0, 10),
      trustStatus: String(skillData.trustStatus ?? existing.trustStatus ?? CONFIG_DEFAULTS.trustStatus),
    }
  }

  // Normalize a tool list that may be a string ("Bash, Read, Write") or an array.
  _normalizeToolList(value) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean)
    if (typeof value === 'string') {
      return value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    }
    return []
  }

  // Map external platform tool names (Bash, Read, Write, etc.) to Reviva tool IDs.
  // Unknown names are kept as-is so adaptExternalSkill can flag them.
  _mapToolNames(tools) {
    if (!Array.isArray(tools)) return []
    return [...new Set(tools.map(t => {
      const lower = String(t || '').trim().toLowerCase()
      return EXTERNAL_TOOL_MAP[lower] || String(t || '').trim()
    }).filter(Boolean))]
  }

  // Resolve the final allowedTools list from multiple sources, then map external names.
  _resolveAllowedTools(skillData, existing) {
    let raw = null
    if (Array.isArray(skillData.allowedTools)) raw = skillData.allowedTools
    else if (Array.isArray(skillData.allowed_tools)) raw = skillData.allowed_tools
    else {
      const fmList = this._normalizeToolList(skillData['allowed-tools'])
      raw = fmList.length ? fmList : (Array.isArray(existing.allowedTools) ? existing.allowedTools : [])
    }
    return this._mapToolNames(raw)
  }

  // Post-install adaptation scan: detect unmapped tools and platform-specific patterns.
  // Returns a report the agent can present to the user.
  async adaptExternalSkill(skillId) {
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir || !fs.existsSync(skillDir)) return { adapted: false, error: 'Skill 目录不存在' }

    const skillMdPath = path.join(skillDir, 'SKILL.md')
    const configPath = path.join(skillDir, 'config.json')

    let skillContent = ''
    try {
      skillContent = await fs.promises.readFile(skillMdPath, 'utf-8')
    } catch {
      return { adapted: false, error: '无法读取 SKILL.md' }
    }

    const parsed = _extractSkillFrontmatter(skillContent)
    const config = await this._readJsonFile(configPath) || {}
    const bodyContent = parsed.body || skillContent

    const mappedTools = []
    const unmappedTools = []
    // Read frontmatter allowed-tools (original external names, preserved by _normalizeSkillMarkdown)
    const fmTools = this._normalizeToolList(parsed.meta?.['allowed-tools'] || parsed.meta?.allowedTools || parsed.meta?.allowed_tools)
    for (const fmTool of fmTools) {
      const lower = String(fmTool || '').trim().toLowerCase()
      if (EXTERNAL_TOOL_MAP[lower] && EXTERNAL_TOOL_MAP[lower] !== lower) {
        mappedTools.push({ from: fmTool, to: EXTERNAL_TOOL_MAP[lower] })
      }
    }
    // Check config.json allowedTools for any remaining unmapped (non-Reviva, non-MCP) IDs
    const configTools = Array.isArray(config.allowedTools) ? config.allowedTools : []
    for (const tool of configTools) {
      const lower = String(tool || '').trim().toLowerCase()
      const isMcp = lower.startsWith('mcp:')
      if (!isMcp && !REVIVA_TOOL_IDS.has(lower)) {
        unmappedTools.push(tool)
      }
    }

    const warnings = []
    for (const { re, label, severity } of ADAPTATION_PATTERNS) {
      re.lastIndex = 0
      const matches = bodyContent.match(re)
      if (matches) warnings.push({ pattern: label, severity, count: matches.length })
    }

    return {
      adapted: mappedTools.length > 0,
      mappedTools,
      unmappedTools,
      warnings,
      needsAttention: unmappedTools.length > 0 || warnings.length > 0,
    }
  }

  // Install a skill: create directory and write SKILL.md + config.json
  // Used for user-created / AI-generated skills (passes data through, not from disk)
  async installSkill(skillId, skillData) {
    if (!this.isValidSkillId(skillId)) throw new Error('Skill ID 只能使用英文小写、数字和连字符')
    if (skillData?.source !== 'platform' && this.isBuiltinSkillId(skillId)) throw new Error(`不能覆盖内置 Skill：${skillId}`)
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir) throw new Error('No workspace initialized')
    if (fs.existsSync(skillDir)) throw new Error(`Skill ID "${skillId}" 已存在`)

    await fs.promises.mkdir(this.getSkillsRoot(), { recursive: true })
    const tempDir = await fs.promises.mkdtemp(path.join(this.getSkillsRoot(), `.skill-${skillId}-`))

    try {
      const promptContent = this._normalizeSkillMarkdown(skillId, skillData)
      await fs.promises.writeFile(path.join(tempDir, 'SKILL.md'), promptContent, 'utf-8')
      const config = this._normalizeConfig(skillId, skillData)
      await fs.promises.writeFile(path.join(tempDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8')
      const spec = this._validateSkillDir(skillId, tempDir, false)
      if (!spec.valid) throw new Error(spec.issues.join('；'))
      await this._replaceSkillDir(tempDir, skillDir)
      return { success: true, dir: skillDir, config, spec: this.validateSkillSpec(skillId) }
    } catch (err) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  async updateSkill(skillId, skillData = {}) {
    if (!this.isValidSkillId(skillId)) throw new Error('Skill ID 不合法')
    if (this.isBuiltinSkillId(skillId)) throw new Error(`不能编辑内置 Skill：${skillId}`)
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir || !fs.existsSync(skillDir)) throw new Error('Skill 目录不存在')
    const existingConfig = await this._readJsonFile(path.join(skillDir, 'config.json')) || {}
    const promptContent = this._normalizeSkillMarkdown(skillId, skillData)
    const config = this._normalizeConfig(skillId, { ...existingConfig, ...skillData, source: 'custom' }, existingConfig)
    const tempDir = await fs.promises.mkdtemp(path.join(this.getSkillsRoot(), `.skill-update-${skillId}-`))
    try {
      await this._copyDirectoryContents(skillDir, tempDir)
      await fs.promises.writeFile(path.join(tempDir, 'SKILL.md'), promptContent, 'utf-8')
      await fs.promises.writeFile(path.join(tempDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8')
      const spec = this._validateSkillDir(skillId, tempDir, false)
      if (!spec.valid) throw new Error(spec.issues.join('；'))
      await this._replaceSkillDir(tempDir, skillDir)
      return { success: true, dir: skillDir, config, spec: this.validateSkillSpec(skillId) }
    } catch (err) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  async _replaceSkillDir(tempDir, targetDir) {
    const backupDir = `${targetDir}.backup-${crypto.randomUUID()}`
    const hadTarget = fs.existsSync(targetDir)
    if (hadTarget) await fs.promises.rename(targetDir, backupDir)
    try {
      await fs.promises.rename(tempDir, targetDir)
      if (hadTarget) await fs.promises.rm(backupDir, { recursive: true, force: true })
    } catch (err) {
      if (fs.existsSync(targetDir)) await fs.promises.rm(targetDir, { recursive: true, force: true }).catch(() => {})
      if (hadTarget && fs.existsSync(backupDir)) await fs.promises.rename(backupDir, targetDir).catch(() => {})
      throw err
    }
  }

  async createSkillSnapshot(skillId) {
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir) throw new Error('No workspace initialized')
    const snapshotRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reviva-skill-snapshot-'))
    try {
      const existed = fs.existsSync(skillDir)
      if (existed) await this._copyDirectoryContents(skillDir, path.join(snapshotRoot, 'skill'))
      return { root: snapshotRoot, existed }
    } catch (error) {
      await fs.promises.rm(snapshotRoot, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async restoreSkillSnapshot(skillId, snapshot) {
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir || !snapshot?.root) return
    if (!snapshot.existed) {
      await fs.promises.rm(skillDir, { recursive: true, force: true })
      return
    }
    const snapshotDir = path.join(snapshot.root, 'skill')
    const tempDir = await fs.promises.mkdtemp(path.join(this.getSkillsRoot(), `.skill-restore-${skillId}-`))
    try {
      await this._copyDirectoryContents(snapshotDir, tempDir)
      await this._replaceSkillDir(tempDir, skillDir)
    } catch (error) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async discardSkillSnapshot(snapshot) {
    if (snapshot?.root) await fs.promises.rm(snapshot.root, { recursive: true, force: true }).catch(() => {})
  }

  async renameCustomSkill(oldId, newId) {
    if (!this.isValidSkillId(oldId) || !this.isValidSkillId(newId)) throw new Error('Skill ID 不合法')
    const oldDir = this.getSkillDir(oldId)
    const newDir = this.getSkillDir(newId)
    if (!oldDir || !newDir || !fs.existsSync(oldDir)) throw new Error(`自定义 Skill 目录不存在：${oldId}`)
    if (fs.existsSync(newDir)) throw new Error(`Skill ID "${newId}" 已存在`)
    const existingConfig = await this._readJsonFile(path.join(oldDir, 'config.json')) || {}
    if (existingConfig.source === 'platform' || existingConfig.builtin === true) throw new Error('内置 Skill 不能迁移')
    const raw = await fs.promises.readFile(path.join(oldDir, 'SKILL.md'), 'utf-8')
    const tempDir = await fs.promises.mkdtemp(path.join(this.getSkillsRoot(), `.skill-rename-${newId}-`))
    try {
      await this._copyDirectoryContents(oldDir, tempDir)
      const skillData = { ...existingConfig, id: newId, promptContent: raw, source: 'custom' }
      await fs.promises.writeFile(path.join(tempDir, 'SKILL.md'), this._normalizeSkillMarkdown(newId, skillData), 'utf-8')
      await fs.promises.writeFile(path.join(tempDir, 'config.json'), JSON.stringify(this._normalizeConfig(newId, skillData, existingConfig), null, 2), 'utf-8')
      const spec = this._validateSkillDir(newId, tempDir, false)
      if (!spec.valid) throw new Error(spec.issues.join('；'))
      await this._replaceSkillDir(tempDir, newDir)
      try {
        await fs.promises.rm(oldDir, { recursive: true, force: true })
      } catch (err) {
        await fs.promises.rm(newDir, { recursive: true, force: true }).catch(() => {})
        throw err
      }
      return { success: true, oldId, newId }
    } catch (err) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  _normalizeSkillMarkdown(skillId, skillData = {}) {
    const rawContent = String(
      skillData.promptContent ||
      skillData.prompt_content ||
      skillData.promptTemplate ||
      skillData.prompt_template ||
      '',
    )
    const parsed = _extractSkillFrontmatter(rawContent)
    const existingDescription = parsed.meta?.description ? String(parsed.meta.description).trim() : ''
    const description = skillData.description ||
      skillData.desc ||
      existingDescription ||
      skillData.name ||
      `Custom skill ${skillId}`

    if (parsed.meta?.name === skillId && existingDescription === String(description).trim()) {
      return rawContent.replace(/^\uFEFF/, '')
    }

    const preserved = parsed.meta ? _removeFrontmatterKeys(parsed.raw, ['name', 'description']) : ''
    const frontmatter = [
      '---',
      `name: ${skillId}`,
      `description: ${_quoteYamlString(description)}`,
      preserved,
      '---',
    ].filter(Boolean).join('\n')
    const body = (parsed.meta ? parsed.body : rawContent).trim()
    const fallbackBody = `# ${skillData.name || skillId}\n\nUse this skill when it matches the request. Follow the instructions in this file and ask for missing inputs before acting.`
    return `${frontmatter}\n\n${body || fallbackBody}\n`
  }

  async uninstallSkill(skillId) {
    if (this.isBuiltinSkillId(skillId)) throw new Error(`不能删除内置 Skill：${skillId}`)
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir) throw new Error('No workspace initialized')
    if (fs.existsSync(skillDir)) {
      await fs.promises.rm(skillDir, { recursive: true, force: true })
    }
    return { success: true }
  }

  // List all files in a skill directory (recursive, for file tree)
  async listSkillFiles(skillId) {
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir || !fs.existsSync(skillDir)) return []

    const results = []
    await this._walkDir(skillDir, '', results)
    return results
  }

  async _walkDir(absDir, relativePrefix, results) {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))

    for (const d of dirs) {
      const relPath = relativePrefix ? `${relativePrefix}/${d.name}` : d.name
      results.push({ name: d.name, path: relPath, isDirectory: true, children: [] })
      await this._walkDir(path.join(absDir, d.name), relPath, results[results.length - 1].children)
    }
    for (const f of files) {
      const ext = f.name.split('.').pop().toLowerCase()
      const relPath = relativePrefix ? `${relativePrefix}/${f.name}` : f.name
      results.push({
        name: f.name,
        path: relPath,
        isDirectory: false,
        previewable: PREVIEWABLE_EXTENSIONS.includes(ext),
        extension: ext,
      })
    }
  }

  async readSkillFile(skillId, relativePath) {
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir) return { success: false, error: 'No workspace' }

    const filePath = path.join(skillDir, relativePath)
    const resolved = path.resolve(filePath)
    const skillDirResolved = path.resolve(skillDir)
    if (!resolved.startsWith(skillDirResolved + path.sep) && resolved !== skillDirResolved) {
      return { success: false, error: 'Path outside skill directory' }
    }

    try {
      const content = await fs.promises.readFile(resolved, 'utf-8')
      return { success: true, data: content }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  async writeSkillFile(skillId, relativePath, content) {
    if (this.isBuiltinSkillId(skillId)) return { success: false, error: '不能编辑内置 Skill' }
    if (typeof content !== 'string') return { success: false, error: '文件内容必须是文本' }
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir) return { success: false, error: 'No workspace' }
    const resolved = this._resolveSkillPath(skillDir, relativePath)
    if (!resolved || path.basename(resolved).toLowerCase() === 'config.json') return { success: false, error: '不允许直接编辑 config.json' }
    try {
      const previous = await fs.promises.readFile(resolved, 'utf-8').catch(() => null)
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true })
      await fs.promises.writeFile(resolved, content, 'utf-8')
      if (path.basename(resolved).toLowerCase() === 'skill.md') {
        const spec = this.validateSkillSpec(skillId)
        if (!spec.valid) {
          if (previous === null) await fs.promises.rm(resolved, { force: true })
          else await fs.promises.writeFile(resolved, previous, 'utf-8')
          return { success: false, error: spec.issues.join('；'), spec }
        }
      }
      return { success: true, spec: this.validateSkillSpec(skillId) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  _resolveSkillPath(skillDir, relativePath) {
    const rel = String(relativePath || '').replace(/\\/g, '/')
    if (!rel || rel.startsWith('/') || rel.split('/').some(part => part === '..')) return null
    const resolved = path.resolve(skillDir, rel)
    const base = path.resolve(skillDir)
    return resolved.startsWith(base + path.sep) ? resolved : null
  }

  async _copyDirectoryContents(sourceDir, targetDir) {
    await fs.promises.mkdir(targetDir, { recursive: true })
    for (const entry of await fs.promises.readdir(sourceDir, { withFileTypes: true })) {
      const source = path.join(sourceDir, entry.name)
      const target = path.join(targetDir, entry.name)
      const stat = await fs.promises.lstat(source)
      if (stat.isSymbolicLink()) throw new Error('Skill 文件夹不能包含符号链接')
      if (stat.isDirectory()) await this._copyDirectoryContents(source, target)
      else if (stat.isFile()) await fs.promises.copyFile(source, target)
    }
  }

  async _assertSafeSourceTree(rootDir) {
    let fileCount = 0
    let totalSize = 0
    const walk = async (dir) => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name)
        const stat = await fs.promises.lstat(abs)
        if (stat.isSymbolicLink()) throw new Error('Skill 文件夹不能包含符号链接')
        if (stat.isDirectory()) await walk(abs)
        else if (stat.isFile()) {
          fileCount += 1
          totalSize += stat.size
          if (fileCount > MAX_IMPORT_FILE_COUNT) throw new Error('Skill 文件数量超出限制')
          if (stat.size > MAX_IMPORT_FILE_SIZE || totalSize > MAX_IMPORT_TOTAL_SIZE) throw new Error('Skill 文件内容超出限制')
        }
      }
    }
    await walk(rootDir)
  }

  async _extractZip(sourcePath) {
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(await fs.promises.readFile(sourcePath), { createFolders: true })
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reviva-skill-'))
    let fileCount = 0
    let totalSize = 0
    try {
      for (const [name, entry] of Object.entries(zip.files)) {
        const originalName = entry.unsafeOriginalName || name
        const rawName = originalName.replace(/\\/g, '/')
        if (rawName.startsWith('/') || /^[a-zA-Z]:\//.test(rawName)) throw new Error('ZIP 包含绝对路径')
        const normalized = rawName.replace(/^\.\//, '')
        if (!normalized || normalized.split('/').some(part => part === '..') || path.isAbsolute(normalized)) throw new Error('ZIP 包含非法路径')
        if (entry.dir) continue
        fileCount += 1
        if (fileCount > MAX_IMPORT_FILE_COUNT) throw new Error('ZIP 文件数量超出限制')
        const data = await entry.async('nodebuffer')
        totalSize += data.length
        if (data.length > MAX_IMPORT_FILE_SIZE || totalSize > MAX_IMPORT_TOTAL_SIZE) throw new Error('ZIP 解压内容超出限制')
        const target = this._resolveSkillPath(tempDir, normalized)
        if (!target) throw new Error('ZIP 包含越界路径')
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        await fs.promises.writeFile(target, data)
      }
      return tempDir
    } catch (err) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  async _sourceRoot(sourcePath) {
    const resolved = path.resolve(String(sourcePath || ''))
    if (!resolved || !fs.existsSync(resolved)) throw new Error('导入路径不存在')
    const stat = await fs.promises.stat(resolved)
    let tempRoot = ''
    let sourceName = path.basename(resolved, path.extname(resolved))
    if (stat.isFile() && path.extname(resolved).toLowerCase() === '.zip') tempRoot = await this._extractZip(resolved)
    else if (stat.isFile() && path.basename(resolved).toLowerCase() === 'skill.md') {
      sourceName = path.basename(path.dirname(resolved))
      if (stat.size > MAX_IMPORT_FILE_SIZE) throw new Error('SKILL.md 文件过大')
      tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reviva-skill-'))
      await fs.promises.copyFile(resolved, path.join(tempRoot, 'SKILL.md'))
    } else if (stat.isDirectory()) {
      await this._assertSafeSourceTree(resolved)
      tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reviva-skill-'))
      await this._copyDirectoryContents(resolved, tempRoot)
    } else throw new Error('请选择 ZIP、Skill 文件夹或 SKILL.md')

    const direct = path.join(tempRoot, 'SKILL.md')
    if (fs.existsSync(direct)) return { root: tempRoot, cleanup: true, sourceName }
    const children = await fs.promises.readdir(tempRoot, { withFileTypes: true })
    const dirs = children.filter(item => item.isDirectory())
    if (dirs.length === 1 && fs.existsSync(path.join(tempRoot, dirs[0].name, 'SKILL.md'))) return { root: path.join(tempRoot, dirs[0].name), cleanup: true, parent: tempRoot, sourceName: dirs[0].name }
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    throw new Error('导入内容中未找到根目录 SKILL.md')
  }

  async inspectSkillSource(sourcePath, context = {}) {
    const source = await this._sourceRoot(sourcePath)
    try {
      const raw = await fs.promises.readFile(path.join(source.root, 'SKILL.md'), 'utf-8')
      const parsed = _extractSkillFrontmatter(raw)
      const config = await this._readJsonFile(path.join(source.root, 'config.json')) || {}
      const suggestedId = this.normalizeSkillId(parsed.meta?.name || config.id || source.sourceName || path.basename(source.root))
      const files = await this.listFilesFromDir(source.root)
      const builtin = this.isBuiltinSkillId(suggestedId)
      const existing = Array.isArray(context.customSkills) ? context.customSkills.find(item => item.id === suggestedId) : null
      const diskConflict = !builtin && this.isInstalled(suggestedId)
      return {
        id: suggestedId,
        validId: this.isValidSkillId(suggestedId),
        name: String(config.name || parsed.meta?.title || parsed.meta?.name || suggestedId),
        description: String(config.description || parsed.meta?.description || ''),
        icon: config.icon || 'ri-brain-line', color: config.color || '#6C8AFF', category: config.category || '',
        source: 'custom', promptContent: raw, files, fileCount: files.length,
        issues: parsed.meta ? [] : ['SKILL.md 缺少 YAML frontmatter'],
        conflict: builtin ? 'platform' : (existing || diskConflict) ? 'custom' : '',
      }
    } finally {
      await fs.promises.rm(source.parent || source.root, { recursive: true, force: true }).catch(() => {})
    }
  }

  async listFilesFromDir(rootDir) {
    const results = []
    const walk = async (dir, prefix = '') => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          results.push({ name: entry.name, path: rel, isDirectory: true })
          await walk(path.join(dir, entry.name), rel)
        } else results.push({ name: entry.name, path: rel, isDirectory: false, previewable: PREVIEWABLE_EXTENSIONS.includes(entry.name.split('.').pop().toLowerCase()) })
      }
    }
    await walk(rootDir)
    return results
  }

  async importSkillSource(sourcePath, options = {}) {
    const source = await this._sourceRoot(sourcePath)
    const skillId = this.normalizeSkillId(options.id || '')
    if (!this.isValidSkillId(skillId)) throw new Error('Skill ID 只能使用英文小写、数字和连字符')
    if (this.isBuiltinSkillId(skillId)) throw new Error(`不能覆盖内置 Skill：${skillId}`)
    const targetDir = this.getSkillDir(skillId)
    if (!targetDir) throw new Error('No workspace initialized')
    await fs.promises.mkdir(this.getSkillsRoot(), { recursive: true })
    const tempDir = await fs.promises.mkdtemp(path.join(this.getSkillsRoot(), `.skill-import-${skillId}-`))
    try {
      await this._copyDirectoryContents(source.root, tempDir)
      const raw = await fs.promises.readFile(path.join(tempDir, 'SKILL.md'), 'utf-8')
      const parsed = _extractSkillFrontmatter(raw)
      const config = await this._readJsonFile(path.join(tempDir, 'config.json')) || {}
      const fmAllowedTools = parsed.meta?.['allowed-tools'] || parsed.meta?.allowedTools || parsed.meta?.allowed_tools
      const skillData = {
        ...config, ...options,
        name: options.name || config.name || parsed.meta?.title || skillId,
        description: options.description || config.description || parsed.meta?.description || '',
        promptContent: raw, source: 'custom',
        ...(fmAllowedTools && !config.allowedTools && !config.allowed_tools ? { 'allowed-tools': fmAllowedTools } : {}),
        version: config.version || parsed.meta?.version || undefined,
        author: config.author || parsed.meta?.author || undefined,
        license: config.license || parsed.meta?.license || undefined,
        icon: config.icon || parsed.meta?.icon || undefined,
        color: config.color || parsed.meta?.color || undefined,
        category: config.category || parsed.meta?.category || undefined,
      }
      await fs.promises.writeFile(path.join(tempDir, 'SKILL.md'), this._normalizeSkillMarkdown(skillId, skillData), 'utf-8')
      await fs.promises.writeFile(path.join(tempDir, 'config.json'), JSON.stringify(this._normalizeConfig(skillId, skillData, config), null, 2), 'utf-8')
      const spec = this._validateSkillDir(skillId, tempDir, false)
      if (!spec.valid) throw new Error(spec.issues.join('；'))
      await this._replaceSkillDir(tempDir, targetDir)
      return { success: true, id: skillId, config: this._normalizeConfig(skillId, skillData, config), spec: this.validateSkillSpec(skillId) }
    } catch (err) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    } finally {
      await fs.promises.rm(source.parent || source.root, { recursive: true, force: true }).catch(() => {})
    }
  }

  async ensureSkillsRoot() {
    const root = this.getSkillsRoot()
    if (root) {
      await fs.promises.mkdir(root, { recursive: true })
    }
  }

  isInstalled(skillId) {
    const skillDir = this.getSkillDir(skillId)
    return skillDir ? fs.existsSync(skillDir) : false
  }

  validateSkillSpec(skillId) {
    const skillDir = this.getSkillDir(skillId)
    if (!skillDir) {
      return { valid: false, installed: false, issues: ['工作区未初始化'] }
    }
    if (!fs.existsSync(skillDir)) {
      return { valid: false, installed: false, issues: ['技能目录不存在'] }
    }
    return this._validateSkillDir(skillId, skillDir, true)
  }

  _validateSkillDir(skillId, skillDir, installed = true) {
    const issues = []

    const skillFile = path.join(skillDir, 'SKILL.md')
    if (!fs.existsSync(skillFile)) {
      return { valid: false, installed, issues: ['缺少 SKILL.md'] }
    }

    let content = ''
    try {
      content = fs.readFileSync(skillFile, 'utf-8')
    } catch (err) {
      return { valid: false, installed, issues: [`无法读取 SKILL.md：${err.message}`] }
    }

    const parsed = _extractSkillFrontmatter(content)
    if (!parsed.meta) {
      return { valid: false, installed, issues: ['SKILL.md 必须从 YAML frontmatter 开始'] }
    }

    const name = String(parsed.meta.name || '').trim()
    const description = String(parsed.meta.description || '').trim()
    if (!name) issues.push('frontmatter 缺少 name')
    if (!description) issues.push('frontmatter 缺少 description')
    if (name && !SKILL_NAME_PATTERN.test(name)) {
      issues.push('name 只能使用小写字母、数字和连字符，且不能以连字符开头/结尾')
    }
    if (name && name !== skillId) {
      issues.push(`name 必须等于 Skill ID：${skillId}`)
    }
    if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      issues.push(`description 超过 ${MAX_SKILL_DESCRIPTION_LENGTH} 字符，DeepAgents 会截断`)
    }

    return {
      valid: issues.length === 0,
      installed,
      path: skillFile,
      name,
      description,
      issues,
    }
  }

  // Scan bundled built-in skills directory and return metadata array (one per valid subfolder).
  // A valid subfolder must contain config.json. Folder name overrides config.id (single source of truth).
  async listBuiltinSkills() {
    const src = this._builtinSkillsDir
    if (!src || !fs.existsSync(src)) return []

    const results = []
    const entries = await fs.promises.readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const configPath = path.join(src, entry.name, 'config.json')
      if (!fs.existsSync(configPath)) continue

      try {
        const raw = await fs.promises.readFile(configPath, 'utf-8')
        const config = JSON.parse(raw)
        config.id = entry.name
        config.source = config.source || 'platform'
        config.builtin = true
        results.push(config)
      } catch (err) {
        console.error(`[SkillService] Invalid config for ${entry.name}:`, err.message)
      }
    }
    return results
  }

  async _readJsonFile(filePath) {
    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf-8'))
    } catch {
      return null
    }
  }

  // Copy every bundled skill folder into the workspace skills directory at startup.
  // Existing platform skills are refreshed when the bundled version changes or
  // when their SKILL.md no longer follows the Agent Skills spec.
  async installAllBuiltinSkills() {
    if (!this.getSkillsRoot()) return
    const src = this._builtinSkillsDir
    if (!src || !fs.existsSync(src)) {
      console.log('[SkillService] No builtin-assets/skills directory found, skipping')
      return
    }

    await this.ensureSkillsRoot()

    const entries = await fs.promises.readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillId = entry.name
      const srcDir = path.join(src, skillId)
      const dstDir = this.getSkillDir(skillId)

      const srcConfigPath = path.join(srcDir, 'config.json')
      const dstConfigPath = path.join(dstDir, 'config.json')
      if (!fs.existsSync(srcConfigPath)) continue

      const srcConfig = await this._readJsonFile(srcConfigPath)
      if (!srcConfig) continue

      if (fs.existsSync(dstDir)) {
        const dstConfig = await this._readJsonFile(dstConfigPath)
        const isPlatformSkill = dstConfig?.source === 'platform' || dstConfig?.builtin === true
        const dstSpec = this.validateSkillSpec(skillId)
        const shouldRefresh = isPlatformSkill && (
          (srcConfig.version && dstConfig?.version !== srcConfig.version) ||
          !dstSpec.valid
        )
        if (!shouldRefresh) continue

        try {
          await fs.promises.cp(srcDir, dstDir, { recursive: true, force: true })
          console.log(`[SkillService] Updated builtin skill: ${skillId} (${dstConfig?.version || 'unknown'} -> ${srcConfig.version})`)
        } catch (err) {
          console.error(`[SkillService] Failed to update ${skillId}:`, err.message)
        }
        continue
      }

      try {
        await fs.promises.cp(srcDir, dstDir, { recursive: true })
        console.log(`[SkillService] Installed builtin skill: ${skillId}`)
      } catch (err) {
        console.error(`[SkillService] Failed to install ${skillId}:`, err.message)
      }
    }
  }
}
