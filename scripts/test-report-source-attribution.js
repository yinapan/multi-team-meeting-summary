const assert = require('assert');

const {
  analyzeDocs,
  buildTeamReportPrompt,
  formatSourceRef,
  withSourceRef,
  normalizeMultiSourceBulletPrefixes
} = require('./shared');

const today = new Date();
const currentMonthDay = `${today.getMonth() + 1}月${today.getDate()}日`;

const singleDoc = {
  name: '20260507-项目周会-会议记录.otl',
  conclusions: ['资源短缺风险需要重点跟进'],
  todos: [`${currentMonthDay} complete resource coordination`],
  rawContent: '',
  sourceLabel: null
};

assert.strictEqual(
  formatSourceRef('SEED', singleDoc),
  'SEED-20260507-项目周会-会议记录'
);

assert.strictEqual(
  formatSourceRef('经典剑侠系列', {
    name: '20260512-经典剑侠项目周例会.docx',
    sourceLabel: '大部门'
  }),
  '经典剑侠系列-大部门-20260512-经典剑侠项目周例会'
);

assert.strictEqual(
  formatSourceRef('剑网3系列', {
    name: '20260331-剧情表现会议-会议记录.docx',
    sourceLabel: '剑网3'
  }),
  '剑网3系列-剑网3-20260331-剧情表现会议-会议记录'
);

assert.strictEqual(
  withSourceRef('资源短缺风险需要重点跟进', 'SEED-20260507-项目周会-会议记录'),
  '资源短缺风险需要重点跟进（来源：SEED-20260507-项目周会-会议记录）'
);

const analysis = analyzeDocs([singleDoc], 'SEED');
assert.strictEqual(analysis.allConclusionItems[0].source, 'SEED-20260507-项目周会-会议记录');
assert.strictEqual(analysis.allTodoItems[0].source, 'SEED-20260507-项目周会-会议记录');
assert.strictEqual(analysis.highRisks[0].source, 'SEED-20260507-项目周会-会议记录');
assert.strictEqual(analysis.nearTermNodes[0].source, 'SEED-20260507-项目周会-会议记录');

const multiDoc = {
  name: '20260512-经典剑侠项目周例会.docx',
  conclusions: ['排期风险需要重点跟进'],
  todos: ['05月29日 complete schedule confirmation'],
  rawContent: '',
  sourceLabel: '大部门'
};
const multiAnalysis = analyzeDocs([multiDoc], '经典剑侠系列');
assert.strictEqual(multiAnalysis.allConclusionItems[0].source, '经典剑侠系列-大部门-20260512-经典剑侠项目周例会');
assert.strictEqual(multiAnalysis.highRisks[0].source, '经典剑侠系列-大部门-20260512-经典剑侠项目周例会');

const prompt = buildTeamReportPrompt({ documents: [multiDoc] }, multiAnalysis, '经典剑侠系列', {
  isMultiSource: true,
  reportLimits: { promptMinItems: 5, promptMaxItems: 12 }
});
assert(prompt.includes('经典剑侠系列-大部门-20260512-经典剑侠项目周例会'));

assert.strictEqual(
  normalizeMultiSourceBulletPrefixes(
    '• 【TeamA】GPU crash needs owner follow-up（来源：TeamA-Label1-20260403_engine_weekly）',
    ['TeamA']
  ),
  '• 【TeamA-Label1】GPU crash needs owner follow-up（来源：TeamA-Label1-20260403_engine_weekly）'
);

assert.strictEqual(
  normalizeMultiSourceBulletPrefixes(
    '• 【TeamA-Label1】GPU crash needs owner follow-up（来源：TeamA-Label1-20260403_engine_weekly）',
    ['TeamA']
  ),
  '• 【TeamA-Label1】GPU crash needs owner follow-up（来源：TeamA-Label1-20260403_engine_weekly）'
);

assert.strictEqual(
  normalizeMultiSourceBulletPrefixes(
    '• 【ProjectTitle-Weekly】GPU crash needs owner follow-up（来源：ProjectTitle-20260403_engine_weekly）',
    ['TeamA'],
    { expectedLabels: { TeamA: 'Label1' } }
  ),
  '• 【TeamA-Label1】GPU crash needs owner follow-up（来源：TeamA-Label1-ProjectTitle-20260403_engine_weekly）'
);

assert.strictEqual(
  normalizeMultiSourceBulletPrefixes(
    '• 【高】GPU crash remains unresolved（来源：ProjectTitle-20260403_engine_weekly）',
    ['TeamA'],
    { expectedLabels: { TeamA: 'Label1' } }
  ),
  '• 【TeamA-Label1】【高】GPU crash remains unresolved（来源：TeamA-Label1-ProjectTitle-20260403_engine_weekly）'
);

assert.strictEqual(
  normalizeMultiSourceBulletPrefixes(
    [
      '| 时间节点 | 责任方 | 关键事项 | 来源会议 |',
      '|---|---|---|---|',
      '| 08-10 | TeamA | Resolve GPU crash | FakeProject-FakeLabel-weekly |',
    ].join('\n'),
    ['TeamA'],
    { expectedLabels: { TeamA: 'Label1' } }
  ),
  [
    '| 时间节点 | 责任方 | 关键事项 | 来源会议 |',
    '|---|---|---|---|',
    '| 08-10 | TeamA | Resolve GPU crash | TeamA-Label1-FakeProject-FakeLabel-weekly |',
  ].join('\n')
);

assert.strictEqual(
  normalizeMultiSourceBulletPrefixes(
    [
      '| 时间节点 | 关键事项 | 来源会议 |',
      '|---|---|---|',
      '| 08-10 | Compare A \\| B | FakeProject-weekly |',
    ].join('\n'),
    ['TeamA'],
    { expectedLabels: { TeamA: 'Label1' } }
  ),
  [
    '| 时间节点 | 关键事项 | 来源会议 |',
    '|---|---|---|',
    '| 08-10 | Compare A \\| B | TeamA-Label1-FakeProject-weekly |',
  ].join('\n')
);

assert.strictEqual(
  normalizeMultiSourceBulletPrefixes(
    '• Already canonical（来源：TeamA-Label1）',
    ['TeamA'],
    { expectedLabels: { TeamA: 'Label1' } }
  ),
  '• 【TeamA-Label1】Already canonical（来源：TeamA-Label1）'
);

console.log('report source attribution tests passed');
