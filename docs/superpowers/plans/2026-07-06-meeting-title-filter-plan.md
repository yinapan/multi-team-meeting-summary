# 会议标题标签过滤功能 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在综合会议记录汇总分析管道中，根据标题标签【保密】跳过会议、根据【重要】标记并提高权重

**Architecture:** 在 `shared.js` 新增 `classifyMeetingTitle` 工具函数，在 `batch-read-documents.js` 预过滤阶段跳过【保密】文件，在 `extractInfo` 后标记 `isKeyMeeting`，在 `generate-team-report.js` 中将 `isKeyMeeting` 纳入权重提升

**Tech Stack:** Node.js, KDocs CLI

## 全局约束

- 仅影响综合报告管道，看板不受影响
- 【保密】不读正文，不纳分析，不计入 meetingListCount
- 【重要】新增独立字段 `isKeyMeeting`，不与 `important` 合并
- baseline 新增 `confidentialExcluded` / `confidentialExcludedCount`
- 无 config 配置项，标签名称固定

---

### Task 1: 在 `shared.js` 新增 `classifyMeetingTitle` 函数

**Files:**
- Modify: `scripts/shared.js`（在 `classifyMeetingType` 附近插入）

**Interfaces:**
- Consumes: nothing
- Produces: `classifyMeetingTitle(fileName: string): { confidential: boolean, keyMeeting: boolean }`

- [ ] **Step 1: 新增函数并添加到导出**

在 `classifyMeetingType` 函数之后（约 1979 行后）插入：

```js
function classifyMeetingTitle(fileName) {
  const name = String(fileName || '');
  return {
    confidential: /【保密】/.test(name),
    keyMeeting: /【重要】/.test(name)
  };
}
```

- [ ] **Step 2: 在模块导出中添加 `classifyMeetingTitle`**

找到 `scripts/shared.js` 文件末尾的 `module.exports` / exports 块（约 3570 行），在导出列表中加入 `classifyMeetingTitle`。

在 `classifyMeetingType,` 附近新增：

```js
  classifyMeetingTitle,
  classifyMeetingType,
```

- [ ] **Step 3: 验证编译**

```bash
node -e "const { classifyMeetingTitle } = require('./scripts/shared'); console.log(JSON.stringify(classifyMeetingTitle('【重要】产品周会'))); console.log(JSON.stringify(classifyMeetingTitle('【保密】HR会议'))); console.log(JSON.stringify(classifyMeetingTitle('普通周会')))"
```

预期输出：
```
{"confidential":false,"keyMeeting":true}
{"confidential":true,"keyMeeting":false}
{"confidential":false,"keyMeeting":false}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/shared.js
git commit -m "feat(shared): 新增 classifyMeetingTitle 函数识别【保密】【重要】标题标签
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 在 `batch-read-documents.js` 实现【保密】预过滤 + 【重要】标记

**Files:**
- Modify: `scripts/batch-read-documents.js`（多处改动，约第 5、49、63-84、86-134、137-194、204-243 行）
- Test: `scripts/test-baseline-contract.js`（检查是否需要更新 baseline 预期）

**Interfaces:**
- Consumes: `classifyMeetingTitle` from shared.js
- Produces: `allTeamsData[].confidentialExcluded`, `allTeamsData[].confidentialExcludedCount`, `doc.isKeyMeeting`

- [ ] **Step 1: 在文件顶部 import `classifyMeetingTitle`**

修改第 5 行的 require：

```js
const { resolveWorkspaceDir, getWeekKey, normalizeDate, dateInRange, extractMeetingDate, teamDocsCacheDir, treeDocCacheFile, ensureCacheDir, readCache, scanAllTeams, RequestPacer, extractInfo, getKdocsConfig, outputPath, writeOutputJson, writeMeetingBaseline, readDocAsync, runPool, classifyMeetingTitle } = require('./shared');
```

- [ ] **Step 2: 在所有团队循环中增加【保密】预过滤**

在 `batch-read-documents.js` 约第 82 行（`preFilteredOut` 日志输出之后，`preFilteredFiles` 定义之后），新增：

```js
    const confidentialFiles = [];
    const nonConfidentialFiles = preFilteredFiles.filter(f => {
      const tags = classifyMeetingTitle(f.name);
      if (tags.confidential) {
        confidentialFiles.push(f);
        return false;
      }
      return true;
    });
    if (confidentialFiles.length > 0) {
      console.log(`  【保密】过滤: 跳过 ${confidentialFiles.length} 篇保密会议，不提取内容`);
    }
