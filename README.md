# 多团队会议记录汇总分析工具

从 KDocs 云文档递归扫描会议记录，按日期生成综合会议记录汇总分析报告，并生成会议记录看板。

## 保留的业务入口

### 1. 根据日期生成综合会议记录汇总分析报告

```bash
npm run report -- 05-11 05-24
```

等价于：

```bash
node scripts/generate-report.js 05-11 05-24
```

该入口会完整执行主流程：

1. 递归扫描 `config.json` 中每个团队的 KDocs 根目录。
2. 按标题日期或正文会议日期过滤到指定日期范围。
3. 读取会议正文并生成统一数据基线。
4. 生成团队 LLM 摘要，供综合报告汇总使用。
5. 生成 `outputs/综合分析报告-<start>-<end>.docx`。

生成结束会输出 AI 产物审核警告、各模块耗时、是否使用 LLM，以及统计文件位置。

### 2. 生成全量会议记录看板

```bash
npm run kanban:full
```

等价于：

```bash
node scripts/kanban-full.js
```

该入口强制递归扫描所有配置团队的 KDocs 根目录，重建：

- `outputs/会议看板-data.json`
- `outputs/会议看板.html`

### 3. 生成增量会议记录看板

```bash
npm run kanban
```

等价于：

```bash
node scripts/kanban-incremental.js
```

该入口基于已有看板数据做增量补新。若本地没有看板数据，会自动走全量扫描。

### 4. 生成时间段会议记录看板

```bash
node scripts/generate-kanban.js 0610 0622
```

也可以写成：

```bash
node scripts/generate-kanban.js 06-10 06-22
```

该入口会先复用综合报告的数据读取逻辑，即执行同一套 `batch-read-documents.js <start> <end>` 时间段扫描和正文读取，再基于生成的 `outputs/all-team-summaries.json` 生成时间段看板。

输出不会覆盖全量看板：

- `outputs/会议看板-data-0610-0622.json`
- `outputs/会议看板-0610-0622.html`

## 数据口径

报告和看板共用同一套扫描入口：默认使用团队 `root_folder_id` 递归扫描，再按会议日期过滤。不要再按月份目录分别拼扫描逻辑。

报告基线文件：

```text
outputs/meeting-baseline-<start>-<end>.json
```

基线中区分三类数量：

- `meetingListCount`：日期范围内会议清单数
- `successfulReadCount`：成功读取正文或结构化内容的文档数
- `analyzedDocumentCount`：纳入报告分析的文档数

## 输出

主要输出都在 `outputs/`：

- `综合分析报告-*.docx`
- `会议看板.html`
- `会议看板-data.json`
- `会议看板-<start>-<end>.html`
- `会议看板-data-<start>-<end>.json`
- `main-report-generation-stats.json`
- `report-generation-stats.json`
- `comprehensive-report-generation-stats.json`

## 配置

`config.json` 存放 KDocs token、团队根目录和 LLM 配置，已被 `.gitignore` 排除，不能提交。

新增团队或目录时，维护 `config.json` 中的团队 `root_folder_id` 即可。系统默认递归扫描根目录，新增月份或子目录不需要额外写扫描逻辑。

## 验证

```bash
npm test
```
