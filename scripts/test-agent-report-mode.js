const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

// Preloaded only by the isolated report processes. Exercise the real batch reader
// with synthetic WPS records and fail the test on any provider or network access.
function installFixture(project) {
  function forbid(message) {
    process.stderr.write(message + '\n');
    process.exit(91);
  }
  for (const method of ['readFileSync', 'existsSync']) {
    const original = fs[method];
    fs[method] = (file, ...args) => {
      if (typeof file === 'string' && path.basename(file).toLowerCase() === 'openclaw.json') {
        forbid('agent mode accessed openclaw.json');
      }
      return original(file, ...args);
    };
  }
  require('node:net').Socket.prototype.connect = () => forbid('agent mode attempted a network connection');

  if (path.basename(process.argv[1] || '') !== 'batch-read-documents.js') return;
  const shared = require(path.join(project, 'scripts', 'shared'));
  shared.scanAllTeams = async () => {
    fs.appendFileSync(path.join(project, 'scans.txt'), 'scan\n');
    const files = ['Red', 'Blue', 'Beta'].map(label => ({
      name: '0512-' + label + '周会.otl',
      sourceLabel: label,
      id: label,
      drive_id: 'fixture',
      mtime: 1,
      link: 'https://fixture.invalid/' + label
    }));
    return [{ team: 'Alpha', files: files.slice(0, 2) }, { team: 'Beta', files: files.slice(2) }];
  };
  shared.readDocAsync = async (drive, id) => {
    const progress = process.env.FIXTURE_REVISION || '核验样本数据';
    return '结论1：' + id + '团队完成' + progress + '，进入下一轮验收。';
  };
}

function analysis(marker) {
  return [
    '## 1.2 主要趋势', '本期关键进展是' + marker + '。',
    '# 二、风险点分析', '会议没有列出明确风险。',
    '# 三、重点关注节点', '团队计划进行下一轮验收。',
    '# 四、各团队会议汇总', '## Alpha', '本期两个来源均完成样本数据核验。',
    '# 五、综合评估与建议', '下一轮验收时复核样本数据。'
  ].join('\n\n');
}

