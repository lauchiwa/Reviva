---
name: skill-installer
description: 安装和管理 Reviva Skills。支持从 GitHub URL 克隆、本地路径/ZIP 导入、以及从描述创建新 Skill。当用户说"安装 skill""帮我安装 xxx""我下载了 skill""创建一个 skill"时触发。
---

# Skill 安装助手

使用 `skill_install` 工具完成 Skill 的安装、创建和管理。此技能默认绑定到所有 Agent。

## 核心概念

- Skill 安装到工作空间的 `skills/` 目录下，路径为 `/skills/{skillId}/`
- 每个 Skill 目录必须包含 `SKILL.md`，以 YAML frontmatter 开头（`name` 和 `description` 为必填字段）
- 安装时需要创建或更新 `config.json`，包含图标、颜色、允许工具等元数据。即使源文件没有 `config.json`，也会从 SKILL.md frontmatter 提取信息并生成完整的配置
- `config.json` 中的 `allowedTools` 会自动映射外部工具名（如 Bash→exec_command），详见下文"平台适配"
- Skill ID 只能使用小写字母、数字和连字符
- 安装后可以提醒用户在 Agent 设置中绑定该 Skill 才能使用，或重启对话使其生效

## config.json 自动生成与更新

安装或更新 Skill 时，系统**始终**自动创建或覆盖 `config.json`，用户无需手动维护。

### 什么时候生成

- **install_url**：从 GitHub 克隆/下载后，自动生成 config.json
- **install_path**：从本地文件夹/ZIP 导入后，自动生成 config.json
- **update**：重新拉取并替换时，重新生成 config.json（旧版本自动备份，失败回滚）
- **create**：从描述创建时，直接生成 config.json

即使源文件只有 SKILL.md 没有任何 config.json，也会自动生成完整配置。

### 字段来源

所有字段的优先级：源 config.json > frontmatter > 动态推断 > 固定默认值。只有源文件和 frontmatter 都没有该字段时才触发推断。

| 字段 | 来源优先级（高→低） |
|---|---|
| id | 用户指定 / 文件夹名 |
| name | 源 config.json > frontmatter > skillId |
| description | 源 config.json > frontmatter |
| allowedTools | 源 config.json > frontmatter `allowed-tools`（自动映射外部工具名） |
| icon | 源 config.json > frontmatter > 根据 name+description 关键词推断（学习→book-open, 写作→file-text, 代码→code-s-slash, 视频→video, 考试→file-list 等 14 种模式，默认 brain） |
| color | 源 config.json > frontmatter > 根据 skillId 哈希确定性生成（12 种颜色，同一 skill 多次安装颜色不变） |
| category | 源 config.json > frontmatter > 根据 name+description 关键词推断（学习/写作/开发/媒体/分析/科学/工具/研究，默认"通用"） |
| author | 源 config.json > frontmatter > 从 GitHub URL 提取 owner（如 github.com/Kulaxyz/repo → Kulaxyz） |
| version | 源 config.json > frontmatter > `1.0.0` |
| license | 源 config.json > frontmatter > 空 |
| outputTypes | 源 config.json > frontmatter > 根据 description+正文关键词推断（Markdown/HTML/DOCX/PPTX/XLSX/PDF/TXT，默认 Markdown） |
| createdAt | 源 > 当前日期 |
| updatedAt | 始终为当前日期 |
| source | 固定 `custom`（内置为 `platform`） |

### 关键行为

- frontmatter 的 `allowed-tools` 会被自动映射为 Reviva 工具 ID 并写入 config.json 的 allowedTools
- 更新时 config.json 被重新生成覆盖；如果源文件没有 config.json，之前手动编辑的字段会丢失
- 内置 Skill 的 config.json 在应用启动时按版本刷新：工作区副本仍为 source=platform 时，仅当内置 version 变更或副本 spec 校验无效才覆盖刷新；被用户改为自定义（source 非 platform）的不刷新，保护用户修改
- config.json 和 DB 记录同步更新，确保 Agent 绑定工具时读到正确的 allowedTools
- icon、color、category、author、outputTypes 会根据 skill 的 name、description 和 GitHub URL 动态推断，不是固定默认值。例如学习类 skill 自动获得书本图标，视频类获得视频图标；color 基于 skillId 哈希生成，同一 skill 始终相同

## 工作流程

### 1. 用户想了解有哪些 Skill

调用 `skill_install({ action: "list" })`，返回已安装的 Skills 和可用的内置 Skills。

### 2. 用户提供 GitHub URL 安装

当用户提供类似 `https://github.com/xxx/yyy` 的链接时：

```
skill_install({
  action: "install_url",
  url: "https://github.com/xxx/yyy",
  skillId: "可选的自定义ID"
})
```

工具会自动 clone 仓库并导入。如果仓库根目录没有 SKILL.md，会扫描子目录安装多个 Skill。如果该 skillId 已安装，install_url 会返回 conflict 拒绝覆盖；要替换已安装的 Skill 请用 action: "update"。

用户也可只给 `作者/仓库名`（如 `Kulaxyz/rovo`），工具会自动补全为 `https://github.com/作者/仓库名`。

如果 clone 失败，分析错误原因：
- 网络问题：提示用户检查网络或使用代理
- git 未安装：工具会自动降级为下载 GitHub ZIP 包并解压，无需 git
- 仓库不存在：提示用户检查 URL
- 直连 GitHub 失败：工具会自动尝试 gh-proxy.com、mirror.ghproxy.com 等加速镜像
- 所有方式都失败：提示用户手动下载 ZIP，然后用 install_path 安装

### 3. 用户提供了本地文件夹或 ZIP 路径

