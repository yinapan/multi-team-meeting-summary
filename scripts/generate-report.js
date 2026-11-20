const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');
const {
  outputPath, printAiReviewWarning, normalizeDate, getBaselineFileName,
  createMeetingBaseline, isConfidentialMeetingTitle
} = require('./shared');
const { agentRunDir, reportMode } = require('./report-agent');

function runNode(scriptName, args, options = {}) {
  const startedAt = Date.now();
  const scriptPath = path.join(__dirname, scriptName);
  try {
    execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(options.env || {})
      },
      timeout: options.timeout || 1800000
    });
    return Number(((Date.now() - startedAt) / 1000).toFixed(1));
  } catch (error) {
    const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
    if (error.code === 'ETIMEDOUT') {
      console.error(`模块超时：${scriptName} 已运行 ${elapsedSec}s。KDocs 可能正在限流，请稍后重试。`);
    }
    throw error;
  }
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// The scan writes period-independent files. Bind both report stages to the
// same batch even if another report or dashboard runs between agent turns.
function captureBatch(rangeDir, startDate, endDate, config) {
  const baselineName = getBaselineFileName(startDate, endDate);
  const inputs = new Map();
  function load(name) {
    const bytes = fs.readFileSync(outputPath(name));
    inputs.set(name, bytes);
    return JSON.parse(bytes.toString('utf8'));
  }

  const baseline = load(baselineName);
  const summaries = load('all-team-summaries.json');
  const batchStats = load('batch-read-stats.json');
  const teamNames = config.teams.map(team => team.name);
  const teamEntries = teamNames.map(name => load(`team-summary-${name}.json`));
  const rebuilt = createMeetingBaseline(teamEntries, { startDate, endDate, applyMeetingTitleFilters: true });
  const matchesPeriod = baseline.startDate === startDate && baseline.endDate === endDate
    && isDeepStrictEqual(baseline.teams, rebuilt.teams)
    && isDeepStrictEqual(baseline.counts, rebuilt.counts)
    && isDeepStrictEqual(teamEntries.map(t => t.team), teamNames)
    && isDeepStrictEqual(summaries.map(t => t.team), teamNames);
  if (!matchesPeriod) throw new Error('当前批次与日期基线不一致。请重新运行相同日期的 report 命令以刷新数据。');
  for (const [index, team] of teamEntries.entries()) {
    const meetings = Object.values(summaries[index].weeks).flatMap(w => w.meetings);
    const key = (title, url) => JSON.stringify([title, url || '']);
    const byMeeting = new Map(meetings.map(m => [key(m.title, m.url), m]));
    const docKey = doc => key(doc.name.replace(/\.(\w+)$/i, ''), doc.url);
    const expected = new Set([...team.documents, ...(team.unreadableMeetings || [])].map(docKey));
    if (meetings.some(m => isConfidentialMeetingTitle(m.title) || !expected.has(key(m.title, m.url))) || team.documents.some(doc => {
      const meeting = byMeeting.get(docKey(doc));
      return isConfidentialMeetingTitle(doc.name) || !meeting
        || meeting.rawContent !== (doc.rawContent || '')
        || !isDeepStrictEqual(meeting.meetingDate, doc.meetingDate || null);
    })) {
      throw new Error(`团队 ${team.team} 的会议清单与正文批次不一致。请重新运行相同日期的 report 命令。`);
    }
  }

  const dir = fs.mkdtempSync(path.join(rangeDir, 'batch-'));
  for (const [name, bytes] of inputs) fs.writeFileSync(path.join(dir, name), bytes);
  const pointer = path.join(rangeDir, 'batch.json');
  const tmp = path.join(rangeDir, `batch-${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ directory: path.basename(dir), startDate, endDate }));
  fs.renameSync(tmp, pointer);
  return { dir, batchStats };
}

function agentBatch(startDate, endDate, resume, config) {
  const dir = agentRunDir(startDate, endDate);
  fs.mkdirSync(dir, { recursive: true });
  const pointer = resume && readJsonIfExists(path.join(dir, 'batch.json'));
  if (!pointer) return captureBatch(dir, startDate, endDate, config);
  if (pointer.startDate !== startDate || pointer.endDate !== endDate || !/^batch-[a-zA-Z0-9]+$/.test(pointer.directory)) {
    throw new Error('Agent 批次索引与请求日期不一致。请重新运行相同日期的 report 命令。');
  }
  const batchDir = path.join(dir, pointer.directory);
  const baseline = readJsonIfExists(path.join(batchDir, getBaselineFileName(startDate, endDate)));
  const batchStats = readJsonIfExists(path.join(batchDir, 'batch-read-stats.json'));
  if (!baseline || !batchStats || baseline.startDate !== startDate || baseline.endDate !== endDate
    || !isDeepStrictEqual(baseline.teams.map(t => t.team), config.teams.map(t => t.name))) {
    throw new Error('Agent 批次不完整或团队配置已变更。请重新运行相同日期的 report 命令。');
  }
  return { dir: batchDir, batchStats };
}

function cacheModeLabel(batchStats) {
  if (batchStats?.mode === 'cache-rebuild' || batchStats?.cacheRebuildUsed) {
    return 'cache-rebuild';
  }
  return 'direct-read';
}

function main() {
  const args = process.argv.slice(2);
  if (!args[0] || !args[1]) {
    console.error('用法: node scripts/generate-report.js <start_date> <end_date> [--resume-agent]');
    console.error('示例: node scripts/generate-report.js 05-11 05-24');
    process.exit(1);
  }

  const [startDate, endDate] = args.slice(0, 2).map(normalizeDate);
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
  const usingAgent = reportMode(config) === 'agent';
  const resume = args.includes('--resume-agent');
  if (resume && !usingAgent) throw new Error('--resume-agent 仅适用于 agent 模式。');
  const timings = [];

  if (!resume) {
    timings.push({
      module: '批量读取会议记录',
      elapsedSec: runNode('batch-read-documents.js', [startDate, endDate, '--report-analysis-filter'], {
        env: { APPLY_REPORT_ANALYSIS_FILTER: '1' }
      })
    });
  }
  const batch = usingAgent ? agentBatch(startDate, endDate, resume, config) : null;
  const batchStats = batch ? batch.batchStats : readJsonIfExists(outputPath('batch-read-stats.json'));
  const reportEnv = batch ? { MEETING_REPORT_INPUT_DIR: batch.dir } : {};
  if (resume) timings.push({ module: '批量读取会议记录（复用）', elapsedSec: batchStats.elapsedSec });
  let stage = '生成团队 LLM 摘要';
  try {
    timings.push({
      module: stage,
      elapsedSec: runNode('generate-team-report.js', [startDate, endDate, '--no-kanban'], {
        env: { ...reportEnv, SKIP_AUTO_KANBAN: '1' }
      })
    });
    stage = '生成综合分析报告';
    timings.push({ module: stage, elapsedSec: runNode('generate-comprehensive-report.js', [startDate, endDate], { env: reportEnv }) });
  } catch (error) {
    if (!usingAgent || error.status !== 75) throw error;
    const status = { type: 'main-report-flow', status: 'awaiting-agent', startDate, endDate, mode: 'agent', stage, timings };
    fs.writeFileSync(outputPath('main-report-generation-stats.json'), JSON.stringify(status, null, 2));
    console.log(`当前会话的 agent 请读取本次列出的提示，为每个请求写入对应的 .answer.md，然后执行 npm run report -- ${startDate} ${endDate} --resume-agent，直至生成 Word 报告。`);
    process.exitCode = 75;
    return;
  }

  const teamStats = readJsonIfExists(outputPath('report-generation-stats.json'));
  const comprehensiveStats = readJsonIfExists(outputPath('comprehensive-report-generation-stats.json'));
  if (!comprehensiveStats || comprehensiveStats.startDate !== startDate || comprehensiveStats.endDate !== endDate
    || !comprehensiveStats.output || !fs.existsSync(outputPath(comprehensiveStats.output))) {
    throw new Error('综合报告输出与请求日期不一致。');
  }
  const dataSourceMode = cacheModeLabel(batchStats);
  const timingSummary = timings.map(t => `${t.module}:${t.elapsedSec}s`).join('；');
  const llmUsed = Boolean(teamStats?.summary?.llm || comprehensiveStats?.llmUsed);
  const mode = comprehensiveStats?.mode || (llmUsed ? 'llm' : 'rules-fallback');

  const orchestrationStats = {
    type: 'main-report-flow',
    startDate,
    endDate,
    generatedAt: new Date().toISOString(),
    mode,
    llmUsed,
    dataSourceMode,
    cacheRebuildReason: dataSourceMode === 'cache-rebuild'
      ? 'KDocs 返回限流，已用本地缓存数据重建输出；限流解除后需要重新跑数据刷新最新内容。'
      : null,
    timings,
    batchRead: batchStats || null,
    teamSummary: teamStats?.summary || null,
    comprehensive: comprehensiveStats || null
  };
  const statsFile = outputPath('main-report-generation-stats.json');
  fs.writeFileSync(statsFile, JSON.stringify(orchestrationStats, null, 2), 'utf-8');

  printAiReviewWarning({
    title: '综合会议记录汇总分析报告',
    output: outputPath(comprehensiveStats.output),
    statsFile,
    mode,
    llmUsed,
    timingSummary: `${timingSummary}；数据来源:${dataSourceMode === 'cache-rebuild' ? '限流后缓存重建' : '直接读取/缓存命中'}`
  });
  if (dataSourceMode === 'cache-rebuild') {
    console.log('⚠️ 本次结果已标记为“限流后缓存重建”。KDocs 限流解除后，请重新运行 npm run report -- <start> <end> 刷新数据。');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.status || 1;
  }
}
