const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { outputPath, printAiReviewWarning } = require('./shared');

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

function cacheModeLabel(batchStats) {
  if (batchStats?.mode === 'cache-rebuild' || batchStats?.cacheRebuildUsed) {
    return 'cache-rebuild';
  }
  return 'direct-read';
}

function main() {
  const args = process.argv.slice(2);
  if (!args[0] || !args[1]) {
    console.error('用法: node scripts/generate-report.js <start_date> <end_date>');
    console.error('示例: node scripts/generate-report.js 05-11 05-24');
    process.exit(1);
  }

  const [startDate, endDate] = args;
  const timings = [];

  timings.push({ module: '批量读取会议记录', elapsedSec: runNode('batch-read-documents.js', [startDate, endDate]) });
  timings.push({
    module: '生成团队 LLM 摘要',
    elapsedSec: runNode('generate-team-report.js', [startDate, endDate, '--no-kanban'], {
      env: { SKIP_AUTO_KANBAN: '1' }
    })
  });
  timings.push({ module: '生成综合分析报告', elapsedSec: runNode('generate-comprehensive-report.js', [startDate, endDate]) });

  const batchStats = readJsonIfExists(outputPath('batch-read-stats.json'));
  const teamStats = readJsonIfExists(outputPath('report-generation-stats.json'));
  const comprehensiveStats = readJsonIfExists(outputPath('comprehensive-report-generation-stats.json'));
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
    output: outputPath(`综合分析报告-${startDate.replace(/\-/g, '')}-${endDate.replace(/\-/g, '')}.docx`),
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
  main();
}
