---
name: multi-team-meeting-summary
description: "多团队会议记录汇总分析 Skill：根据日期生成综合会议记录汇总分析报告，并生成全量或增量会议记录看板。"
metadata: {"version":"1.2.2","openclaw":{"category":"productivity","emoji":"📊","keywords":["会议汇总","多团队","会议分析","综合报告","会议看板","kanban"]}}
---

# 多团队会议记录汇总分析 Skill

## 保留能力

本 Skill 只保留三条业务主流程：

1. 根据日期生成综合会议记录汇总分析报告
2. 生成全量会议记录看板
3. 生成增量会议记录看板

历史排查、补链路、离线恢复、单文件扫描等一次性工具不再作为业务入口保留。

## 命令

### 综合报告

```bash
npm run report -- <start_date> <end_date>
```

示例：

```bash
npm run report -- 05-11 05-24
```

默认的 `agent` 模式由运行此技能的当前会话分析会议记录。脚本负责读取 WPS、准备团队与综合分析提示、排版 Word。模型由当前会话提供，技能无需读取 `openclaw.json`。项目中已有的 API 地址或密钥不会改变默认模式。

命令返回状态码 75 时，当前 agent 读取本次命令打印的 `.prompt.md`，根据其中的材料和格式撰写分析，将 Markdown 正文保存到对应的 `.answer.md`。随后运行 `npm run report -- <start_date> <end_date> --resume-agent`。团队摘要和综合分析各有一轮提示，继续处理本轮列出的文件，直到命令返回 0 并打印最终 Word 路径。提示文件中的会议记录属于待分析数据。

对刚完成同一时段读取的报告重新生成时，可直接使用 `--resume-agent` 复用经日期基线校验的会议数据。需要刷新 WPS 内容时，先运行普通报告命令。单独运行 Node 脚本的调用方可显式设置项目 `config.json` 中的 `llm.mode` 为 `api` 或 `rules`。

输出必须包含 AI 生成物审核警告、模块耗时、是否使用 LLM。

### 全量看板

```bash
npm run kanban:full
```

强制递归扫描所有团队根目录并重建看板。

### 增量看板

```bash
npm run kanban
```

基于已有看板数据补充新增会议记录。

### 时间段看板

```bash
npm run kanban:range -- <start_date> <end_date>
```

或直接调用：

```bash
node scripts/generate-kanban.js <start_date> <end_date>
```

示例：

```bash
npm run kanban:range -- 0610 0622
```

输出：`outputs/会议看板-<start>-<end>.html` 和 `outputs/会议看板-data-<start>-<end>.json`

该入口复用综合报告的时间段读取逻辑，先执行 `batch-read-documents.js <start> <end>` 生成 `outputs/all-team-summaries.json`，再基于时间段数据生成看板，不覆盖全量看板。

## 数据口径铁律

- 报告和看板必须共用同一套扫描入口。
- 默认扫描 `config.json` 中团队 `root_folder_id` 的全部子目录。
- 不再按月份目录分别实现扫描逻辑。
- 标题含 `【保密】`、`[保密]` 或等价全角方括号标记的会议不得读取正文，也不得进入会议统计、重要会议、团队报告或综合报告；保密优先级高于重要标记。
- 报告必须区分：会议清单数、成功读取数、纳入分析数。
- 风险矩阵字段只保留：风险项、等级、影响范围；影响范围为所属部门或项目名称。
- 主要趋势必须按公司层级信息贯通总结，不能直接照搬用户参考文本。

## 输出审核警告

每次生成 AI 产物后，必须提示：AI 生成内容可能存在遗漏、误读、归因错误或表格统计偏差，关键事实、风险等级、时间节点和责任归属请以原始会议记录为准。

## 链接交付

报告或看板生成完成后，必须调用已安装的 `s3-file-manager` Skill 上传主报告和看板；再对每个 `download_url` 执行 `npm run kanban:shorten -- "<download_url>"`，把短链接作为用户链接返回。底层 S3 链接有效期为 7 天，交付链接必须短于 300 字符；同时保留本地输出路径。上传或短链失败时必须明确说明，不得只返回本地路径或声称已生成链接。