```

然后将后续 `preFilteredFiles` 的引用替换为 `nonConfidentialFiles`（即第 86 行 `const tasks = preFilteredFiles.map(...)` 改为 `nonConfidentialFiles.map(...)`，以及第 103 行 `num === preFilteredFiles.length` 改为 `nonConfidentialFiles.length`）。

- [ ] **Step 3: 在 `extractInfo` 之后标记 `isKeyMeeting`**

在约第 121 行 `extractInfo(md, f.name, teamPeople)` 之后、`info.meetingDate` 赋值之前，新增：

```js
        info.isKeyMeeting = classifyMeetingTitle(f.name).keyMeeting;
```

- [ ] **Step 4: 在空占位文档中也标记 `isKeyMeeting`（约 154 行，`unreadable: true` 之前）**

```js
        isKeyMeeting: classifyMeetingTitle(f.name).keyMeeting,
```

- [ ] **Step 5: 更新 `meetingListItems` 和 `excludedMeetings` 统计（约 166-174 行）**

在 `analyzedIds` 行（约 164 行）之后新增 `confidentialIds`：

```js
    const confidentialIds = new Set(confidentialFiles.map(f => f.id).filter(Boolean));
```

然后修改 `meetingListItems`（约 166 行），过滤掉保密文件：

```js
    const meetingListItems = allFiles
      .filter(f => !confidentialIds.has(f.id) && dateInRange(f.name, startDate, endDate, f._readContent || '', f.mtime, f.ctime, f.folderName))
      .map(f => ({ name: f.name, id: f.id, url: f.link || '', sourceLabel: f.sourceLabel || null }));
```

在 `excludedMeetings` 定义后新增 `confidentialExcluded`：

```js
    const confidentialExcluded = confidentialFiles.map(f => ({
      name: f.name, id: f.id, url: f.link || '', reason: 'confidential', sourceLabel: f.sourceLabel || null
    }));
```

- [ ] **Step 6: 更新 `allTeamsData.push` 对象，新增字段（约 184-194 行）**

在 push 的对象中新增两行：

```js
      confidentialExcluded,
      confidentialExcludedCount: confidentialExcluded.length,
```

同时更新空团队分支（约 65 行）：

```js
      allTeamsData.push({ team: teamCfg.name, documents: [], totalScanned: 0, meetingListCount: 0, unreadableMeetings: [], excludedMeetings: [], confidentialExcluded: [], confidentialExcludedCount: 0 });
```

- [ ] **Step 7: 更新 `teamSummaries` 构建，让 LLM 提示词感知权重（约 209-220 行）**

在 `meetings.push` 对象中加入 `isKeyMeeting`：

```js
        title: doc.name.replace(/\.(\w+)$/i, ''),
        url: doc.url || '',
        participants: doc.participants,
        meetingTime: doc.meetingTime,
        conclusions: doc.conclusions,
        todos: doc.todos,
        important: doc.important,
        isKeyMeeting: doc.isKeyMeeting || false,
        rawContent: doc.rawContent || '',
        sourceLabel: doc.sourceLabel || null,
        meetingDate: doc.meetingDate || null
