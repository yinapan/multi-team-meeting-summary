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

  const teamStats = readJsonIfExists(outputPath('report-generation-stats.json'));
  const comprehensiveStats = readJsonIfExists(outputPath('comprehensive-report-generation-stats.json'));
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
    timings,
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
    timingSummary
  });
}

if (require.main === module) {
  main();
}
