# 多团队会议记录汇总分析工具使用指南

## 只保留三个业务入口

### 生成综合会议记录汇总分析报告

```bash
npm run report -- 05-11 05-24
```

输出：`outputs/综合分析报告-0511-0524.docx`

该命令会自动完成读取、团队摘要、综合报告生成，并在终端输出：

- AI 生成物请人工核实的重要警告
- 每个模块耗时
- 是否使用 LLM
- 生成统计文件位置

### 生成全量会议记录看板

```bash
npm run kanban:full
```

输出：`outputs/会议看板.html`

用于重建全量看板。默认优先使用本地缓存，只有正文缓存缺失、过期或目录缓存不存在时才调用 KDocs API。

强制联网刷新：

```bash
node scripts/generate-kanban.js --refresh
```

### 生成增量会议记录看板

```bash
npm run kanban
```

输出：`outputs/会议看板.html`

用于日常更新，只补充新增会议记录。

### 生成时间段会议记录看板

```bash
node scripts/generate-kanban.js 0610 0622
```

输出：`outputs/会议看板-0610-0622.html`

用于只生成指定日期范围内的会议记录看板。该入口复用综合报告的时间段读取逻辑，会先生成对应范围的 `outputs/all-team-summaries.json`，再用这份时间段数据生成看板，不读取全量看板数据。

## 数据口径说明

系统默认读取 `config.json` 里的团队 `root_folder_id`，递归扫描所有子文件夹，再按会议日期过滤。报告和看板共用同一个扫描入口，避免出现两套数量。

报告中会区分：

- 会议清单数
- 成功读取数
- 纳入分析数

这三个数字写入 `outputs/meeting-baseline-<start>-<end>.json`。

## 人工审核要求

所有 `.docx` 报告都是 AI 生成物。对外发送前必须人工复核：

- 关键事实
- 风险等级
- 时间节点
- 责任部门或项目
- 数字和预算

原始会议记录始终是最终依据。
