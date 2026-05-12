// 看板默认使用7天长缓存，避免频繁API调用触发限流；--refresh 强制刷新
if (!process.argv.includes('--refresh')) {
  process.env.KDOCS_CACHE_TTL_MS = process.env.KDOCS_CACHE_TTL_MS || '604800000';
}

const fs = require('fs');
const path = require('path');
const {
  resolveWorkspaceDir, currentYear, scanFolderAllAsync, scanFolderFromDateAsync,
  extractDateFromFileName, getWeekKey, normalizeTitle, getTeamSources, clearFolderCache, RequestPacer
} = require('./shared');

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
}
button, input, select { font: inherit; }
button { cursor: pointer; }

.app-shell { min-height: 100vh; display: grid; grid-template-rows: auto auto 1fr; }

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
.metric { background: var(--panel-soft); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
.metric span { display: block; color: var(--text-faint); font-size: 12px; line-height: 1.2; }
.metric strong { display: block; margin-top: 7px; font-size: 24px; line-height: 1; font-weight: 800; }

.workspace { padding: 18px 28px 24px; min-width: 0; }
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
.search-wrap { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.search { width: 280px; padding: 0 12px; outline: none; }
.search:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }

.board {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
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
  background: var(--important-bg); color: var(--red);
  border-color: var(--important-border); font-weight: 800;
}
.status-important-orange {
  background: var(--orange-bg); color: var(--orange);
  border-color: var(--orange-border); font-weight: 800;
}

.table-scroll {
  overflow: scroll; height: calc(100vh - 228px); min-height: 360px; max-height: 760px;
  scrollbar-gutter: stable both-edges; overscroll-behavior: contain;
}
.table-scroll::-webkit-scrollbar { width: 12px; height: 12px; }
.table-scroll::-webkit-scrollbar-track { background: #eef2f7; border-radius: 999px; }
.table-scroll::-webkit-scrollbar-thumb { background: #98a2b3; border: 3px solid #eef2f7; border-radius: 999px; }
.table-scroll::-webkit-scrollbar-thumb:hover { background: #667085; }
.table-scroll::-webkit-scrollbar-corner { background: #eef2f7; }

table { width: 100%; border-collapse: separate; border-spacing: 0; }
th, td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); vertical-align: top; }
th {
  position: sticky; top: 0; z-index: 4; background: #f2f5f9;
  padding: 11px 12px; text-align: left; font-size: 12px;
  color: var(--text-soft); font-weight: 800; white-space: nowrap;
  min-width: 240px;
}
th:first-child, td:first-child {
  position: sticky; left: 0; z-index: 5; border-right: 1px solid var(--line-strong);
}
th:first-child { z-index: 8; width: 180px; }
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
  display: grid; grid-template-columns: auto 1fr; gap: 8px;
  padding: 8px; border: 1px solid var(--line); border-left-width: 3px;
  border-left-color: var(--line-strong); border-radius: 7px;
  background: #fff; min-width: 0;
}
.meeting.important { border-left-color: var(--red); background: var(--important-bg); }
.meeting.important-orange { border-left-color: var(--orange); background: var(--orange-bg); }
.date { color: var(--text-faint); font-size: 12px; line-height: 20px; white-space: nowrap; }
.meeting-main { min-width: 0; }
.meeting-title {
  color: var(--text); text-decoration: none; line-height: 1.45;
  font-weight: 650; overflow-wrap: anywhere;
}
.meeting-title:hover { color: var(--blue); }
.meeting.important .meeting-title { color: var(--red); font-weight: 800; }
.meeting.important .meeting-title:hover { color: #7a1610; }
.meeting.important-orange .meeting-title { color: var(--orange); font-weight: 800; }
.meeting.important-orange .meeting-title:hover { color: #92400e; }
.title-flag {
  display: inline-flex; align-items: center; height: 19px; padding: 0 6px;
  margin-right: 5px; border-radius: 5px; border: 1px solid;
  font-size: 11px; vertical-align: 1px; white-space: nowrap;
}
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
  .table-scroll { height: calc(100vh - 270px); min-height: 320px; max-height: none; }
}
@media (max-width: 560px) {
  .brand-title span { display: none; }
  .summary-grid { grid-template-columns: 1fr; }
  .segmented { width: 100%; }
  .segmented button { flex: 1; }
  .filters { align-items: stretch; }
  .select { width: 100%; }
  .top-actions .icon-btn:nth-child(1) { display: none; }
  .table-scroll { height: calc(100vh - 300px); min-height: 300px; }
}
@media (min-width: 1800px) {
  .table-scroll { height: calc(100vh - 236px); max-height: 980px; }
  th:first-child { width: 220px; }
}
@media (min-width: 2560px) {
  .table-scroll { height: calc(100vh - 248px); max-height: 1320px; }
  th:first-child { width: 260px; }
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
          <button data-filter="important">重要</button>
          <button data-filter="recent">最近两周</button>
        </div>
        <select class="select" id="teamSelect">
          <option value="all">全部团队</option>
        </select>
        <select class="select" id="weekSelect">
          <option value="all">全部周次</option>
        </select>
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
        <span class="pill status-important">重要会议优先显示</span>
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
</main>

<script>
const data = ${dataJson};
const weekKeys = ${weeksJson};
const weekLabels = ${weekLabelsJson};
const COMPACT_LIMIT = 3;

const state = { filter: 'all', team: 'all', week: 'all', query: '' };
const $ = id => document.getElementById(id);

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
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

function initControls() {
  data.forEach(row => $('teamSelect').insertAdjacentHTML('beforeend', '<option value="' + escapeHtml(row.name) + '">' + escapeHtml(row.name) + '</option>'));
  weekKeys.forEach(w => {
    const info = weekLabels[w] || { label: w };
    $('weekSelect').insertAdjacentHTML('beforeend', '<option value="' + w + '">' + info.label + '</option>');
  });

  $('segmented').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $('segmented').querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    render();
  });
  $('teamSelect').addEventListener('change', e => { state.team = e.target.value; render(); });
  $('weekSelect').addEventListener('change', e => { state.week = e.target.value; render(); });
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
  if (state.team !== 'all' && row.name !== state.team) return false;
  if (state.week !== 'all' && weekKey !== state.week) return false;
  if (state.filter === 'important' && !meeting.important) return false;
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
    if (state.team !== 'all' && row.name === state.team) return true;
    return hasVisible;
  });
}