```

- [ ] **Step 8: 验证语法**

```bash
node -e "require('./scripts/batch-read-documents.js')" 2>&1 | head -5
```

预期：不报 require 错误（允许缺少参数报 usage 提示）。

- [ ] **Step 9: 运行现有测试确认无回归**

```bash
npm test
```

预期：全部 PASS。如果 `test-baseline-contract.js` 失败，检查 baseline 预期字段是否需要更新。

- [ ] **Step 10: Commit**

```bash
git add scripts/batch-read-documents.js
git commit -m "feat(batch-read): 实现【保密】预过滤和【重要】标记
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 在 `generate-team-report.js` 中对 `isKeyMeeting` 给予权重提升

**Files:**
- Modify: `scripts/generate-team-report.js`（两处：prompt 构建 + importantCount 计算）

**Interfaces:**
- Consumes: `isKeyMeeting` from documents data
- Produces: LLM prompt with higher emphasis on key meetings

- [ ] **Step 1: 在团队报告提示词中标记【重要】会议**

找到 `buildTeamReportPrompt` 的调用处（约 378 行），在 documents 构建时加入 `isKeyMeeting`：

```js
          documents.push({ name: m.title, conclusions: m.conclusions || [], todos: m.todos || [], important: m.important, isKeyMeeting: m.isKeyMeeting || false, rawContent: m.rawContent || '', sourceLabel: m.sourceLabel || null, meetingDate: m.meetingDate || null });
```

- [ ] **Step 2: 在 LLM prompt 构建中对 `isKeyMeeting` 会议做特殊标记**

在 `shared.js` 的 `buildTeamReportPrompt` 函数中（约 3222 行），修改会议标题行：

```js
    const keyTag = doc.isKeyMeeting ? '【重要会议-重点分析】' : '';
    const impTag = doc.important ? '（重要会议）' : '';
    parts.push(`### ${name}${keyTag}${impTag}`);
```

- [ ] **Step 3: 统计 `keyMeetingCount` 并在报告中展示**

在 `generate-team-report.js` 中（约 273 行 `importantCount` 旁边），新增：

```js
  const keyMeetingCount = data.documents.filter(d => d.isKeyMeeting).length;
```

在报告表格中（约 305 行 `importantCount` 行附近），新增一行：

```js
            ...(keyMeetingCount > 0 ? [new TableRow({ children: [cCell("【重要】标记会议数量", 3000), cCell(`${keyMeetingCount}份`, 6026)] })] : [])
```

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-team-report.js scripts/shared.js
git commit -m "feat(team-report): 【重要】会议在LLM提示词中给予权重提升
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 端到端验证

**Files:**
- 无新建文件

- [ ] **Step 1: 创建测试用的 mock 数据验证过滤逻辑**

```bash
node -e "
const { classifyMeetingTitle } = require('./scripts/shared');
// Test 【保密】
const r1 = classifyMeetingTitle('【保密】季度财务会议.otl');
console.assert(r1.confidential === true, '【保密】should be confidential');
console.assert(r1.keyMeeting === false, '【保密】should not be key');
// Test 【重要】
const r2 = classifyMeetingTitle('241231【重要】产品评审.docx');
console.assert(r2.confidential === false, '【重要】should not be confidential');
console.assert(r2.keyMeeting === true, '【重要】should be key');
// Test both
const r3 = classifyMeetingTitle('【保密】【重要】特殊会议.wpp');
console.assert(r3.confidential === true, 'both tags should detect confidential');
console.assert(r3.keyMeeting === true, 'both tags should detect key');
// Test none
const r4 = classifyMeetingTitle('普通周会.otl');
console.assert(r4.confidential === false, 'normal should not be confidential');
console.assert(r4.keyMeeting === false, 'normal should not be key');
console.log('All classifyMeetingTitle tests passed');
"
```

- [ ] **Step 2: 运行全量测试套件**

```bash
npm test
```

预期：所有测试 PASS。

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "test: 端到端验证标签过滤逻辑通过
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```