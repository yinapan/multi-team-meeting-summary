# 会议标题标签过滤功能 — 设计文档

**日期**: 2026-07-06  
**版本**: 1.0  
**关联需求**: 综合会议记录汇总分析增加【保密】排除和【重要】强调功能

---

## 1. 概述

在综合会议记录汇总分析报告中，根据会议标题中的标签实现两类特殊处理：

- **【保密】**：不提取正文，不纳入分析，不参与计数
- **【重要】**：标记 `isKeyMeeting: true`（独立于现有 `important` 字段），在 LLM 摘要和报告中给予更高权重

### 1.1 适用范围

- ✅ 综合报告（`.docx`）— 完全生效
- ✅ 团队 LLM 摘要 — 权重提升生效
- ❌ 看板（kanban）— 不受影响，照常显示所有会议

---

## 2. 数据流变更

### 2.1 当前流程

```
扫描文件列表 → 日期预过滤 → 读取正文(API) → extractInfo → 团队摘要 → 综合报告
```

### 2.2 变更后流程

```
扫描文件列表 → 日期预过滤 → 【保密】过滤(跳过API) → 读取正文(API)
  → extractInfo → 标记【重要】 → 团队摘要(权重↑) → 综合报告(权重↑)
```

---

## 3. 详细设计

### 3.1 `shared.js` — 新增 `classifyMeetingTitle` 函数

```js
function classifyMeetingTitle(fileName) {
  const name = String(fileName || '');
  return {
    confidential: /【保密】/.test(name),
    keyMeeting: /【重要】/.test(name)
  };
}
```

**位置**: 放在 `classifyMeetingType` 函数附近（约 1980 行），与现有会议分类函数保持一致的代码组织风格。

**设计原则**:
- 纯函数，无副作用
- 返回简单结构体 { confidential, keyMeeting }
- 不依赖配置项（标签名称固定，不易变）

### 3.2 `batch-read-documents.js` — 过滤与标记

#### 3.2.1 【保密】预过滤（约第 86 行后）

在 `preFilteredOut`（日期范围过滤）完成后，对 `preFilteredFiles` 做第二层过滤：

```
preFilteredFiles → 按标题分类:
  ├─ 含【保密】→ confidentialFiles（跳过 API 读取，不计入分析）
  └─ 其余 → 正常读取流程
```

**统计口径**：
- `confidentialExcluded`：排除的保密会议列表（含 name, id, url, reason: "confidential"）
- `confidentialExcludedCount`：保密排除数量
- `meetingListCount`：**不包含**保密会议（保密文件不计入清单数）
- `analyzedDocumentCount`：**不包含**保密会议

#### 3.2.2 【重要】标记（约第 119 行，extractInfo 之后）

```js
const tags = classifyMeetingTitle(f.name);
info.isKeyMeeting = tags.keyMeeting;
```

`isKeyMeeting` 独立于现有的 `important`（后者由参会人是否包含 `important_people` 判定）。

#### 3.2.3 团队数据导出

`allTeamsData` 每个 team entry 新增字段：
- `confidentialExcluded: [...]`
- `confidentialExcludedCount: number`

baseline 数据同步新增对应字段。

### 3.3 `generate-comprehensive-report.js` — LLM 权重提升

在构建 LLM prompt 时，对 `isKeyMeeting: true` 的文档：

1. 在 conclusions/todos 文本前添加 `【重要会议】` 前缀
2. 在 prompt 指令中增加："标记为【重要会议】的内容需重点提取和分析，在摘要中优先呈现"

### 3.4 `generate-team-report.js` — 团队摘要权重提升

在团队摘要生成时，对 `isKeyMeeting: true` 的文档的 conclusions/todos 给予更高优先级提取。

---

## 4. 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `scripts/shared.js` | 新增函数 | `classifyMeetingTitle` |
| `scripts/batch-read-documents.js` | 修改 | 【保密】过滤 + 【重要】标记 + 新增统计字段 |
| `scripts/generate-comprehensive-report.js` | 修改 | LLM prompt 权重提升 |
| `scripts/generate-team-report.js` | 修改 | 团队摘要权重提升 |

---

## 5. 兼容性

- **缓存兼容**：`classifyMeetingTitle` 仅基于文件名判断，不依赖缓存数据
- **看板兼容**：看板（全量/增量/时间段）通过 `generate-kanban.js` 独立扫描和构建，有自己的数据文件（`会议看板-data.json`），与报告管道完全独立。本功能不改动任何看板相关代码，看板照常显示所有会议。
- **基线兼容**：baseline 新增字段为增量添加，不破坏现有字段结构
- **向后兼容**：现有 `important` 字段不受影响，`isKeyMeeting` 为独立新增字段

---

## 6. 测试要点

1. 【保密】会议不触发 API 读取（验证无 read-file 调用）
2. 【保密】会议不出现在 `meetingListCount` 和 `analyzedDocumentCount` 中
3. 【保密】会议出现在 `confidentialExcluded` 列表中
4. 【重要】会议的 `isKeyMeeting` 字段为 `true`
5. 既无【保密】也无【重要】的会议不受影响
6. 看板数据不受标签过滤影响（全量看板仍然显示）

---

## 7. 相关引用

- 现有重要人物判定：`config.json` → `important_people`
- 现有会议分类函数：`shared.js` → `classifyMeetingType`
- 基线统计：`shared.js` → `createMeetingBaseline`