function renderHead() {
  const vw = state.week === 'all' ? weekKeys : weekKeys.filter(w => w === state.week);
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
    const flag = m.important === 'red' ? '<span class="title-flag status-important">重要</span>'
      : m.important === 'orange' ? '<span class="title-flag status-important-orange">重要</span>' : '';
    const dn = highlightText(n, q);
    const title = m.url
      ? '<a class="meeting-title" href="' + escapeHtml(m.url) + '" target="_blank" rel="noopener">' + flag + dn + '</a>'
      : '<span class="meeting-title">' + flag + dn + '</span>';
    return '<article class="' + cls + '"><span class="date">' + d + '</span><div class="meeting-main">' + title + '</div></article>';
  }).join('');
  const more = sorted.length > COMPACT_LIMIT
    ? '<button class="show-more" type="button" onclick="this.parentElement.classList.remove(\\'compact\\');this.remove()">展开 ' + (sorted.length - COMPACT_LIMIT) + ' 条</button>'
    : '';
  return '<div class="meeting-list' + compact + '">' + items + more + '</div>';
}

function renderBody() {
  const rows = filteredRows();
  const vw = state.week === 'all' ? weekKeys : weekKeys.filter(w => w === state.week);

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
    const impTags = (redCount ? '<span class="tag status-important">' + redCount + ' 重要</span>' : '')
      + (orangeCount ? '<span class="tag status-important-orange">' + orangeCount + ' 关注</span>' : '');
    return '<tr><td><div class="team-cell"><div class="team-name">' + highlightText(row.name, state.query) + '</div><div class="team-meta"><span class="tag">' + total + ' 场</span>' + impTags + '</div></div></td>' +
      vw.map(w => '<td>' + renderMeetingList(row._weeks[w] || []) + '</td>').join('') + '</tr>';
  }).join('');

  const resultCount = rows.reduce((s, r) => s + Object.values(r._weeks).flat().length, 0);
  $('resultPill').textContent = resultCount + ' 条记录';
  $('captionText').textContent = resultCount ? '重要会议已置顶，空白周次用短横线保留节奏。' : '没有匹配结果，调整筛选或搜索词再试。';
}

