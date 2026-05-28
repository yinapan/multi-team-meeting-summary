const assert = require('assert');

const {
  createMeetingBaseline,
  getBaselineFileName,
  getRiskImpactScope,
  classifyMeetingType,
  summarizePrimaryMeetingTypes,
  getKdocsCliArgs
} = require('./shared');

const teams = [
  {
    team: 'Alpha',
    totalScanned: 3,
    documents: [
      { name: '0511-Alpha技术专项会.otl', conclusions: ['性能风险需要处理'], todos: ['05-20完成'], rawContent: '正文' },
      { name: '0512-Alpha周会.otl', conclusions: [], todos: [], rawContent: '正文' }
    ]
  },
  {
    teamName: 'Beta',
    data: {
      documents: [
        { name: '0513-Beta法务培训会.otl', conclusions: ['版权风险复盘'], todos: [], rawContent: '正文' }
      ]
    }
  }
];

const baseline = createMeetingBaseline(teams, {
  startDate: '05-11',
  endDate: '05-24',
  source: 'unit-test',
  meetingListCount: 4
});

assert.strictEqual(getBaselineFileName('05-11', '05-24'), 'meeting-baseline-0511-0524.json');
assert.strictEqual(baseline.counts.meetingListCount, 4);
assert.strictEqual(baseline.counts.successfulReadCount, 3);
assert.strictEqual(baseline.counts.analyzedDocumentCount, 4);
assert.strictEqual(baseline.version, 2);
assert.strictEqual(baseline.teams[0].team, 'Alpha');
assert.strictEqual(baseline.teams[0].meetingListCount, 3);
assert.strictEqual(baseline.teams[0].successfulReadCount, 2);
assert.deepStrictEqual(baseline.unreadableMeetings, []);
assert.deepStrictEqual(baseline.excludedMeetings, []);

assert.strictEqual(getRiskImpactScope({ team: 'Alpha', label: 'ProjectA' }), 'Alpha-ProjectA');
assert.strictEqual(getRiskImpactScope({ team: 'Alpha' }), 'Alpha');

assert.strictEqual(classifyMeetingType('0511-Alpha技术专项会'), '技术专项会');
assert.strictEqual(classifyMeetingType('0513-Beta法务培训会'), '合规/培训会');
assert.strictEqual(summarizePrimaryMeetingTypes([
  { name: '0511-Alpha技术专项会' },
  { name: '0512-Alpha技术专项会' },
  { name: '0513-Alpha周会' }
]), '技术专项会(2)、项目周会(1)');

const kdocsArgs = getKdocsCliArgs(['drive', 'list-files']);
assert.strictEqual(kdocsArgs[0], '--token');
assert.strictEqual(kdocsArgs[2], 'drive');
assert.strictEqual(kdocsArgs[3], 'list-files');

console.log('baseline contract tests passed');