```
skill_install({
  action: "install_path",
  sourcePath: "用户提供的绝对路径",
  skillId: "可选的自定义ID"
})
```

如果下载github仓库失败可以提示用户手动下载skill，支持文件夹和 ZIP 格式。导入前会自动检测 Skill 结构。同样，已存在的 skillId 会返回 conflict，需要替换请用 update。

### 4. 用户描述要创建的 Skill

从用户的描述中提取信息，生成 SKILL.md 内容：

```
skill_install({
  action: "create",
  skillId: "my-skill",
  name: "显示名称",
  description: "触发描述，用于匹配用户请求",
  promptContent: "SKILL.md 的正文内容（不含 frontmatter，系统会自动生成）",
  allowedTools: ["exec_command"],
  icon: "ri-brain-line",
  color: "#6C8AFF"
})
```

创建时根据用户需求设计 SKILL.md 正文：
- 清晰的工作流程步骤
- 具体的工具调用示例
- 触发条件和使用场景

### 5. 验证已安装的 Skill

```
skill_install({ action: "validate", skillId: "skill-id" })
```

### 6. 查看 Skill 内容

```
skill_install({ action: "info", skillId: "skill-id" })
```

### 7. 删除 Skill

```
skill_install({ action: "uninstall", skillId: "skill-id" })
```

内置 Skill 不能删除。

### 8. 更新已安装的 Skill

从 GitHub 重新拉取并替换已安装的 Skill：

```
skill_install({
  action: "update",
  skillId: "要更新的skill-id",
  url: "https://github.com/xxx/yyy"
})
```

更新时会自动备份旧版本，如果失败会自动回滚。内置 Skill 不能通过此方式更新（内置 Skill 在应用启动时按版本自动刷新，无需手动 update）。

如果用户不确定 URL，可以先用 action: "list" 查看已安装的 Skill，或请用户提供仓库地址。

**install_url 是一站式操作**：单次调用自动完成 clone/下载、解压、config.json 生成、工具映射、验证、DB 同步和适配扫描。返回结果已包含 spec（验证状态）和 adaptation（适配报告），无需再单独调用 validate 或 info。仅当安装失败或用户要求查看内容时才需要额外调用。

## 安装后提示

每次安装或创建 Skill 后，告知用户：
1. Skill 已安装的位置
2. 建议关闭并重新打开 Reviva，使新 Skill 完全生效
3. 也可以在 Agent 设置中手动绑定该 Skill
4. 如果返回了 adaptation 报告且 needsAttention=true，告知用户该 Skill 可能需要适配（见下文）
5. 告知用户 config.json 已自动生成（含映射后的工具列表），无需手动创建

## 注意事项

- 不能覆盖内置 Skill（source 为 platform 的）
- 安装前检查是否已存在同名 Skill，避免冲突
- 如果用户提供的 URL 不是 GitHub，尝试用 install_path 处理
- 创建 Skill 时确保 description 清晰，以便正确触发
- create 不执行适配扫描（自建 Skill 无需跨平台适配）；install_url/install_path/update 才返回 adaptation 报告

## 平台适配

从 GitHub、Claude、Codex 等外部来源安装的 Skill，其 SKILL.md 可能引用其他平台的工具名、路径或依赖。安装时 `skill_install` 会自动执行适配扫描，返回 `adaptation` 报告。

### 自动工具映射

安装时自动将以下外部工具名映射为 Reviva 工具 ID（写入 config.json 的 allowedTools）：

| 外部工具名 | Reviva 工具 ID |
|---|---|
| Bash, Shell, Execute, Command, Terminal | exec_command |
| Read, read_file | file_read |
| Write, write_file, Edit | file_write |
| PDF, DOCX, XLSX, PPTX（读取） | document_read |
| Vision, Image, Screenshot | vision_analyze |
| KB, Knowledge | kb_search |
| Exa | mcp:exa |
| Firecrawl | mcp:firecrawl-mcp-server |
| Bing, web_search | web_search_bing |
| Tavily | web_search_tavily |

> 上表为主要别名，完整映射还包含 subprocess、readfile、create_file、save_file、knowledge_base、websearch、search 等。未识别的工具名会保留原值并进入下文 unmappedTools。

### adaptation 报告字段

- `mappedTools`: 已自动映射的工具（{ from, to }）
- `unmappedTools`: 无法识别的工具名，需要你或用户手动确认对应关系
- `warnings`: SKILL.md 正文中检测到的平台特定模式（系统路径、localhost、pip/npm install、日期占位符等）
- `needsAttention`: true 表示存在未映射工具或警告，需要进一步处理

### 如何处理适配问题

1. `unmappedTools` 非空：告知用户这些工具名无法自动映射，询问是否知道对应的 Reviva 工具，或建议忽略
2. `warnings` 含系统路径（/home/、~/.claude/、C:\\Users\\）：告知用户该 Skill 引用了其他平台路径，可能需要手动修改 SKILL.md 中的路径为 Reviva 虚拟路径
3. `warnings` 含 pip/npm install：告知用户该 Skill 依赖自动安装，Reviva 不允许自动安装，需要用户手动准备环境
4. `warnings` 含 localhost：告知用户该 Skill 引用了本地服务，可能无法在 Reviva 中直接使用
5. 复杂适配：可读取同目录下的 `SKILL_ADAPTATION_WORKFLOW.md`（如果存在）了解完整适配工作流

### Reviva 关键路径规则

- 最终文件输出：`/agents/{当前Agent英文名}/outputs/{系统日期}/文件名.ext`
- 临时文件：`/tmp/{当前Agent英文名}/{系统日期}/中间文件.ext`
- Skill 目录：`/skills/{skillId}/`（只读）
- 不要写系统 temp、Skill 目录或固定绝对路径作为最终输出