function render() { renderHead(); renderBody(); }

initControls();
renderStats();
render();
</script>
</body>
</html>`;
}

// ========== 构建重要会议索引 ==========
function buildImportantSet(workspaceDir, importantPeople, teamLeaders) {
  const dataFile = path.join(workspaceDir, 'all-team-summaries.json');
  const importantMap = new Map();

  if (!fs.existsSync(dataFile)) return importantMap;

  const redPeople = new Set(importantPeople);
  const allLeaders = new Set(Object.values(teamLeaders || {}).filter(Boolean));

  const teams = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  for (const team of teams) {
    const leader = teamLeaders[team.team] || null;
    const checkList = leader ? [...importantPeople, leader] : [...importantPeople];
    for (const weekData of Object.values(team.weeks || {})) {
      for (const m of (weekData.meetings || [])) {
        const participants = m.participants || '';
        const title = m.title || '';
        const searchText = participants + ' ' + title;
        const hasRedPerson = [...redPeople].some(name => searchText.includes(name));
        const hasLeader = allLeaders.has(leader) && searchText.includes(leader);
        const wasMarked = m.important;

        let level = false;
        if (hasRedPerson) level = 'red';
        else if (hasLeader || wasMarked) level = 'orange';

        if (level) {
          const key = m.url || m.title;
          if (key) {
            const existing = importantMap.get(key);
            if (!existing || (level === 'red' && existing !== 'red')) {
              importantMap.set(key, level);
            }
          }
        }
      }
    }
  }
  return importantMap;
}

function isImportantMeeting(url, title, importantMap) {
  if (url && importantMap.has(url)) return importantMap.get(url);
  if (title) {
    const normalized = title.replace(/\.(otl|docx)$/i, '');
    if (importantMap.has(normalized)) return importantMap.get(normalized);
  }
  return false;
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

// ========== 全量扫描 ==========
async function fullScan(config, importantMap) {
  const pacer = new RequestPacer();
  console.log(`并行扫描 ${config.teams.length} 个团队（并发上限: ${pacer.maxConcurrent}）...`);

  const teamResults = await Promise.all(config.teams.map(async (teamCfg) => {
    const allFiles = [];
    const sources = getTeamSources(teamCfg);
    const monthEntries = sources.flatMap(source =>
      Object.entries(source.months || {}).map(([monthName, folderId]) => ({ source, monthName, folderId }))
    );
    const fileArrays = await Promise.all(
      monthEntries.map(({ source, folderId }) =>
        scanFolderAllAsync(source.drive_id, folderId, teamCfg.name, pacer)
      )
    );
    for (let i = 0; i < monthEntries.length; i++) {
      const files = fileArrays[i];
      allFiles.push(...files);
      console.log(`  ${teamCfg.name}/${monthEntries[i].monthName}: ${files.length} 个文件`);
    }

    const weekMap = {};
    for (const f of allFiles) {
      const weekKey = getWeekKey(f.name);
      if (weekKey === 'unknown') continue;
      if (!weekMap[weekKey]) weekMap[weekKey] = [];
      const title = normalizeTitle(f.name);
      const url = f.link || '';
      weekMap[weekKey].push({
        text: title,
        url,
        important: isImportantMeeting(url, f.name, importantMap)
      });
    }
    return { name: teamCfg.name, weeks: weekMap };
  }));

  return { teams: teamResults, lastUpdate: new Date().toISOString().slice(0, 10) };
}

// ========== 增量扫描 ==========
async function incrementalScan(config, existingData, importantMap) {
  const latestDate = findLatestDate(existingData);
  if (!latestDate) {
    console.log('无法确定最新日期，执行全量扫描...');
    return fullScan(config, importantMap);
  }

  const nextDate = new Date(currentYear(), latestDate.month - 1, latestDate.day + 1);
  const startMonth = nextDate.getMonth() + 1;
  const startDay = nextDate.getDate();
  console.log(`增量更新: 从 ${String(startMonth).padStart(2,'0')}-${String(startDay).padStart(2,'0')} 到今天 (最新标题日期: ${String(latestDate.month).padStart(2,'0')}-${String(latestDate.day).padStart(2,'0')})`);

  const pacer = new RequestPacer();

  const existingUrlSet = new Set();
  for (const team of existingData.teams) {
    for (const meetings of Object.values(team.weeks)) {
      for (const m of meetings) {
        if (m.url) existingUrlSet.add(m.url);
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

    const sources = getTeamSources(teamCfg);
    const monthEntries = sources.flatMap(source =>
      Object.entries(source.months || {}).map(([monthName, folderId]) => ({ source, monthName, folderId }))
    );

    const fileArrays = await Promise.all(
      monthEntries.map(({ source, folderId }) =>
        scanFolderFromDateAsync(source.drive_id, folderId, startMonth, startDay, teamCfg.name, pacer)
      )
    );

    for (let i = 0; i < monthEntries.length; i++) {
      const files = fileArrays[i];
      if (files.length > 0) console.log(`  ${teamCfg.name}/${monthEntries[i].monthName}: +${files.length} 个新文件`);

      for (const f of files) {
        if (f.link && existingUrlSet.has(f.link)) continue;

        const weekKey = getWeekKey(f.name);
        if (weekKey === 'unknown') continue;
        if (!existingTeam.weeks[weekKey]) existingTeam.weeks[weekKey] = [];

        const title = normalizeTitle(f.name);
        const url = f.link || '';

        const isDup = existingTeam.weeks[weekKey].some(m => m.url === url && url);
        if (isDup) continue;

        existingTeam.weeks[weekKey].push({
          text: title,
          url,
          important: isImportantMeeting(url, f.name, importantMap)
        });
        if (url) existingUrlSet.add(url);
        newCount++;
      }
    }
  }));

  console.log(`新增 ${newCount} 条会议记录`);
  existingData.lastUpdate = new Date().toISOString().slice(0, 10);
  return existingData;
}

// ========== 入口 ==========
async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const refresh = args.includes('--refresh');

  const workspaceDir = resolveWorkspaceDir();
  const configFile = path.join(__dirname, '..', 'config.json');
  const dataFilePath = path.join(workspaceDir, DATA_FILE);
  const htmlFilePath = path.join(workspaceDir, HTML_FILE);

  let kanbanData;

  if (offline) {
    if (!fs.existsSync(dataFilePath)) {
      console.error(`离线模式需要已有数据文件: ${dataFilePath}`);
      process.exit(1);
    }
    kanbanData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
    console.log(`离线模式: 跳过扫描，直接使用本地数据 (更新于 ${kanbanData.lastUpdate})`);
  } else {
    if (!fs.existsSync(configFile)) {
      console.error(`配置文件不存在: ${configFile}`);
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    const importantPeople = config.important_people || [];
    const teamLeaders = {};
    for (const t of config.teams) {
      if (t.leader) teamLeaders[t.name] = t.leader;
    }
    const importantMap = buildImportantSet(workspaceDir, importantPeople, teamLeaders);

    if (refresh) {
      console.log('--refresh: 清除文件夹缓存，强制重新拉取...');
      for (const t of config.teams) clearFolderCache(t.name);
    }

    const startTime = Date.now();
    if (refresh || !fs.existsSync(dataFilePath)) {
      console.log(refresh ? '强制全量扫描...' : '看板数据不存在，执行全量扫描...');
      kanbanData = await fullScan(config, importantMap);
    } else {
      const existing = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
      console.log(`已有看板数据 (更新于 ${existing.lastUpdate})，执行增量更新...`);
      kanbanData = await incrementalScan(config, existing, importantMap);
    }
    console.log(`扫描完成，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    fs.writeFileSync(dataFilePath, JSON.stringify(kanbanData, null, 2), 'utf-8');
  }

  const html = generateHtml(kanbanData);
  fs.writeFileSync(htmlFilePath, html, 'utf-8');

  let totalMeetings = 0;
  for (const team of kanbanData.teams) {
    for (const meetings of Object.values(team.weeks)) totalMeetings += meetings.length;
  }
  console.log(`看板已生成: ${(Buffer.byteLength(html) / 1024).toFixed(1)}KB -> ${HTML_FILE}`);
  console.log(`  团队数: ${kanbanData.teams.length}, 会议数: ${totalMeetings}`);
}

main().catch(console.error);
