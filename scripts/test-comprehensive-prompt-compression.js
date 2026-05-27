const assert = require('assert');

const {
  compactTeamSummariesForComprehensive,
  buildComprehensiveReportPrompt,
} = require('./shared');

const longFiller = Array.from({ length: 120 }, (_, i) =>
  `普通过程描述 ${i}: 这里是冗长的背景说明，用于模拟团队摘要中对综合分析价值较低的细节。`
).join('\n');

const teamSummaries = {
  Alpha: [
    '# 一、执行摘要',
    '• 【Alpha】版本推进稳定，关键节点保持按计划推进。（来源：Alpha-周会）',
    longFiller,
    '# 二、风险点分析',
    '• 【高】Alpha 外网性能风险需要继续压测。（来源：Alpha-性能专项）',
    '# 三、重点关注节点',
    '| 05-20 | Alpha | 完成压测复盘 | Alpha-性能专项 |',
    '# 五、综合评估与建议',
    '• 建议保留性能专项每日同步，直到外网压测风险关闭。',
  ].join('\n'),
  Beta: [
    '# 一、执行摘要',
    '• 【Beta】发行素材交付进入集中验收阶段。（来源：Beta-发行周会）',
    longFiller,
    '# 二、风险点分析',
    '• 【中】Beta 素材审核排期存在挤压。（来源：Beta-发行周会）',
  ].join('\n'),
};

const compacted = compactTeamSummariesForComprehensive(teamSummaries, {
  maxCharsPerTeam: 900,
});

assert(Object.keys(compacted).length === 2, 'keeps all team keys');
assert(compacted.Alpha.length < teamSummaries.Alpha.length / 2, 'compresses long summaries');
assert(compacted.Alpha.includes('外网性能风险'), 'keeps high risk content');
assert(compacted.Alpha.includes('05-20'), 'keeps timeline content');
assert(compacted.Alpha.includes('建议保留性能专项'), 'keeps recommendation content');
assert(!compacted.Alpha.includes('普通过程描述 100'), 'drops low-value filler');

const teamDataList = [
  { teamName: 'Alpha', data: { documents: [{ name: 'Alpha-周会' }] }, analysis: {} },
  { teamName: 'Beta', data: { documents: [{ name: 'Beta-发行周会' }] }, analysis: {} },
];

const fullPrompt = buildComprehensiveReportPrompt(teamDataList, {
  startDate: '04-30',
  endDate: '05-09',
  grandTotalDocs: 2,
  teamCount: 2,
  teamSummaries,
  compactTeamSummaries: false,
});

const compactPrompt = buildComprehensiveReportPrompt(teamDataList, {
  startDate: '04-30',
  endDate: '05-09',
  grandTotalDocs: 2,
  teamCount: 2,
  teamSummaries,
  compactTeamSummaries: true,
  maxTeamSummaryChars: 900,
});

assert(compactPrompt.length < fullPrompt.length * 0.65, 'prompt is significantly smaller');
assert(compactPrompt.includes('外网性能风险'), 'compact prompt keeps key risk');
assert(compactPrompt.includes('素材审核排期'), 'compact prompt keeps another team risk');

console.log('test-comprehensive-prompt-compression: ok');
