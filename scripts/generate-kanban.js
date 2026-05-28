// 看板默认使用7天长缓存，避免频繁API调用触发限流；--refresh 强制刷新
const fs = require('fs');
const path = require('path');
const {
  resolveWorkspaceDir, currentYear, searchFilesAsync, scanFolderAllAsync,
  extractDateFromFileName, extractMeetingDate, getWeekKey, normalizeTitle, normalizeForMatch, charSimilarity, getTeamScanEntries,
  RequestPacer, extractParticipants, teamDocsCacheDir, readCache, getKdocsScanMode, scanFilesByMode,
  outputPath, findInputFile, writeOutputJson
} = require('./shared');
const { readDocAsync, runPool } = require('./batch-read-documents');

const DATA_FILE = '会议看板-data.json';
const HTML_FILE = '会议看板.html';

// ========== 生成 HTML ==========
function generateHtml(kanbanData) {
  const { teams } = kanbanData;
  const allWeeks = new Set();
  let totalMeetings = 0;

  const tableData = teams.map((team, idx) => {
    for (const [wk, meetings] of Object.entries(team.weeks)) {
      totalMeetings += meetings.length;
      allWeeks.add(wk);
    }
    return { id: idx + 1, name: team.name, weeks: team.weeks };
  });

  const sortedWeeks = [...allWeeks].sort();

  const weekLabels = {};
  sortedWeeks.forEach(w => {
    const s = w.substring(0, 4);
    const e = w.substring(5, 9);
    const sm = parseInt(s.substring(0, 2)), sd = parseInt(s.substring(2, 4));
    const em = parseInt(e.substring(0, 2)), ed = parseInt(e.substring(2, 4));
    weekLabels[w] = { label: `${sm}/${sd} - ${em}/${ed}`, dates: `${sm}月${sd}日 — ${em}月${ed}日` };
  });

  const dataJson = JSON.stringify(tableData);
  const weeksJson = JSON.stringify(sortedWeeks);
  const weekLabelsJson = JSON.stringify(weekLabels);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>会议记录看板</title>
<style>
:root {
  --bg: #f5f7fb;
  --panel: #ffffff;
  --panel-soft: #f9fafc;
  --line: #d8dee8;
  --line-strong: #b8c2d2;
  --team-col-width: 200px;
  --week-col-width: 340px;
  --text: #101828;
  --text-soft: #475467;
  --text-faint: #7a8699;
  --blue: #2563eb;
  --blue-soft: #eaf1ff;
  --green: #07886f;
  --green-soft: #e8f7f3;
  --important-bg: #fef3f2;
  --important-border: rgba(180, 35, 24, .22);
  --red: #b42318;
  --orange: #b45309;
  --orange-bg: #fffbeb;
  --orange-border: rgba(180, 83, 9, .22);
  --shadow: 0 8px 24px rgba(16, 24, 40, .06);
  --radius: 8px;
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px; letter-spacing: 0;
  padding-bottom: 22px;
}
button, input, select { font: inherit; }
button { cursor: pointer; }

.app-shell { min-height: 100vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }

.topbar {
  height: 56px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 28px; background: #111827; color: #fff;
  border-bottom: 1px solid rgba(255, 255, 255, .08);
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand-mark {
  width: 28px; height: 28px; border-radius: 7px; background: #2563eb;
  display: grid; place-items: center; color: #fff; font-weight: 800; flex: 0 0 auto;
}
.brand-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.brand-title strong { font-size: 15px; line-height: 1.2; white-space: nowrap; }
.brand-title span { color: rgba(255,255,255,.62); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top-actions { display: flex; align-items: center; gap: 8px; }
.icon-btn {
  width: 34px; height: 34px; border: 1px solid rgba(255,255,255,.12);
  background: rgba(255,255,255,.06); color: rgba(255,255,255,.84);
  border-radius: 7px; display: grid; place-items: center;
}
.icon-btn:hover { background: rgba(255,255,255,.12); color: #fff; }

.summary { padding: 18px 28px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
.summary-grid {
  display: grid; grid-template-columns: minmax(260px, 1.6fr) repeat(4, minmax(120px, .75fr));
  gap: 12px; align-items: stretch;
}
.summary-title { display: flex; flex-direction: column; justify-content: center; min-width: 0; }
.summary-title h1 { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 800; }
.summary-title p { margin: 6px 0 0; color: var(--text-soft); line-height: 1.5; }
.importance-legend {
  display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px;
  color: #475467; font-size: 14px; line-height: 1.35;
}
.legend-item {
  width: fit-content; min-width: 320px; max-width: 100%;
  align-items: center;
}
.legend-item .meeting-title { white-space: nowrap; }
.legend-note { color: inherit; font-weight: 800; }
.metric { background: var(--panel-soft); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
.metric span { display: block; color: var(--text-faint); font-size: 12px; line-height: 1.2; }
.metric strong { display: block; margin-top: 7px; font-size: 24px; line-height: 1; font-weight: 800; }

.workspace { padding: 18px 28px 24px; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.toolbar { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; margin-bottom: 12px; }
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.segmented {
  display: inline-flex; padding: 3px; border-radius: var(--radius);
  background: #e9eef6; border: 1px solid var(--line);
}
.segmented button {
  border: 0; background: transparent; color: var(--text-soft);
  padding: 7px 12px; border-radius: 6px; font-weight: 650; font-size: 13px; white-space: nowrap;
}
.segmented button.active {
  background: #fff; color: var(--blue); box-shadow: 0 1px 2px rgba(16,24,40,.08);
}
.select, .search {
  height: 36px; border: 1px solid var(--line); border-radius: var(--radius);
  background: #fff; color: var(--text);
}
.select { padding: 0 32px 0 12px; }
.multi-select { position: relative; min-width: 168px; }
.multi-trigger {
  width: 100%; height: 36px; border: 1px solid var(--line); border-radius: var(--radius);
  background: #fff; color: var(--text); padding: 0 34px 0 12px; text-align: left;
  font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.multi-trigger::after {
  content: ""; position: absolute; right: 12px; top: 15px; width: 7px; height: 7px;
  border-right: 1.5px solid var(--text-faint); border-bottom: 1.5px solid var(--text-faint);
  transform: rotate(45deg);
}
.multi-select.open .multi-trigger { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
.multi-select.open .multi-trigger::after { top: 18px; transform: rotate(225deg); }
.multi-panel {
  display: none; position: absolute; top: 42px; left: 0; z-index: 20; width: max-content; min-width: 100%;
  max-width: min(360px, calc(100vw - 40px)); max-height: 320px; overflow: auto;
  padding: 6px; background: #fff; border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: 0 16px 36px rgba(16, 24, 40, .16);
}
.multi-select.open .multi-panel { display: block; }
.multi-option {
  display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 6px 8px;
  border-radius: 6px; color: var(--text); cursor: pointer; white-space: nowrap;
}
.multi-option:hover { background: var(--panel-soft); }
.multi-option input { width: 14px; height: 14px; margin: 0; accent-color: var(--blue); flex: 0 0 auto; }
.multi-option-all { color: var(--text-soft); border-bottom: 1px solid var(--line); margin-bottom: 4px; border-radius: 6px 6px 0 0; }
.search-wrap { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.search { width: 280px; padding: 0 12px; outline: none; }
.search:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }

.board {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
  min-height: 0; flex: 1 1 auto; display: flex; flex-direction: column;
}
.board-caption {
  min-height: 42px; padding: 10px 14px; display: flex; align-items: center;
  justify-content: space-between; gap: 12px;
  border-bottom: 1px solid var(--line); background: var(--panel-soft);
}
.caption-left { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text-soft); }
.pill {
  display: inline-flex; align-items: center; height: 24px; padding: 0 8px;
  border-radius: 999px; border: 1px solid var(--line); background: #fff;
  color: var(--text-soft); font-size: 12px; font-weight: 650; white-space: nowrap;
}
.status-important {
  background: #fff7f5; color: var(--red);
  border-color: rgba(180, 35, 24, .42); font-weight: 800;
}
.status-important-orange {
  background: #fffdf4; color: var(--orange);
  border-color: rgba(180, 83, 9, .52); font-weight: 800;
}

.table-scroll {
  overflow: auto; height: auto; min-height: 300px; max-height: none; flex: 1 1 auto;
  scrollbar-gutter: stable both-edges; overscroll-behavior: contain;
}
.table-scroll::-webkit-scrollbar { width: 12px; height: 12px; }
.table-scroll::-webkit-scrollbar-track { background: #eef2f7; border-radius: 999px; }
.table-scroll::-webkit-scrollbar-thumb { background: #98a2b3; border: 3px solid #eef2f7; border-radius: 999px; }
.table-scroll::-webkit-scrollbar-thumb:hover { background: #667085; }
.table-scroll::-webkit-scrollbar-corner { background: #eef2f7; }

.fixed-x-scroll {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
  height: 20px; overflow-x: auto; overflow-y: hidden;
  background: rgba(245, 247, 251, .96); border-top: 1px solid var(--line);
  scrollbar-gutter: stable; display: none;
}
.fixed-x-scroll.visible { display: block; }
.fixed-x-scroll-inner { height: 1px; }
.fixed-x-scroll::-webkit-scrollbar { height: 14px; }
.fixed-x-scroll::-webkit-scrollbar-track { background: #eef2f7; }
.fixed-x-scroll::-webkit-scrollbar-thumb { background: #98a2b3; border: 3px solid #eef2f7; border-radius: 999px; }
.fixed-x-scroll::-webkit-scrollbar-thumb:hover { background: #667085; }

table { width: max-content; border-collapse: separate; border-spacing: 0; table-layout: fixed; }
th, td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); vertical-align: top; }
th {
  position: sticky; top: 0; z-index: 4; background: #f2f5f9;
  padding: 11px 12px; text-align: left; font-size: 12px;
  color: var(--text-soft); font-weight: 800; white-space: nowrap;
}
th:not(:first-child), td:not(:first-child) {
  width: var(--week-col-width); min-width: var(--week-col-width); max-width: var(--week-col-width);
}
th:first-child, td:first-child {
  position: sticky; left: 0; z-index: 5; border-right: 1px solid var(--line-strong);
  width: var(--team-col-width); min-width: var(--team-col-width); max-width: var(--team-col-width);
}
th:first-child { z-index: 8; }
td:first-child { background: #fff; }
td { padding: 10px; background: #fff; min-height: 96px; }
tbody tr:hover td, tbody tr:hover td:first-child { background: #fbfdff; }
tr:last-child td { border-bottom: 0; }
th:last-child, td:last-child { border-right: 0; }

.team-cell { display: flex; flex-direction: column; gap: 8px; }
.team-name { font-weight: 800; line-height: 1.35; }
.team-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.tag {
  display: inline-flex; align-items: center; height: 22px; padding: 0 7px;
  border-radius: 5px; background: var(--panel-soft); border: 1px solid var(--line);
  color: var(--text-soft); font-size: 12px; white-space: nowrap;
}

.week-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.week-head strong { color: var(--text); font-size: 13px; }
.week-head span { color: var(--text-faint); font-size: 12px; }

.meeting-list { display: flex; flex-direction: column; gap: 6px; }
.meeting {
  display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 10px;
  padding: 12px 12px 12px 14px; border: 1px solid #d9e1f2; border-left-width: 3px;
  border-left-color: var(--line-strong); border-radius: 8px;
  background: #fff; min-width: 0;
}
.meeting.important { border-left-color: var(--red); background: #fff3f0; border-color: #f1c5bd; }
.meeting.important-orange { border-left-color: var(--orange); background: #fff8e6; border-color: #ead8ad; }
.date { color: #667085; font-size: 16px; line-height: 28px; white-space: nowrap; }
.meeting-main { min-width: 0; }
.meeting-title {
  color: var(--text); text-decoration: none; line-height: 1.45;
  font-size: 16px; font-weight: 750; overflow-wrap: anywhere;
  display: block;
}
.meeting-title:hover { color: var(--blue); }
.meeting.important .meeting-title { color: var(--red); font-weight: 800; }
.meeting.important .meeting-title:hover { color: #7a1610; }
.meeting.important-orange .meeting-title { color: var(--orange); font-weight: 800; }
.meeting.important-orange .meeting-title:hover { color: #92400e; }
.title-flag {
  display: inline-flex; align-items: center; height: 28px; padding: 0 9px;
  margin-right: 5px; border-radius: 8px; border: 1px solid;
  font-size: 16px; line-height: 1; vertical-align: 1px; white-space: nowrap;
}
.matrix-date { font-size: 13px; line-height: 24px; }
.matrix-meeting-title { font-size: 14px; line-height: 1.42; }
.matrix-title-flag {
  height: 22px; padding: 0 7px; border-radius: 6px;
  font-size: 13px; margin-right: 4px; vertical-align: 0;
}
.title-separator { margin: 0 5px 0 0; color: currentColor; font-weight: 800; }
.hl { background: #fde68a; color: #78350f; border-radius: 2px; padding: 0 2px; font-weight: 700; }

.empty { height: 88px; display: grid; place-items: center; color: var(--text-faint); }
.empty::before { content: ""; width: 22px; height: 2px; border-radius: 999px; background: var(--line-strong); }

.compact .meeting:nth-child(n+4) { display: none; }
.show-more {
  height: 28px; border: 1px dashed var(--line-strong); border-radius: 7px;
  background: #fff; color: var(--text-soft); font-size: 12px; font-weight: 650; width: 100%;
}
.show-more:hover { border-color: var(--blue); color: var(--blue); background: var(--blue-soft); }

.empty-state { text-align: center; padding: 60px 20px; color: var(--text-faint); }
.empty-state-title { font-size: 15px; font-weight: 600; color: var(--text-soft); }
.empty-state-sub { font-size: 13px; margin-top: 6px; }

.footer-note { margin-top: 10px; color: var(--text-faint); font-size: 12px; }

@media (max-width: 980px) {
  .topbar { padding: 0 16px; }
  .summary, .workspace { padding-left: 16px; padding-right: 16px; }
  .summary-grid { grid-template-columns: 1fr 1fr; }
  .summary-title { grid-column: 1 / -1; }
  .toolbar { grid-template-columns: 1fr; }
  .search-wrap { justify-content: stretch; }
  .search { width: 100%; }
  .table-scroll { min-height: 320px; }
}
@media (max-width: 560px) {
  .brand-title span { display: none; }
  .summary-grid { grid-template-columns: 1fr; }
  .segmented { width: 100%; }
  .segmented button { flex: 1; }
  .filters { align-items: stretch; }
  .select, .multi-select { width: 100%; }
  .top-actions .icon-btn:nth-child(1) { display: none; }
  .table-scroll { min-height: 300px; }
}
@media (min-width: 1800px) {
  :root { --team-col-width: 220px; --week-col-width: 360px; }
}
@media (min-width: 2560px) {
  :root { --team-col-width: 260px; --week-col-width: 380px; }
  th, td { padding-left: 14px; padding-right: 14px; }
}
</style>
</head>
<body>
<main class="app-shell">
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">会</div>
      <div class="brand-title">
        <strong>会议记录看板</strong>
        <span>按团队、周次、重要程度快速定位会议纪要</span>
      </div>
    </div>
    <div class="top-actions">
      <button class="icon-btn" title="刷新数据" onclick="location.reload()">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M20 6v5h-5M4 18v-5h5M18 9a7 7 0 0 0-11.5-2.5L4 9m2 6a7 7 0 0 0 11.5 2.5L20 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </header>

  <section class="summary">
    <div class="summary-grid">
      <div class="summary-title">
        <h1>${currentYear()} 年会议纪要总览</h1>
        <p>把高频例会、项目周会和重点事项放在一张可筛选的工作表里，优先保证阅读速度和定位效率。</p>
        <div class="importance-legend" aria-label="重要会议着色规则">
          <span class="legend-item meeting important">
            <span class="date matrix-date">05/08</span>
            <span class="meeting-main">
              <span class="meeting-title matrix-meeting-title"><span class="title-flag matrix-title-flag status-important">红色重要</span><span class="legend-note">公司领导参加</span></span>
            </span>
          </span>
          <span class="legend-item meeting important-orange">
            <span class="date matrix-date">05/08</span>
            <span class="meeting-main">
              <span class="meeting-title matrix-meeting-title"><span class="title-flag matrix-title-flag status-important-orange">橙色重要</span><span class="legend-note">一级部门负责人参加</span></span>
            </span>
          </span>
        </div>
      </div>
      <div class="metric"><span>团队</span><strong id="teamCount">0</strong></div>
      <div class="metric"><span>会议记录</span><strong id="meetingCount">0</strong></div>
      <div class="metric"><span>重要标记</span><strong id="importantCount">0</strong></div>
      <div class="metric"><span>覆盖周次</span><strong id="weekCount">0</strong></div>
    </div>
  </section>

  <section class="workspace">
    <div class="toolbar">
      <div class="filters">
        <div class="segmented" id="segmented">
          <button class="active" data-filter="all">全部</button>
          <button data-filter="red">红色重要</button>
          <button data-filter="orange">橙色重要</button>
          <button data-filter="recent">最近两周</button>
        </div>
        <div class="multi-select" id="teamFilter">
          <button class="multi-trigger" id="teamTrigger" type="button">全部团队</button>
          <div class="multi-panel" id="teamPanel"></div>
        </div>
        <div class="multi-select" id="weekFilter">
          <button class="multi-trigger" id="weekTrigger" type="button">全部周次</button>
          <div class="multi-panel" id="weekPanel"></div>
        </div>
      </div>
      <div class="search-wrap">
        <input class="search" id="searchBox" type="search" placeholder="搜索会议、项目或团队">
      </div>
    </div>

    <div class="board">
      <div class="board-caption">
        <div class="caption-left">
          <span class="pill" id="resultPill">0 条记录</span>
          <span id="captionText">重要会议已置顶，空白周次用短横线保留节奏。</span>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead id="thead"></thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>
    </div>
    <div class="footer-note">数据更新于 ${kanbanData.lastUpdate || new Date().toISOString().slice(0, 10)}，点击会议标题可跳转原文。</div>
  </section>
  <div class="fixed-x-scroll" id="fixedXScroll" aria-hidden="true"><div class="fixed-x-scroll-inner" id="fixedXScrollInner"></div></div>
</main>

<script>
const data = ${dataJson};
const weekKeys = ${weeksJson};
const weekLabels = ${weekLabelsJson};
const COMPACT_LIMIT = 3;

const state = { filter: 'all', teams: [], weeks: [], query: '' };
const $ = id => document.getElementById(id);
let syncingHorizontalScroll = false;

function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function highlightText(t, q) {
  if (!q) return escapeHtml(t);
  const e = escapeHtml(t);
  const re = new RegExp('(' + q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi');
  return e.replace(re, '<mark class="hl">$1</mark>');
}
function parseDate(t) { const m = t.match(/^(\\d{4})(\\d{2})(\\d{2})/); return m ? m[2] + '/' + m[3] : ''; }
function parseName(t) { return t.replace(/^\\d{8}\\s*[-—–]\\s*/, ''); }

function allMeetings() {
  return data.flatMap(row => weekKeys.flatMap(w => (row.weeks[w] || []).map(m => ({ ...m, team: row.name, week: w }))));
}

function setupDropdown(rootId, triggerId) {
  const root = $(rootId);
  const trigger = $(triggerId);
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.multi-select.open').forEach(el => {
      if (el !== root) el.classList.remove('open');
    });
    root.classList.toggle('open');
  });
  root.querySelector('.multi-panel').addEventListener('click', e => e.stopPropagation());
}

function updateMultiTrigger(triggerId, values, allLabel, unitLabel, panelId) {
  const trigger = $(triggerId);
  if (!values.length) {
    trigger.textContent = allLabel;
  } else if (values.length === 1) {
    const option = Array.from($(panelId).querySelectorAll('input:not([value="__all__"])'))
      .find(box => box.value === values[0]);
    trigger.textContent = option ? option.parentElement.textContent.trim() : values[0];
  } else {
    trigger.textContent = values.length + ' 个' + unitLabel;
  }
}

function renderMultiOptions(panelId, items, stateKey, triggerId, allLabel, unitLabel) {
  const panel = $(panelId);
  panel.innerHTML =
    '<label class="multi-option multi-option-all"><input type="checkbox" value="__all__" checked>' + allLabel + '</label>' +
    items.map(item => '<label class="multi-option"><input type="checkbox" value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + '</label>').join('');

  panel.addEventListener('change', e => {
    const input = e.target.closest('input');
    if (!input) return;
    const allBox = panel.querySelector('input[value="__all__"]');
    const itemBoxes = Array.from(panel.querySelectorAll('input:not([value="__all__"])'));

    if (input.value === '__all__') {
      state[stateKey] = [];
      allBox.checked = true;
      itemBoxes.forEach(box => { box.checked = false; });
    } else {
      state[stateKey] = itemBoxes.filter(box => box.checked).map(box => box.value);
      allBox.checked = state[stateKey].length === 0;
    }

    updateMultiTrigger(triggerId, state[stateKey], allLabel, unitLabel, panelId);
    render();
  });
}

function initControls() {
  renderMultiOptions(
    'teamPanel',
    data.map(row => ({ value: row.name, label: row.name })),
    'teams',
    'teamTrigger',
    '全部团队',
    '团队'
  );
  renderMultiOptions(
    'weekPanel',
    weekKeys.map(w => ({ value: w, label: (weekLabels[w] || { label: w }).label })),
    'weeks',
    'weekTrigger',
    '全部周次',
    '周次'
  );
  setupDropdown('teamFilter', 'teamTrigger');
  setupDropdown('weekFilter', 'weekTrigger');
  document.addEventListener('click', () => {
    document.querySelectorAll('.multi-select.open').forEach(el => el.classList.remove('open'));
  });

  $('segmented').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $('segmented').querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    render();
  });
  $('searchBox').addEventListener('input', e => { state.query = e.target.value.trim().toLowerCase(); render(); });
}

function renderStats() {
  const ms = allMeetings();
  $('teamCount').textContent = data.length;
  $('meetingCount').textContent = ms.length;
  $('importantCount').textContent = ms.filter(m => m.important).length;
  $('weekCount').textContent = weekKeys.length;
}

function getRecentWeeks() {
  return weekKeys.slice(-2);
}

function isVisible(row, weekKey, meeting) {
  if (state.teams.length && !state.teams.includes(row.name)) return false;
  if (state.weeks.length && !state.weeks.includes(weekKey)) return false;
  if (state.filter === 'important' && !meeting.important) return false;
  if (state.filter === 'red' && meeting.important !== 'red') return false;
  if (state.filter === 'orange' && meeting.important !== 'orange') return false;
  if (state.filter === 'recent' && !getRecentWeeks().includes(weekKey)) return false;
  if (state.query) {
    const hay = (row.name + ' ' + meeting.text).toLowerCase();
    if (!hay.includes(state.query)) return false;
  }
  return true;
}

function filteredRows() {
  return data.map(row => ({
    ...row,
    _weeks: Object.fromEntries(
      weekKeys.map(w => [w, (row.weeks[w] || []).filter(m => isVisible(row, w, m))])
    )
  })).filter(row => {
    const hasVisible = Object.values(row._weeks).flat().length > 0;
    if (state.teams.length && state.teams.includes(row.name)) return true;
    return hasVisible;
  });
}

function visibleWeeks() {
  return state.weeks.length ? weekKeys.filter(w => state.weeks.includes(w)) : weekKeys;
}

function renderHead() {
  const vw = visibleWeeks();
  $('thead').innerHTML = '<tr><th>团队</th>' + vw.map(w => {
    const info = weekLabels[w] || { label: w };
    const count = data.reduce((s, r) => s + (r.weeks[w] || []).length, 0);
    return '<th><div class="week-head"><strong>' + info.label + '</strong><span>' + count + ' 场</span></div></th>';
  }).join('') + '</tr>';
}

function importancePriority(imp) { return imp === 'red' ? 2 : imp === 'orange' ? 1 : 0; }

function renderMeetingList(meetings) {
  if (!meetings.length) return '<div class="empty"></div>';
  const sorted = meetings.slice().sort((a, b) => importancePriority(b.important) - importancePriority(a.important));
  const compact = sorted.length > COMPACT_LIMIT ? ' compact' : '';
  const q = state.query;
  const items = sorted.map(m => {
    const d = parseDate(m.text);
    const n = parseName(m.text);
    const cls = m.important === 'red' ? 'meeting important' : m.important === 'orange' ? 'meeting important-orange' : 'meeting';
    const flag = m.important === 'red' ? '<span class="title-flag matrix-title-flag status-important">红色重要</span><span class="title-separator">-</span>'
      : m.important === 'orange' ? '<span class="title-flag matrix-title-flag status-important-orange">橙色重要</span><span class="title-separator">-</span>' : '';
    const dn = highlightText(n, q);
    const title = m.url
      ? '<a class="meeting-title matrix-meeting-title" href="' + escapeHtml(m.url) + '" target="_blank" rel="noopener">' + flag + dn + '</a>'
      : '<span class="meeting-title matrix-meeting-title">' + flag + dn + '</span>';
    return '<article class="' + cls + '"><span class="date matrix-date">' + d + '</span><div class="meeting-main">' + title + '</div></article>';
  }).join('');
  const more = sorted.length > COMPACT_LIMIT
    ? '<button class="show-more" type="button" onclick="this.parentElement.classList.remove(\\'compact\\');this.remove()">展开 ' + (sorted.length - COMPACT_LIMIT) + ' 条</button>'
    : '';
  return '<div class="meeting-list' + compact + '">' + items + more + '</div>';
}

function renderBody() {
  const rows = filteredRows();
  const vw = visibleWeeks();

  if (rows.length === 0) {
    $('tbody').innerHTML = '<tr><td colspan="' + (vw.length + 1) + '" style="border:none;padding:0"><div class="empty-state"><div class="empty-state-title">没有找到匹配的结果</div><div class="empty-state-sub">试试调整筛选条件或搜索关键词</div></div></td></tr>';
    $('resultPill').textContent = '0 条记录';
    $('captionText').textContent = '没有匹配结果，调整筛选或搜索词再试。';
    return;
  }

  $('tbody').innerHTML = rows.map(row => {
    const all = Object.values(row._weeks).flat();
    const total = all.length;
    const redCount = all.filter(m => m.important === 'red').length;
    const orangeCount = all.filter(m => m.important === 'orange').length;
    const impTags = (redCount ? '<span class="tag status-important">' + redCount + ' 红色重要</span>' : '')
      + (orangeCount ? '<span class="tag status-important-orange">' + orangeCount + ' 橙色重要</span>' : '');
    return '<tr><td><div class="team-cell"><div class="team-name">' + highlightText(row.name, state.query) + '</div><div class="team-meta"><span class="tag">' + total + ' 场</span>' + impTags + '</div></div></td>' +
      vw.map(w => '<td>' + renderMeetingList(row._weeks[w] || []) + '</td>').join('') + '</tr>';
  }).join('');

  const resultCount = rows.reduce((s, r) => s + Object.values(r._weeks).flat().length, 0);
  $('resultPill').textContent = resultCount + ' 条记录';
  $('captionText').textContent = resultCount ? '重要会议已置顶，空白周次用短横线保留节奏。' : '没有匹配结果，调整筛选或搜索词再试。';
}

function updateFixedHorizontalScrollbar() {
  const tableScroll = document.querySelector('.table-scroll');
  const fixed = $('fixedXScroll');
  const fixedInner = $('fixedXScrollInner');
  if (!tableScroll || !fixed || !fixedInner) return;

  const overflow = tableScroll.scrollWidth > tableScroll.clientWidth + 2;
  fixed.classList.toggle('visible', overflow);
  fixedInner.style.width = tableScroll.scrollWidth + 'px';
  fixed.scrollLeft = tableScroll.scrollLeft;
}

function initFixedHorizontalScrollbar() {
  const tableScroll = document.querySelector('.table-scroll');
  const fixed = $('fixedXScroll');
  if (!tableScroll || !fixed) return;

  tableScroll.addEventListener('scroll', () => {
    if (syncingHorizontalScroll) return;
    syncingHorizontalScroll = true;
    fixed.scrollLeft = tableScroll.scrollLeft;
    syncingHorizontalScroll = false;
  });

  fixed.addEventListener('scroll', () => {
    if (syncingHorizontalScroll) return;
    syncingHorizontalScroll = true;
    tableScroll.scrollLeft = fixed.scrollLeft;
    syncingHorizontalScroll = false;
  });

  window.addEventListener('resize', updateFixedHorizontalScrollbar);
}

function render() {
  renderHead();
  renderBody();
  requestAnimationFrame(updateFixedHorizontalScrollbar);
}

initControls();
initFixedHorizontalScrollbar();
renderStats();
render();
</script>
</body>
</html>`;
}

// ========== 构建重要会议索引 ==========
function classifyImportantByParticipants(participants, importantPeople, leader) {
  const participantText = String(participants || '');
  if (!participantText.trim()) return false;

  function includesPersonName(text, name) {
    if (!name) return false;
    const normalizedName = String(name || '').replace(/\s+/g, '');
    if (!normalizedName) return false;
    const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const spacedName = Array.from(normalizedName).map(escapeRe).join('\\s*');
    const boundary = '[\\s,，、/／;；|｜()（）\\[\\]【】{}<>《》:：\\-—–_\\n\\r\\t·・.。!！?？@]';
    const re = new RegExp(`(^|${boundary})${spacedName}(?=${boundary}|$|等|及|和|与|、)`);
    return re.test(String(text || ''));
  }

  if ((importantPeople || []).some(name => includesPersonName(participantText, name))) return 'red';
  if (includesPersonName(participantText, leader)) return 'orange';
  return false;
}

function importantKeysForMeeting(meeting) {
  const urlKey = normalizeKdocsUrl(meeting.url);
  const rawTitle = meeting.name || meeting.title || meeting.text || '';
  const normalizedTitle = normalizeTitle(rawTitle);
  const matchTitle = normalizeForMatch(rawTitle);
  const matchNormalizedTitle = normalizeForMatch(normalizedTitle);
  return [
    meeting.url,
    urlKey,
    meeting.id,
    meeting.name,
    meeting.title,
    meeting.text,
    normalizedTitle,
    matchTitle,
    matchNormalizedTitle
  ].filter(Boolean);
}

function normalizeKdocsUrl(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  const match = text.match(/\/l\/([^/?#]+)/);
  return match ? match[1] : text;
}

function setImportantLevel(importantMap, keys, level, override = false) {
  if (!level && !override) return;
  for (const key of keys) {
    if (!key) continue;
    const existing = importantMap.get(key);
    if (override || !existing || (level === 'red' && existing !== 'red')) {
      importantMap.set(key, level);
    }
  }
}

function applyImportantRecordsToMap(importantMap, records, importantPeople, teamLeaders, override = false) {
  for (const record of records || []) {
    const participants = extractParticipants(record.content || record.rawContent || '');
    const leader = (teamLeaders || {})[record.team] || null;
    const level = classifyImportantByParticipants(participants, importantPeople, leader);
    setImportantLevel(importantMap, importantKeysForMeeting(record), level, override);
  }
  return importantMap;
}

function classifyImportantForCachedFile(teamCfg, file, importantPeople, teamLeaders) {
  if (!file || !file.id) return false;
  const cacheFile = path.join(teamDocsCacheDir(teamCfg.name), `${file.id}.json`);
  const cached = readCache(cacheFile);
  if (!cached || cached.mtime !== file.mtime || !cached.content) return false;
  const participants = extractParticipants(cached.content);
  const leader = (teamLeaders || {})[teamCfg.name] || null;
  return classifyImportantByParticipants(participants, importantPeople, leader);
}

function applyCachedImportantRecord(importantMap, teamCfg, file, importantPeople, teamLeaders) {
  const level = classifyImportantForCachedFile(teamCfg, file, importantPeople, teamLeaders);
  if (!level) return false;
  setImportantLevel(importantMap, importantKeysForMeeting({
    name: file.name,
    title: file.name,
    url: file.link || ''
  }), level);
  return true;
}

function buildCachedFileMetaIndex(teamName) {
  const foldersDir = path.join(path.dirname(teamDocsCacheDir(teamName)), 'folders');
  const index = new Map();
  if (!fs.existsSync(foldersDir)) return index;
  for (const fileName of fs.readdirSync(foldersDir)) {
    if (!fileName.endsWith('.json')) continue;
    const cached = readCache(path.join(foldersDir, fileName));
    for (const item of cached?.items || []) {
      if (!item || item.type !== 'file' || !item.id) continue;
      index.set(item.id, {
        id: item.id,
        name: item.name || '',
        url: item.link_url || item.link || ''
      });
    }
  }
  return index;
}

function buildImportantSetFromDocCache(workspaceDir, config, importantPeople, teamLeaders) {
  const importantMap = new Map();
  for (const teamCfg of config?.teams || []) {
    const docsDir = teamDocsCacheDir(teamCfg.name);
    if (!fs.existsSync(docsDir)) continue;
    const fileMetaIndex = buildCachedFileMetaIndex(teamCfg.name);
    for (const fileName of fs.readdirSync(docsDir)) {
      if (!fileName.endsWith('.json')) continue;
      const cached = readCache(path.join(docsDir, fileName));
      if (!cached || !cached.content) continue;
      const participants = extractParticipants(cached.content);
      const leader = (teamLeaders || {})[teamCfg.name] || null;
      const level = classifyImportantByParticipants(participants, importantPeople, leader);
      if (!level) continue;
      const firstLine = String(cached.content || '').split(/\r?\n/).find(line => line.trim()) || '';
      const docTitle = firstLine.replace(/^[#\s《]+|[》\s]+$/g, '').trim();
      const id = fileName.replace(/\.json$/i, '');
      const meta = fileMetaIndex.get(id) || {};
      setImportantLevel(importantMap, importantKeysForMeeting({
        id,
        name: meta.name || docTitle,
        title: docTitle,
        text: docTitle,
        url: cached.url || meta.url || ''
      }), level);
    }
  }
  return importantMap;
}

function buildKanbanDataFromDocCache(workspaceDir, config, importantMap) {
  const teams = [];
  for (const teamCfg of config?.teams || []) {
    const docsDir = teamDocsCacheDir(teamCfg.name);
    const weekMap = {};
    if (!fs.existsSync(docsDir)) {
      teams.push({ name: teamCfg.name, weeks: weekMap });
      continue;
    }

    const fileMetaIndex = buildCachedFileMetaIndex(teamCfg.name);
    for (const fileName of fs.readdirSync(docsDir)) {
      if (!fileName.endsWith('.json')) continue;
      const cached = readCache(path.join(docsDir, fileName));
      if (!cached || !cached.content) continue;

      const firstLine = String(cached.content || '').split(/\r?\n/).find(line => line.trim()) || '';
      const docTitle = firstLine.replace(/^[#\s《]+|[》\s]+$/g, '').trim() || fileName.replace(/\.json$/i, '');
      const resolvedDate = extractMeetingDate(docTitle, cached.content);
      if (!resolvedDate) continue;
      const weekKey = getWeekKey(docTitle, cached.content, null, cached.mtime);
      if (weekKey === 'unknown') continue;

      if (!weekMap[weekKey]) weekMap[weekKey] = [];
      const title = normalizeTitle(docTitle, resolvedDate);
      const id = fileName.replace(/\.json$/i, '');
      const meta = fileMetaIndex.get(id) || {};
      const url = cached.url || meta.url || '';
      const isDup = weekMap[weekKey].some(m =>
        (url && m.url && normalizeKdocsUrl(m.url) === normalizeKdocsUrl(url)) || m.text === title
      );
      if (isDup) continue;
      weekMap[weekKey].push({
        text: title,
        url,
        important: isImportantMeeting(url, docTitle, importantMap)
      });
    }
    teams.push({ name: teamCfg.name, weeks: weekMap });
  }

  return { teams, lastUpdate: new Date().toISOString().slice(0, 10) };
}

function enrichKanbanFromDocCache(kanbanData, cacheData) {
  if (!cacheData || !Array.isArray(cacheData.teams)) return kanbanData;
  const result = {
    teams: JSON.parse(JSON.stringify(kanbanData.teams || [])),
    lastUpdate: kanbanData.lastUpdate || new Date().toISOString().slice(0, 10)
  };

  for (const cacheTeam of cacheData.teams || []) {
    let targetTeam = result.teams.find(t => t.name === cacheTeam.name);
    if (!targetTeam) {
      targetTeam = { name: cacheTeam.name, weeks: {} };
      result.teams.push(targetTeam);
    }

    for (const [cacheWeekKey, cacheMeetings] of Object.entries(cacheTeam.weeks || {})) {
      for (const cacheMeeting of cacheMeetings || []) {
        const cacheTitle = normalizeForMatch(cacheMeeting.text || '');
        const targetMeetings = [];
        for (const [weekKey, meetings] of Object.entries(targetTeam.weeks || {})) {
          for (const meeting of meetings || []) targetMeetings.push({ weekKey, meeting });
        }

        const match = targetMeetings.find(({ meeting }) => {
          if (cacheMeeting.url && meeting.url && normalizeKdocsUrl(cacheMeeting.url) === normalizeKdocsUrl(meeting.url)) return true;
          const targetTitle = normalizeForMatch(normalizeTitle(meeting.text || ''));
          return cacheTitle && targetTitle && (
            cacheTitle === targetTitle ||
            (cacheTitle.length >= 8 && targetTitle.length >= 8 && charSimilarity(cacheTitle, targetTitle) >= 0.9)
          );
        });

        if (!match) {
          if (!targetTeam.weeks[cacheWeekKey]) targetTeam.weeks[cacheWeekKey] = [];
          const existing = targetTeam.weeks[cacheWeekKey];
          const isDup = existing.some(m =>
            (cacheMeeting.url && m.url && normalizeKdocsUrl(m.url) === normalizeKdocsUrl(cacheMeeting.url)) || m.text === cacheMeeting.text
          );
          if (!isDup) existing.push({ ...cacheMeeting });
          continue;
        }

        if (cacheMeeting.text && /^\d{8}\s+-\s+/.test(cacheMeeting.text)) {
          match.meeting.text = cacheMeeting.text;
        }
        if (cacheMeeting.important && (cacheMeeting.important === 'red' || !match.meeting.important)) {
          match.meeting.important = cacheMeeting.important;
        }
        if (match.weekKey !== cacheWeekKey) {
          targetTeam.weeks[match.weekKey] = (targetTeam.weeks[match.weekKey] || []).filter(m => m !== match.meeting);
          if (!targetTeam.weeks[cacheWeekKey]) targetTeam.weeks[cacheWeekKey] = [];
          if (!targetTeam.weeks[cacheWeekKey].includes(match.meeting)) targetTeam.weeks[cacheWeekKey].push(match.meeting);
        }
      }
    }
  }

  for (const team of result.teams || []) {
    for (const [weekKey, meetings] of Object.entries(team.weeks || {})) {
      team.weeks[weekKey] = (meetings || []).filter(Boolean);
      if (team.weeks[weekKey].length === 0) delete team.weeks[weekKey];
    }
  }

  return result;
}

function pruneMeetingsWithoutConcreteDate(kanbanData) {
  const today = new Date();
  const todayNum = (today.getMonth() + 1) * 100 + today.getDate();
  for (const team of kanbanData?.teams || []) {
    for (const [weekKey, meetings] of Object.entries(team.weeks || {})) {
      team.weeks[weekKey] = (meetings || []).filter(meeting => {
        const title = String(meeting.text || '');
        const titleDate = title.match(/^(\d{4})(\d{2})(\d{2})/);
        if (titleDate && Number(titleDate[1]) === currentYear()) {
          const titleNum = Number(titleDate[2]) * 100 + Number(titleDate[3]);
          if (titleNum > todayNum) return false;
        }
        if (extractMeetingDate(title)) return true;
        if (/^\d{6}(?!\d)/.test(title)) return false;
        if (/^\d{4}\s*[年.\-\/]?\s*\d{1,2}(?!\s*[日号.\-\/]?\s*\d)/.test(title)) return false;
        return !/^unknown$/i.test(weekKey);
      });
      if (team.weeks[weekKey].length === 0) delete team.weeks[weekKey];
    }
  }
  return kanbanData;
}

function buildImportantSetFromTeamSummaries(teams, importantPeople, teamLeaders) {
  const importantMap = new Map();
  const teamList = Array.isArray(teams) ? teams : (teams && Array.isArray(teams.teams) ? teams.teams : []);

  for (const team of teamList) {
    const leader = (teamLeaders || {})[team.team] || null;
    for (const weekData of Object.values(team.weeks || {})) {
      for (const m of (weekData.meetings || [])) {
        const participants = m.participants || extractParticipants(m.rawContent || '');
        const level = classifyImportantByParticipants(participants, importantPeople, leader);

        setImportantLevel(importantMap, importantKeysForMeeting({ url: m.url, title: m.title }), level);
      }
    }
  }
  return importantMap;
}

function buildImportantSet(workspaceDir, importantPeople, teamLeaders) {
  const dataFile = findInputFile('all-team-summaries.json');
  if (!fs.existsSync(dataFile)) return new Map();
  const teams = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  return buildImportantSetFromTeamSummaries(teams, importantPeople, teamLeaders);
}

function isImportantMeeting(url, title, importantMap) {
  if (url && importantMap.has(url)) return importantMap.get(url);
  const normalizedUrl = normalizeKdocsUrl(url);
  if (normalizedUrl && importantMap.has(normalizedUrl)) return importantMap.get(normalizedUrl);
  if (title) {
    const normalized = title.replace(/\.(otl|docx)$/i, '');
    if (importantMap.has(normalized)) return importantMap.get(normalized);
    const normalizedTitle = normalizeTitle(title);
    if (importantMap.has(normalizedTitle)) return importantMap.get(normalizedTitle);
    const matchTitle = normalizeForMatch(title);
    if (matchTitle && importantMap.has(matchTitle)) return importantMap.get(matchTitle);
    const matchNormalizedTitle = normalizeForMatch(normalizedTitle);
    if (matchNormalizedTitle && importantMap.has(matchNormalizedTitle)) return importantMap.get(matchNormalizedTitle);
  }
  return false;
}

function applyImportantMarkersToKanbanData(kanbanData, importantMap, options = {}) {
  const clearMissing = options.clearMissing === true;
  for (const team of kanbanData.teams || []) {
    for (const meetings of Object.values(team.weeks || {})) {
      for (const meeting of meetings) {
        const level = isImportantMeeting(meeting.url, meeting.text, importantMap);
        if (level || clearMissing) {
          meeting.important = level;
        }
      }
    }
  }
  return kanbanData;
}

async function resolveMeetingDateForFile(teamCfg, file, pacer) {
  const fileDate = extractDateFromFileName(file.name);
  if (fileDate) return { date: fileDate, content: '' };

  if (!file || !file.id) return { date: null, content: '' };
  const cacheFile = path.join(teamDocsCacheDir(teamCfg.name), `${file.id}.json`);
  const cached = readCache(cacheFile);
  let content = cached && cached.mtime === file.mtime ? (cached.content || '') : '';

  if (!content && file.drive_id) {
    content = await readDocAsync(file.drive_id, file.id, file.mtime, teamCfg.name, pacer, file.link || '');
  }

  return { date: extractMeetingDate(file.name, content), content: content || '' };
}

function determineScanMode(args, hasExistingData) {
  if (args.includes('--refresh')) return 'full';
  if (hasExistingData) return 'incremental';
  return 'full';
}

function meetingKey(teamName, meeting) {
  const url = meeting.url || '';
  if (url) return `${teamName}::url::${normalizeKdocsUrl(url) || url}`;
  return `${teamName}::title::${normalizeTitle(meeting.text || '')}`;
}

function mergeKanbanData(primaryData, fallbackData) {
  const result = {
    teams: JSON.parse(JSON.stringify(primaryData.teams || [])),
    lastUpdate: primaryData.lastUpdate || new Date().toISOString().slice(0, 10)
  };
  const seen = new Set();

  for (const team of result.teams) {
    for (const meetings of Object.values(team.weeks || {})) {
      for (const meeting of meetings) seen.add(meetingKey(team.name, meeting));
    }
  }

  for (const fallbackTeam of fallbackData.teams || []) {
    let targetTeam = result.teams.find(t => t.name === fallbackTeam.name);
    if (!targetTeam) {
      targetTeam = { name: fallbackTeam.name, weeks: {} };
      result.teams.push(targetTeam);
    }

    for (const [weekKey, meetings] of Object.entries(fallbackTeam.weeks || {})) {
      if (!targetTeam.weeks[weekKey]) targetTeam.weeks[weekKey] = [];
      for (const meeting of meetings || []) {
        const key = meetingKey(fallbackTeam.name, meeting);
        if (seen.has(key)) continue;
        targetTeam.weeks[weekKey].push({ ...meeting });
        seen.add(key);
      }
    }
  }

  return result;
}

function countMeetings(kanbanData) {
  let total = 0;
  for (const team of kanbanData?.teams || []) {
    for (const meetings of Object.values(team.weeks || {})) total += meetings.length;
  }
  return total;
}

function reconcileWithExistingKanban(scannedData, existingData, options = {}) {
  if (!existingData || !Array.isArray(existingData.teams)) return scannedData;

  const minCoverageRatio = Number(options.minCoverageRatio ?? 0.8);
  const minTeamCoverageRatio = Number(options.minTeamCoverageRatio ?? 0.5);
  let result = scannedData;
  let restoredTeams = 0;

  for (const existingTeam of existingData.teams || []) {
    const existingCount = countMeetings({ teams: [existingTeam] });
    if (existingCount === 0) continue;

    const scannedTeam = (result.teams || []).find(t => t.name === existingTeam.name);
    const scannedCount = scannedTeam ? countMeetings({ teams: [scannedTeam] }) : 0;
    if (scannedCount === 0 || scannedCount < existingCount * minTeamCoverageRatio) {
      result = mergeKanbanData(result, { teams: [existingTeam], lastUpdate: existingData.lastUpdate });
      restoredTeams++;
    }
  }

  const scannedTotal = countMeetings(scannedData);
  const existingTotal = countMeetings(existingData);
  if (existingTotal > 0 && scannedTotal < existingTotal * minCoverageRatio) {
    result = mergeKanbanData(result, existingData);
  }

  const recoveredTotal = countMeetings(result);
  return {
    ...result,
    lastUpdate: scannedData.lastUpdate || new Date().toISOString().slice(0, 10),
    _guard: {
      restoredTeams,
      scannedTotal,
      existingTotal,
      recoveredTotal
    }
  };
}

async function scanImportantCandidateFiles(teamCfg, pacer, options = {}) {
  const scanMode = options.scanMode || getKdocsScanMode();
  const scanFn = options.scanFilesByMode || scanFilesByMode;
  const monthEntries = getTeamScanEntries(teamCfg);
  const allFiles = [];

  for (const entry of monthEntries) {
    try {
      const { files } = await scanFn(entry, {
        teamName: teamCfg.name,
        pacer,
        mode: scanMode,
        includeAll: true
      });
      allFiles.push(...files);
    } catch (_) {
      // Keep important-marker refresh opportunistic; the main kanban scan handles visible scan errors.
    }
  }

  return allFiles;
}

async function refreshChangedImportantRecords(config, importantPeople, teamLeaders, importantMap) {
  const pacer = new RequestPacer();
  const changedFiles = [];
  const missingFiles = [];
  let cachedApplied = 0;

  await Promise.all((config.teams || []).map(async (teamCfg) => {
    const files = await scanImportantCandidateFiles(teamCfg, pacer);

    for (const file of files) {
      const cacheFile = path.join(teamDocsCacheDir(teamCfg.name), `${file.id}.json`);
      const cached = readCache(cacheFile);
      if (!cached) {
        missingFiles.push({ teamCfg, file });
        continue;
      }
      if (cached.mtime === file.mtime) {
        if (applyCachedImportantRecord(importantMap, teamCfg, file, importantPeople, teamLeaders)) cachedApplied++;
        continue;
      }
      changedFiles.push({ teamCfg, file });
    }
  }));

  const filesToRead = [...changedFiles, ...missingFiles];
  if (filesToRead.length === 0) return { changed: 0, missing: 0, refreshed: 0, cachedApplied };

  let refreshed = 0;
  const tasks = filesToRead.map(({ teamCfg, file }) => async () => {
    const content = await readDocAsync(file.drive_id, file.id, file.mtime, teamCfg.name, pacer, file.link || '');
    if (!content) return null;
    refreshed++;
    return {
      team: teamCfg.name,
      name: file.name,
      url: file.link || '',
      content
    };
  });

  const records = (await runPool(tasks, Number(config.kdocs?.documentConcurrency) || 5)).filter(Boolean);
  applyImportantRecordsToMap(importantMap, records, importantPeople, teamLeaders, true);
  return { changed: changedFiles.length, missing: missingFiles.length, refreshed, cachedApplied };
}

// ========== 从 kanbanData 中找最新日期 ==========
function findLatestDate(kanbanData) {
  let maxMonth = 0, maxDay = 0;
  for (const team of kanbanData.teams) {
    for (const meetings of Object.values(team.weeks)) {
      for (const m of meetings) {
        const match = m.text.match(/^(\d{4})(\d{2})(\d{2})/);
        if (match) {
          const mon = parseInt(match[2]);
          const day = parseInt(match[3]);
          if (mon * 100 + day > maxMonth * 100 + maxDay) {
            maxMonth = mon;
            maxDay = day;
          }
        }
      }
    }
  }
  return maxMonth > 0 ? { month: maxMonth, day: maxDay } : null;
}

// ========== 全量扫描（默认递归扫描，避免 search-files 漏掉嵌套目录） ==========
async function fullScan(config, importantMap) {
  const pacer = new RequestPacer();
  const scanMode = getKdocsScanMode();
  console.log(`并行扫描 ${config.teams.length} 个团队（${scanMode}）...`);

  const teamResults = await Promise.all(config.teams.map(async (teamCfg) => {
    const allFiles = [];
    const monthEntries = getTeamScanEntries(teamCfg);
    for (const entry of monthEntries) {
      try {
        const { files, stats } = await scanFilesByMode(entry, {
          teamName: teamCfg.name,
          pacer,
          mode: scanMode,
          includeAll: true
        });
        allFiles.push(...files);
        const supplement = stats.recursiveSupplementCount ? `，递归补 ${stats.recursiveSupplementCount}` : '';
        console.log(`  ${teamCfg.name}/${entry.monthName}: ${files.length} 个文件 [${stats.mode}; search ${stats.searchCount}; recursive ${stats.recursiveCount}${supplement}]`);
      } catch (e) {
        console.log(`  ${teamCfg.name}/${entry.monthName}: ${scanMode} 失败 (${e.message.substring(0, 80)})`);
        const files = await scanFolderAllAsync(entry.source.drive_id, entry.folderId, teamCfg.name, pacer);
        allFiles.push(...files);
        console.log(`  ${teamCfg.name}/${entry.monthName}: fallback ${files.length} 个文件`);
      }
    }

    const weekMap = {};
    const weekTitleIndex = {};
    for (const f of allFiles) {
      const resolved = await resolveMeetingDateForFile(teamCfg, f, pacer);
      const weekKey = getWeekKey(f.name, resolved.content, null, f.mtime);
      if (weekKey === 'unknown') continue;
      if (!weekMap[weekKey]) { weekMap[weekKey] = []; weekTitleIndex[weekKey] = new Map(); }
      const title = normalizeTitle(f.name, resolved.date);
      const url = f.link || '';
      // 同周次同标题去重：优先保留有 URL 的条目
      const existing = weekTitleIndex[weekKey].get(title);
      if (existing !== undefined) {
        if (url && !weekMap[weekKey][existing].url) {
          weekMap[weekKey][existing].url = url;
        }
        continue;
      }
      weekTitleIndex[weekKey].set(title, weekMap[weekKey].length);
      weekMap[weekKey].push({
        text: title,
        url,
        important: isImportantMeeting(url, f.name, importantMap)
      });
    }
    return { name: teamCfg.name, weeks: weekMap };
  }));

  return { data: { teams: teamResults, lastUpdate: new Date().toISOString().slice(0, 10) }, pacer };
}

// ========== 增量扫描（默认递归扫描，避免 search-files 漏掉嵌套目录） ==========
async function incrementalScan(config, existingData, importantMap) {
  const latestDate = findLatestDate(existingData);
  if (!latestDate) {
    console.log('无法确定最新日期，执行全量扫描...');
    return fullScan(config, importantMap);
  }

  const lookbackDays = 7;
  const startDate = new Date(currentYear(), latestDate.month - 1, latestDate.day - lookbackDays);
  const startMonth = startDate.getMonth() + 1;
  const startDay = startDate.getDate();
  const startNum = startMonth * 100 + startDay;
  console.log("增量更新: 回看 " + lookbackDays + " 天，从 " + String(startMonth).padStart(2, "0") + "-" + String(startDay).padStart(2, "0") + " 开始（最新标题日期: " + String(latestDate.month).padStart(2, "0") + "-" + String(latestDate.day).padStart(2, "0") + "）");

  const pacer = new RequestPacer();
  const scanMode = getKdocsScanMode();

  const existingUrlSet = new Set();
  const existingTitleSet = new Set();
  for (const team of existingData.teams) {
    for (const meetings of Object.values(team.weeks)) {
      for (const m of meetings) {
        if (m.url) existingUrlSet.add(m.url);
        if (m.text) existingTitleSet.add(team.name + "::" + normalizeTitle(m.text));
      }
    }
  }

  let newCount = 0;
  await Promise.all(config.teams.map(async (teamCfg) => {
    let existingTeam = existingData.teams.find(t => t.name === teamCfg.name);
    if (!existingTeam) {
      existingTeam = { name: teamCfg.name, weeks: {} };
      existingData.teams.push(existingTeam);
    }

    const monthEntries = getTeamScanEntries(teamCfg);

    for (const entry of monthEntries) {
      let files;
      try {
        const result = await scanFilesByMode(entry, {
          teamName: teamCfg.name,
          pacer,
          mode: scanMode,
          includeAll: true
        });
        files = result.files;
      } catch (e) {
        console.log(`  ${teamCfg.name}/${entry.monthName}: ${scanMode} 失败 (${e.message.substring(0, 80)})`);
        files = await scanFolderAllAsync(entry.source.drive_id, entry.folderId, teamCfg.name, pacer);
      }
      const resolvedFiles = [];
      for (const f of files) {
        const resolved = await resolveMeetingDateForFile(teamCfg, f, pacer);
        if (!resolved.date || (resolved.date.month * 100 + resolved.date.day) < startNum) continue;
        resolvedFiles.push({ ...f, _resolvedDate: resolved.date, _resolvedContent: resolved.content });
      }
      const filtered = resolvedFiles;
      if (filtered.length > 0) console.log(`  ${teamCfg.name}/${entry.monthName}: +${filtered.length} 个新文件`);

      for (const f of filtered) {
        if (f.link && existingUrlSet.has(f.link)) continue;

        const weekKey = getWeekKey(f.name, f._resolvedContent || '', null, f.mtime);
        if (weekKey === 'unknown') continue;
        if (!existingTeam.weeks[weekKey]) existingTeam.weeks[weekKey] = [];

        const title = normalizeTitle(f.name, f._resolvedDate || null);
        const url = f.link || '';

        const titleKey = teamCfg.name + "::" + title;
        const isDup = (url && existingUrlSet.has(url))
          || existingTitleSet.has(titleKey)
          || existingTeam.weeks[weekKey].some(m => (url && m.url === url) || normalizeTitle(m.text || "") === title);
        if (isDup) continue;

        existingTeam.weeks[weekKey].push({
          text: title,
          url,
          important: isImportantMeeting(url, f.name, importantMap)
        });
        if (url) existingUrlSet.add(url);
        existingTitleSet.add(titleKey);
        newCount++;
      }
    }
  }));

  console.log(`新增 ${newCount} 条会议记录`);
  existingData.lastUpdate = new Date().toISOString().slice(0, 10);
  return { data: existingData, pacer };
}

// ========== 入口 ==========
async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const refresh = args.includes('--refresh');

  const workspaceDir = resolveWorkspaceDir();
  const configFile = path.join(__dirname, '..', 'config.json');
  const dataFilePath = findInputFile(DATA_FILE);
  const htmlFilePath = outputPath(HTML_FILE);

  let kanbanData;
  let scanPacer = null;
  let config = null;
  let importantMap = new Map();
  let importantPeople = [];
  let teamLeaders = {};
  if (fs.existsSync(configFile)) {
    config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    importantPeople = config.important_people || [];
    for (const t of config.teams || []) {
      if (t.leader) teamLeaders[t.name] = t.leader;
    }
    importantMap = buildImportantSet(workspaceDir, importantPeople, teamLeaders);
    const cacheImportantMap = buildImportantSetFromDocCache(workspaceDir, config, importantPeople, teamLeaders);
    for (const [key, level] of cacheImportantMap.entries()) {
      setImportantLevel(importantMap, [key], level);
    }
  }

  if (offline) {
    if (!fs.existsSync(dataFilePath)) {
      console.error(`离线模式需要已有数据文件: ${dataFilePath}`);
      process.exit(1);
    }
    kanbanData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
    console.log(`离线模式: 跳过扫描，直接使用本地数据 (更新于 ${kanbanData.lastUpdate})`);
  } else {
    if (!config) {
      console.error(`配置文件不存在: ${configFile}`);
      process.exit(1);
    }

    if (refresh) {
      console.log('--refresh: 强制全量扫描；保留文件夹缓存作为 KDocs 异常时的兜底...');
    }

    const startTime = Date.now();
    const scanMode = determineScanMode(args, fs.existsSync(dataFilePath));
    if (scanMode === 'full') {
      console.log(refresh ? '强制全量扫描...' : '执行全量扫描，确保看板数据完整...');
      const fullResult = await fullScan(config, importantMap);
      const scannedData = fullResult.data || fullResult;
      scanPacer = fullResult.pacer || null;
      if (fs.existsSync(dataFilePath)) {
        const existing = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
        const reconciled = reconcileWithExistingKanban(scannedData, existing);
        if (reconciled._guard && (reconciled._guard.restoredTeams > 0 || reconciled._guard.recoveredTotal > reconciled._guard.scannedTotal)) {
          console.log(
            `扫描覆盖率保护: 新扫描 ${reconciled._guard.scannedTotal} 条，已有 ${reconciled._guard.existingTotal} 条，` +
            `已从旧看板恢复 ${reconciled._guard.restoredTeams} 个团队，最终 ${reconciled._guard.recoveredTotal} 条`
          );
        }
        delete reconciled._guard;
        kanbanData = reconciled;
      } else {
        kanbanData = scannedData;
      }
    } else {
      const existing = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
      console.log(`已有看板数据 (更新于 ${existing.lastUpdate})，执行默认增量补新...`);
      const incrementalResult = await incrementalScan(config, existing, importantMap);
      kanbanData = incrementalResult.data || incrementalResult;
      scanPacer = incrementalResult.pacer || null;
    }
    console.log(`扫描完成，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    const scanStats = scanPacer && typeof scanPacer.getStats === 'function' ? scanPacer.getStats() : {};
    if (scanStats.cacheRebuildUsed) {
      console.log('⚠️ 检测到 KDocs 限流，跳过重要标记在线刷新，改用本地缓存补全。');
    } else {
      const refreshStats = await refreshChangedImportantRecords(config, importantPeople, teamLeaders, importantMap);
      if (refreshStats.changed > 0) {
        console.log(`重要标记依赖正文刷新: 检测 ${refreshStats.changed} 篇变更，刷新 ${refreshStats.refreshed} 篇`);
      }
      if (refreshStats.missing > 0) {
        console.log(`重要标记缺失正文补拉: 检测 ${refreshStats.missing} 篇缺缓存，成功 ${refreshStats.refreshed} 篇`);
      }
      if (refreshStats.cachedApplied > 0) {
        console.log(`重要标记本地缓存补全: ${refreshStats.cachedApplied} 篇`);
      }
    }
    applyImportantMarkersToKanbanData(kanbanData, importantMap, { clearMissing: true });
  }

  if (config) {
    const cacheKanbanData = buildKanbanDataFromDocCache(workspaceDir, config, importantMap);
    kanbanData = enrichKanbanFromDocCache(kanbanData, cacheKanbanData);
    applyImportantMarkersToKanbanData(kanbanData, importantMap, { clearMissing: true });
  }
  kanbanData = pruneMeetingsWithoutConcreteDate(kanbanData);

  const writtenDataFile = writeOutputJson(DATA_FILE, kanbanData);

  const html = generateHtml(kanbanData);
  fs.writeFileSync(htmlFilePath, html, 'utf-8');

  const totalMeetings = countMeetings(kanbanData);
  const scanStats = scanPacer && typeof scanPacer.getStats === 'function' ? scanPacer.getStats() : {};
  const dataSourceMode = offline ? 'local-data' : (scanStats.cacheRebuildUsed ? 'cache-rebuild' : 'direct-read');
  const statsFile = writeOutputJson('kanban-generation-stats.json', {
    type: 'kanban',
    generatedAt: new Date().toISOString(),
    mode: refresh ? 'full' : (offline ? 'offline' : 'incremental'),
    dataSourceMode,
    cacheRebuildReason: dataSourceMode === 'cache-rebuild'
      ? 'KDocs 返回限流，看板使用本地缓存数据重建；限流解除后需要重新跑看板。'
      : null,
    teams: kanbanData.teams.length,
    meetings: totalMeetings,
    output: {
      data: path.basename(writtenDataFile),
      html: path.basename(htmlFilePath)
    },
    kdocs: scanStats
  });
  console.log(`看板数据已保存: ${writtenDataFile}`);
  console.log(`看板已生成: ${(Buffer.byteLength(html) / 1024).toFixed(1)}KB -> ${htmlFilePath}`);
  console.log(`  团队数: ${kanbanData.teams.length}, 会议数: ${totalMeetings}`);
  console.log(`生成统计: ${statsFile}`);
  console.log(`数据来源: ${dataSourceMode === 'cache-rebuild' ? '限流后缓存重建' : dataSourceMode === 'local-data' ? '本地看板数据' : '直接读取/缓存命中'}`);
  if (dataSourceMode === 'cache-rebuild') {
    console.log('⚠️ 本次看板使用缓存数据生成；KDocs 限流解除后需要重新跑看板。');
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  generateHtml,
  classifyImportantByParticipants,
  classifyImportantForCachedFile,
  applyImportantRecordsToMap,
  buildImportantSetFromTeamSummaries,
  buildImportantSet,
  isImportantMeeting,
  applyImportantMarkersToKanbanData,
  determineScanMode,
  mergeKanbanData,
  countMeetings,
  reconcileWithExistingKanban,
  buildImportantSetFromDocCache,
  buildKanbanDataFromDocCache,
  enrichKanbanFromDocCache,
  pruneMeetingsWithoutConcreteDate,
  scanImportantCandidateFiles,
  refreshChangedImportantRecords,
  fullScan,
  incrementalScan
};
