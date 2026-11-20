const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
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

  if (process.env.FIXTURE_API_REPORT && path.basename(process.argv[1]) === 'generate-comprehensive-report.js') {
    const shared = require(path.join(project, 'scripts', 'shared'));
    shared.callLLM = async (_prompt, _config, { onModel }) => {
      onModel('fixture-api-model');
      return fs.readFileSync(process.env.FIXTURE_API_REPORT, 'utf8');
    };
    return;
  }
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
    const notes = {
      Red: '确认于5月20日复核样本，遗漏的数据可能影响验收。',
      Blue: '完成首轮比对，发现两份样本仍缺校验记录。',
      Beta: '完成样本编码核对，共享抽查结果，尚未形成新的决议。'
    };
    return '结论1：' + id + '团队完成' + progress + '。\n结论2：' + notes[id];
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

function comprehensiveDraft() {
  return [
    '## 1.2 主要趋势',
    '• 本次综合分析结论来自本期核验记录。【Alpha-Blue】完成首轮比对，Beta 完成样本编码核对。',
    '• 核验进度须与覆盖范围一起看。【Alpha-Blue】尚有两份样本缺少记录，Beta 已共享抽查结果。',
    '• 复查有了日期。【Alpha-Red】约定在 5 月 20 日复核。',
    '• 抽查结果已有交付。Beta 完成样本编码核对，并共享了抽查结果。',
    '• 缺失记录仍影响验收准备。【Alpha-Red】记录了遗漏数据的风险，【Alpha-Blue】确认存在待补记录。',
    '# 二、风险点分析', '本期风险集中在样本覆盖和验收依据。',
    '## 2.1 高风险事项', '• 【高】【Alpha-Red】遗漏的数据可能影响验收。',
    '## 2.2 中风险事项', '本期未发现中风险事项。',
    '## 2.3 风险矩阵',
    '| 风险项 | 等级 | 影响范围 |\n|---|---|---|\n| 遗漏的数据可能影响验收 | 高 | Alpha-Red |',
    '# 三、重点关注节点', '本期记录了一项目标日期，尚无中期排期。',
    '## 3.1 近期节点（本月内）',
    '| 节点 | 时间 | 负责人/部门 | 状态 |\n|---|---|---|---|\n| 复核样本 | 5 月 20 日 | Alpha-Red | 筹备中 |',
    '## 3.2 中期节点（未来两个月）', '未来两个月暂无明确时间节点。',
    '## 3.3 持续跟进事项', '• 【Alpha-Blue】跟进两份缺少记录的样本。',
    '# 四、各团队会议汇总', '## Alpha', '样本已核验。',
    '## Beta', '正在验收。',
    '# 五、综合评估与建议',
    '## 5.1 样本核验与质量保障', '已有样本核验结果，还有两份校验记录待补。',
    '• **推进较好**：Beta 已完成样本编码核对并共享抽查结果。',
    '• **推进一般**：【Alpha-Blue】首轮比对已完成，两份样本仍缺校验记录。',
    '• **待加强**：【Alpha-Red】遗漏的数据可能影响验收，需在约定复核时检查覆盖范围。',
    '## 5.2 复核排期', '本期记录了一项明确日期的复核安排。',
    '• **推进一般：**【Alpha-Red】团队已确定 5 月 20 日复核，结果待确认。',
    '## 5.3 结果共享', '样本编码核对结果已进入共享环节。',
    '• **推进较好**：Beta 已共享抽查结果。',
    '## 5.4 验收依据', '仍有两份样本的校验记录待补齐。',
    '• **待加强**：【Alpha-Blue】两份样本缺少校验记录，验收前应逐项复核。'
  ].join('\n\n');
}