async function testAgentFlow() {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const project = fs.mkdtempSync(path.join(tempRoot, 'meeting-report-test-'));
  const outputs = path.join(project, 'outputs');
  const requests = path.join(outputs, 'agent-0511-0524');
  const promptFiles = () => fs.readdirSync(requests).filter(name => name.endsWith('.prompt.md'));
  const answerPath = prompt => path.join(requests, prompt.replace(/\.prompt\.md$/, '.answer.md'));
  const readStats = file => JSON.parse(fs.readFileSync(path.join(outputs, file), 'utf8'));

  function runReport(args, expectedStatus, revision = '') {
    const result = spawnSync(process.execPath, ['scripts/generate-report.js', '05-11', '05-24', ...args], {
      cwd: project,
      env: {
        ...process.env,
        NODE_PATH: path.resolve(__dirname, '..', 'node_modules'),
        NODE_OPTIONS: '--require="' + __filename.replace(/\\/g, '/') + '"',
        MEETING_AGENT_TEST_PROJECT: project,
        FIXTURE_REVISION: revision
      },
      encoding: 'utf8',
      timeout: 30000
    });
    if (result.error) throw result.error;
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  }

  try {
    fs.cpSync(__dirname, path.join(project, 'scripts'), { recursive: true });
    fs.mkdirSync(outputs);
    fs.writeFileSync(path.join(project, 'config.json'), JSON.stringify({
      teams: [{ name: 'Alpha', sources: [{ label: 'Red' }, { label: 'Blue' }] }, { name: 'Beta' }],
      llm: { baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-test-key' }
    }));
    fs.writeFileSync(path.join(outputs, 'team-llm-summary-Alpha.md'), 'stale-summary-sentinel');

    runReport([], 75);
    const teams = promptFiles();
    assert.equal(teams.length, 3, 'prepare all team sources in one pass');
    assert.ok(!fs.readdirSync(outputs).some(name => name.endsWith('.docx')));
    // A dashboard may replace the global batch between analysis stages.
    fs.writeFileSync(path.join(outputs, 'all-team-summaries.json'), '[]');
    fs.writeFileSync(path.join(outputs, 'team-summary-Alpha.json'), '{"team":"Alpha","documents":[]}');
    fs.writeFileSync(answerPath(teams[0]), analysis('第一份摘要结论'));
    fs.writeFileSync(answerPath(teams[1]), '  \n');
    runReport(['--resume-agent'], 75);
    assert.deepEqual(promptFiles().sort(), teams.sort(), 'wait for every source before preparing the comprehensive report');

    fs.writeFileSync(answerPath(teams[1]), analysis('第二份摘要结论'));
    fs.writeFileSync(answerPath(teams[2]), analysis('第三份摘要结论'));
    runReport(['--resume-agent'], 75);
    const comprehensive = promptFiles().filter(prompt => !teams.includes(prompt));
    assert.equal(comprehensive.length, 1);
    const input = fs.readFileSync(path.join(requests, comprehensive[0]), 'utf8');
    assert.ok(input.includes('第一份摘要结论') && input.includes('第二份摘要结论'));
    assert.ok(!input.includes('stale-summary-sentinel'));

    const flatAnswer = analysis('本次综合分析结论').replace('本期两个来源均完成样本数据核验。', '样本已核验。\n\n## Beta\n\n正在验收。');
    const comprehensiveAnswer = answerPath(comprehensive[0]);
    fs.writeFileSync(comprehensiveAnswer, flatAnswer);
    const diagnostic = runReport(['--resume-agent'], 75);
    assert.ok(diagnostic.includes('会议统计') && diagnostic.includes(comprehensiveAnswer));
    const detailed = flatAnswer.replace('样本已核验。', [
      '### 会议统计', '本期共 99 场会议。',
      ...['Blue', 'Red'].flatMap(label => [
        '### ' + label, '#### 核心议题', `• 【Alpha-${label}】样本数据核验。`,
        '#### 关键决议', `• 【Alpha-${label}】进入下一轮验收。`
      ])
    ].join('\n')).replace('正在验收。', [
      '### 会议统计', '本期共 99 场会议。',
      '### 核心议题', '• 单来源会议讨论样本数据核验。',
      '### 关键决议', '本期纪要未记录明确的关键决议。'
    ].join('\n'));
    fs.writeFileSync(comprehensiveAnswer, detailed.replace('• 单来源会议讨论', '单来源会议讨论'));
    assert.match(runReport(['--resume-agent'], 75), /Beta的“核心议题”须逐条使用项目符号/);
    fs.writeFileSync(comprehensiveAnswer, detailed);
    runReport(['--resume-agent'], 0);
    assert.equal(fs.readFileSync(path.join(project, 'scans.txt'), 'utf8'), 'scan\n', 'resume must reuse the original batch');
    const stats = readStats('comprehensive-report-generation-stats.json');
    assert.equal(stats.mode, 'agent');
    assert.equal(stats.llmUsed, true);
    assert.equal(stats.documents, 3);
    assert.equal(readStats('main-report-generation-stats.json').llmUsed, true);
    const reportFile = path.join(outputs, stats.output);
    const completedReport = fs.readFileSync(reportFile);
    const document = await JSZip.loadAsync(completedReport);
    const xml = await document.file('word/document.xml').async('string');
    assert.ok(xml.includes('本次综合分析结论'), 'render the actual supplied agent analysis');
    assert.ok(xml.includes('本期共 2 场会议，其中 0 场为重要会议。下文汇总 2 项核心议题、2 项关键决议。'));
    assert.ok(xml.includes('本期共 1 场会议，其中 0 场为重要会议。下文汇总 1 项核心议题、0 项关键决议。'));
    assert.ok(!xml.includes('99 场会议') && !xml.includes('####'));
    const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g);
    for (const heading of ['会议统计', '核心议题', '关键决议']) {
      const matches = paragraphs.filter(p => p.includes('>' + heading + '</w:t>'));
      assert.equal(matches.length, heading === '会议统计' ? 2 : 3);
      assert.ok(matches.every(p => p.includes('<w:b/>') && p.includes('<w:keepNext/>')));
    }
    const realList = paragraphs.filter(p => /【Alpha-(Red|Blue)】|单来源会议讨论/.test(p));
    assert.equal(realList.length, 5);
    assert.ok(realList.every(p => p.includes('<w:numPr>')), 'render each item as a native Word list paragraph');
    assert.match(xml, /agent/i);
    assert.ok(!xml.includes('未使用 LLM，使用规则回退生成'));

    runReport([], 75, '修订后的样本核验');
    assert.equal(promptFiles().filter(name => !teams.includes(name) && !comprehensive.includes(name)).length, 3,
      'changed evidence requires new answers even for the same date range');
    assert.deepEqual(fs.readFileSync(reportFile), completedReport, 'awaiting agent input must preserve completed reports');
  } finally {
    const target = fs.realpathSync(project);
    assert.equal(path.dirname(target), tempRoot);
    assert.ok(path.basename(target).startsWith('meeting-report-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}

if (require.main === module) {
  testAgentFlow().then(() => console.log('agent report flow tests passed')).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (process.env.MEETING_AGENT_TEST_PROJECT) {
  installFixture(process.env.MEETING_AGENT_TEST_PROJECT);
}
