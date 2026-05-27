# 多团队会议记录汇总分析

从 KDocs 云文档批量读取多个团队的会议记录，自动提取结论/待办/风险，生成结构化 Word 分析报告和可交互 HTML 会议看板。

## 前置依赖

- **Node.js** 18+
- **kdocs-cli** — KDocs MCP CLI 工具（用于读取云文档）
- **npm 依赖** — 运行 `node scripts/setup.js` 时会自动检查并安装；也可手动执行 `npm install`

## 快速开始

### 1. 初始化配置

```bash
node scripts/setup.js
```

交互式引导创建 `config.json`，输入团队名称、KDocs 文件夹链接、重要参会人等。

也可以复制 `config.example.json` 手动编辑：

```bash
cp config.example.json config.json
```

### 2. 批量读取文档

```bash
node scripts/batch-read-documents.js <起始日期> <结束日期>
```

示例：`node scripts/batch-read-documents.js 04-01 04-30`

自动扫描所有团队文件夹，5 路并发读取文档内容，提取结论和待办。

### 3. 生成报告

```bash
# 单团队报告
node scripts/generate-team-report.js 04-01 04-30

# 综合分析报告（跨团队视角）
node scripts/generate-comprehensive-report.js 04-01 04-30
```

### 4. 生成看板（可选）

```bash
node scripts/generate-kanban.js
```

生成可交互的 HTML 会议看板（团队 × 周次矩阵视图）。

## 输出目录

脚本生成的 JSON、Markdown、Word 报告和 HTML 看板统一写入 `outputs/` 目录。为兼容旧数据，读取输入数据时会优先查找 `outputs/`，找不到时再回退到项目根目录的历史文件。

## LLM 分析

报告生成支持 LLM 深度分析。OpenClaw 用户无需额外配置，自动检测环境调用 LLM。全部不可用时自动回退到规则分析。

如需手动配置 API，在 `config.json` 中添加：

```json
{
  "llm": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-xxx",
    "model": "gpt-4o"
  }
}
```

详细说明见 [SKILL.md](SKILL.md)。

## 文件结构

```
├── config.example.json    # 配置模板
├── config.json            # 用户配置（.gitignore 排除）
├── package.json           # 依赖声明
├── SKILL.md               # 完整文档
├── outputs/               # 生成物目录（JSON / Markdown / DOCX / HTML）
└── scripts/
    ├── setup.js                        # 引导式配置
    ├── resolve-drive-ids-v2.js         # 解析 link_id → drive_id
    ├── shared.js                       # 共享模块
    ├── batch-read-documents.js         # 批量读取文档
    ├── reconstruct-from-cache.js       # 离线从缓存重建数据
    ├── generate-team-report.js         # 单团队报告（完成后自动生成看板）
    ├── generate-comprehensive-report.js # 综合报告
    ├── generate-kanban.js              # 会议看板
    └── enrich-meeting-data.js          # URL 补充
```