async function testApiModel() {
  const { callLLM, formatGenerationMode } = require('./shared');
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      model: 'served-model-snapshot',
      choices: [{ message: { content: 'server-generated analysis' } }]
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const reports = [];
    const llm = {
      mode: 'api', baseUrl: 'http://127.0.0.1:' + server.address().port,
      apiKey: 'fixture-only', model: 'configured-routing-alias'
    };
    const onModel = model => reports.push(model);
    assert.equal(await callLLM('fixture', { llm }, { onModel }), 'server-generated analysis');
    assert.deepEqual(reports, ['served-model-snapshot'], 'API attribution follows the model in the response');
    assert.equal(await callLLM('fixture', { llm: { ...llm, mode: 'rules' } }, { onModel }), null);
    assert.deepEqual(reports, ['served-model-snapshot'], 'rules never claim an LLM generated content');
    assert.equal(formatGenerationMode('rules-fallback', reports), formatGenerationMode('rules-fallback'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testAgentFlow() {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const project = fs.mkdtempSync(path.join(tempRoot, 'meeting-report-test-'));
  const outputs = path.join(project, 'outputs');
  const requests = path.join(outputs, 'agent-0511-0524');
  const promptFiles = () => fs.readdirSync(requests).filter(name => name.endsWith('.prompt.md'));
  const answerPath = prompt => path.join(requests, prompt.replace(/\.prompt\.md$/, '.answer.md'));
  const readStats = file => JSON.parse(fs.readFileSync(path.join(outputs, file), 'utf8'));

  function runReport(args, expectedStatus, revision = '', command = 'generate-report.js') {
    const result = spawnSync(process.execPath, ['scripts/' + command, '05-11', '05-24', ...args], {
      cwd: project,
      env: {
        ...process.env,
        NODE_PATH: path.resolve(__dirname, '..', 'node_modules'),
        NODE_OPTIONS: '--require="' + __filename.replace(/\\/g, '/') + '"',
        MEETING_AGENT_TEST_PROJECT: project,
        FIXTURE_REVISION: revision,
        FIXTURE_API_REPORT: command === 'generate-comprehensive-report.js' ? path.join(project, 'api-response.md') : ''
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
      llm: { baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-test-key', model: 'unrelated-api-model' }
    }));
    fs.writeFileSync(path.join(outputs, 'team-llm-summary-Alpha.md'), 'stale-summary-sentinel');

    runReport([], 75);
    const teams = promptFiles().sort();
    assert.equal(teams.length, 3, 'prepare all team sources in one pass');
    const teamAnswer = (prompt, marker) => {
      // Beta has a legacy answer without attribution. It may be rendered by a different session.
      const source = ['Blue', 'Red'].find(label => prompt.startsWith('team-Alpha-' + label + '-'));
      return (source ? '<!-- report-model: model-' + source + ' -->\n' : '') + analysis(marker);
    };
    assert.ok(!fs.readdirSync(outputs).some(name => name.endsWith('.docx')));
    // A dashboard may replace the global batch between analysis stages.
    fs.writeFileSync(path.join(outputs, 'all-team-summaries.json'), '[]');
    fs.writeFileSync(path.join(outputs, 'team-summary-Alpha.json'), '{"team":"Alpha","documents":[]}');
    fs.writeFileSync(answerPath(teams[0]), teamAnswer(teams[0], '第一份摘要结论'));
    fs.writeFileSync(answerPath(teams[1]), '  \n');
    runReport(['--resume-agent'], 75);
    assert.deepEqual(promptFiles().sort(), teams.sort(), 'wait for every source before preparing the comprehensive report');

    fs.writeFileSync(answerPath(teams[1]), teamAnswer(teams[1], '第二份摘要结论'));
    fs.writeFileSync(answerPath(teams[2]), teamAnswer(teams[2], '第三份摘要结论'));
    runReport(['--resume-agent'], 75);
    const comprehensive = promptFiles().filter(prompt => !teams.includes(prompt));
    assert.equal(comprehensive.length, 1);
    const input = fs.readFileSync(path.join(requests, comprehensive[0]), 'utf8');
    assert.ok(input.includes('第一份摘要结论') && input.includes('第二份摘要结论'));
    assert.ok(!input.includes('stale-summary-sentinel'));
    assert.ok(!input.includes('<!-- report-model:'), 'team model tags must not become meeting evidence');

    const flatAnswer = comprehensiveDraft();
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

    const invalidSections = [
      ['1.2 list', '• 本次综合分析结论', '本次综合分析结论'],
      ['2.1 severity', '• 【高】【Alpha-Red】', '• 【中】【Alpha-Red】'],
      ['2.3 matrix columns', '| 风险项 | 等级 | 影响范围 |', '| 风险项 | 等级 | 管理建议 |'],
      ['2.3 risks must be in the corresponding list', '| 遗漏的数据可能影响验收 | 高 |', '| 供应商突然变更 | 高 |'],
      ['3.1 time window', '## 3.1 近期节点（本月内）', '## 3.1 近期节点'],
      ['3.1 owner', '| Alpha-Red | 筹备中 |', '| UnknownTeam | 筹备中 |'],
      ['3.1 status', '| Alpha-Red | 筹备中 |', '| Alpha-Red | 尚可 |'],
      ['3.3 source', '• 【Alpha-Blue】跟进两份', '• 【Alpha】跟进两份'],
      ['5.1 summary in place of grades', /• \*\*推进较好\*\*：Beta 已完成样本编码核对并共享抽查结果。[^#]+(?=## 5\.2)/,
        '建议下次验收时复核。\n\n'],
      ['5.1 grade without evidence', '• **推进较好**：Beta 已完成样本编码核对并共享抽查结果。', '• **推进较好**：'],
      ['5.1 grades out of order', '• **推进较好**：Beta 已完成样本编码核对并共享抽查结果。', '• **待加强**：Beta 需跟进样本核对记录。'],
      ['5.1 duplicate grade', '• **推进一般**：【Alpha-Blue】首轮比对已完成', '• **推进较好**：【Alpha-Blue】首轮比对已完成'],
      ['5.1 unknown team', '• **推进较好**：Beta 已完成样本编码核对并共享抽查结果。', '• **推进较好**：UnknownTeam 已完成样本编码核对。'],
      ['5.2 numbering', '## 5.2 复核排期', '## 5.9 复核排期']
    ];
    for (const [name, from, to] of invalidSections) {
      const invalid = detailed.replace(from, to);
      assert.notEqual(invalid, detailed, name);
      fs.writeFileSync(comprehensiveAnswer, invalid);
      const message = runReport(['--resume-agent'], 75);
      assert.ok(message.includes(comprehensiveAnswer), name + ' must identify the answer to revise');
      assert.ok(!readStats('comprehensive-report-generation-stats.json').output, name + ' must not publish a report');
    }

    const noEvidence = detailed
      .replace('• 【高】【Alpha-Red】遗漏的数据可能影响验收。', '本期未发现高风险事项。')
      .replace(/\| 风险项 \| 等级 \| 影响范围 \|[^#]+(?=# 三)/, '本期未发现高风险或中风险事项。\n\n')
      .replace(/\| 节点 \| 时间 \| 负责人\/部门 \| 状态 \|[^#]+(?=## 3\.2)/, '本月内暂无明确时间节点。\n\n')
      .replace('• **待加强**：【Alpha-Blue】两份样本缺少校验记录，验收前应逐项复核。', '数据不足，暂无法分析。');
    fs.writeFileSync(comprehensiveAnswer, noEvidence);
    runReport(['--resume-agent'], 0);
    fs.writeFileSync(comprehensiveAnswer, '<!-- report-model: synthesis-model -->\n' + detailed);
    const completed = runReport(['--resume-agent'], 0);
    assert.ok(completed.includes('synthesis-model'));
    assert.equal(fs.readFileSync(path.join(project, 'scans.txt'), 'utf8'), 'scan\n', 'resume must reuse the original batch');
    const stats = readStats('comprehensive-report-generation-stats.json');
    assert.equal(stats.mode, 'agent');
    assert.equal(stats.llmUsed, true);
    assert.equal(stats.documents, 3);
    assert.deepEqual(stats.models, ['synthesis-model']);
    const mainStats = readStats('main-report-generation-stats.json');
    assert.equal(mainStats.llmUsed, true);
    assert.deepEqual(mainStats.models, ['synthesis-model']);
    const teamStats = readStats('report-generation-stats.json').teams;
    const alpha = teamStats.find(t => t.team === 'Alpha');
    const beta = teamStats.find(t => t.team === 'Beta');
    assert.deepEqual([...alpha.models].sort(), ['model-Blue', 'model-Red']);
    assert.deepEqual(Object.fromEntries(alpha.details.map(d => [d.label, d.model])), {
      Red: 'model-Red', Blue: 'model-Blue'
    });
    assert.deepEqual(beta.models.filter(Boolean), [], 'unattributed answers must not pick up another model');
    assert.ok(!beta.details[0].model);
    for (const team of [alpha, beta]) {
      const doc = await JSZip.loadAsync(fs.readFileSync(path.join(outputs, team.output)));
      const teamXml = await doc.file('word/document.xml').async('string');
      assert.ok(!teamXml.includes('report-model:') && !teamXml.includes('unrelated-api-model'));
      assert.equal(teamXml.includes('model-Blue'), team === alpha);
      assert.equal(teamXml.includes('model-Red'), team === alpha);
    }
    const summaryFiles = fs.readdirSync(requests).filter(f => f.endsWith('.summary.md'));
    assert.equal(summaryFiles.length, 2);
    for (const file of summaryFiles) {
      assert.ok(!fs.readFileSync(path.join(requests, file), 'utf8').includes('report-model:'));
    }
    const reportFile = path.join(outputs, stats.output);
    const completedReport = fs.readFileSync(reportFile);
    const document = await JSZip.loadAsync(completedReport);
    const xml = await document.file('word/document.xml').async('string');
    assert.ok(xml.includes('synthesis-model') && !xml.includes('report-model:'));
    assert.ok(!xml.includes('model-Blue') && !xml.includes('model-Red') && !xml.includes('unrelated-api-model'));
    assert.ok(!fs.readFileSync(path.join(outputs, 'comprehensive-llm-summary-0511-0524.md'), 'utf8').includes('report-model:'));
    assert.ok(xml.includes('本次综合分析结论'), 'render the actual supplied agent analysis');
    assert.ok(xml.includes('本期共 2 场会议，其中 0 场为重要会议。下文汇总 2 项核心议题、2 项关键决议。'));
    assert.ok(xml.includes('本期共 1 场会议，其中 0 场为重要会议。下文汇总 1 项核心议题、0 项关键决议。'));
    assert.ok(!xml.includes('99 场会议') && !xml.includes('####'));
    const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g);
    const titles = ['一、执行摘要', '二、风险点分析', '三、重点关注节点', '四、各团队会议汇总', '五、综合评估与建议', '六、附录：会议清单与文档纳入率'];
    const chapterPositions = titles.map(title => {
      const pos = paragraphs.findIndex(p => p.includes('>' + title + '</w:t>'));
      assert.ok(pos >= 0 && paragraphs[pos].includes('w:pStyle'), 'missing Word chapter heading: ' + title);
      return pos;
    });
    assert.deepEqual(chapterPositions, [...chapterPositions].sort((a, b) => a - b));
    assert.ok(xml.includes('共收录 3 份会议记录') && xml.includes('覆盖 2 个团队'), 'cover reflects the same dated batch');

    const tables = [...xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map(table =>
      [...table[1].matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map(row =>
        [...row[1].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(cell => cell[1])
      )
    );
    function tableRows(headers) {
      const table = tables.find(rows => rows[0]?.join('|') === headers);
      assert.ok(table, 'missing native Word table: ' + headers);
      return table.slice(1);
    }
    assert.ok(tableRows('统计项|数值').some(row => row.join('|') === '会议记录总数|3份'));
    assert.deepEqual(tableRows('风险项|等级|影响范围'), [['遗漏的数据可能影响验收', '高', 'Alpha-Red']]);
    assert.deepEqual(tableRows('节点|时间|负责人/部门|状态'), [['复核样本', '5 月 20 日', 'Alpha-Red', '筹备中']]);
    assert.deepEqual(tableRows('团队|主要会议类型|文档数').map(row => [row[0], row[2]]), [['Alpha', '2份'], ['Beta', '1份']]);
    assert.ok(tableRows('统计项|数值|说明').some(row => row[0] === '文档纳入率' && row[1] === '100%'));
    const trends = paragraphs.slice(chapterPositions[0], chapterPositions[1]).filter(p => p.includes('<w:numPr>'));
    assert.equal(trends.length, 5, 'each trend is a separate native Word list item');
    for (const index of [1, 2]) {
      const section = paragraphs.slice(chapterPositions[index], chapterPositions[index + 1]);
      assert.ok(section.some(p => p.includes('<w:numPr>')), 'risk and follow-up bullets should survive Word rendering');
    }

    const chapter4 = paragraphs.slice(chapterPositions[3], chapterPositions[4]);
    for (const heading of ['会议统计', '核心议题', '关键决议']) {
      const matches = chapter4.filter(p => p.includes('>' + heading + '</w:t>'));
      assert.equal(matches.length, heading === '会议统计' ? 2 : 3);
      assert.ok(matches.every(p => p.includes('<w:b/>') && p.includes('<w:keepNext/>')));
    }
    const realList = chapter4.filter(p => /【Alpha-(Red|Blue)】|单来源会议讨论/.test(p));
    assert.equal(realList.length, 5);
    assert.ok(realList.every(p => p.includes('<w:numPr>')), 'render each item as a native Word list paragraph');
    const evaluations = paragraphs.slice(chapterPositions[4], chapterPositions[5]);
    const themeHeadings = evaluations.filter(p => /<w:t[^>]*>5\.[1-4] /.test(p));
    assert.equal(themeHeadings.length, 4);
    assert.ok(themeHeadings.every(p => p.includes('w:pStyle')));
    const grades = evaluations.filter(p => /(?:推进较好|推进一般|待加强)：/.test(p));
    assert.equal(grades.length, 6, 'emit exactly the evidence-backed grades, including themes with a single grade');
    for (const p of grades) {
      assert.ok(p.includes('<w:numPr>'), 'each thematic grade is a native Word list paragraph');
      const runs = p.match(/<w:r>([\s\S]*?)<\/w:r>/g);
      assert.match(runs[0], /<w:b\/>[\s\S]*?>(?:推进较好|推进一般|待加强)：<\/w:t>/);
      assert.ok(runs.length > 1 && !runs[1].includes('<w:b/>'), 'bold the label and preserve regular-weight evidence');
    }
    assert.ok(!xml.includes('**'));
    assert.match(xml, /agent/i);
    assert.ok(!xml.includes('未使用 LLM，使用规则回退生成'));

    runReport([], 75, '修订后的样本核验');
    assert.equal(promptFiles().filter(name => !teams.includes(name) && !comprehensive.includes(name)).length, 3,
      'changed evidence requires new answers even for the same date range');
    assert.deepEqual(fs.readFileSync(reportFile), completedReport, 'awaiting agent input must preserve completed reports');

    const configFile = path.join(project, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.llm.mode = 'api';
    fs.writeFileSync(configFile, JSON.stringify(config));
    const apiResponse = path.join(project, 'api-response.md');
    const fifth = detailed.indexOf('# 五、综合评估与建议');
    fs.writeFileSync(apiResponse, detailed.slice(0, fifth) + detailed.slice(fifth).replace(/^• .+$/gm, ''));
    assert.match(runReport([], 1, '', 'generate-comprehensive-report.js'), /综合报告格式不完整[：:]/);
    assert.deepEqual(fs.readFileSync(reportFile), completedReport, 'invalid complete API answers must preserve the previous Word');
    fs.writeFileSync(apiResponse, detailed.slice(0, fifth));
    runReport([], 0, '', 'generate-comprehensive-report.js');
    const partial = readStats('comprehensive-report-generation-stats.json');
    assert.equal(partial.mode, 'llm-with-rules-supplement');
    assert.deepEqual(partial.ruleFallbackSections, ['section5']);
    assert.equal(partial.rulesFallbackUsed, true);
  } finally {
    const target = fs.realpathSync(project);
    assert.equal(path.dirname(target), tempRoot);
    assert.ok(path.basename(target).startsWith('meeting-report-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}

if (require.main === module) {
  testApiModel().then(testAgentFlow).then(() => console.log('agent report flow tests passed')).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (process.env.MEETING_AGENT_TEST_PROJECT) {
  installFixture(process.env.MEETING_AGENT_TEST_PROJECT);
}
