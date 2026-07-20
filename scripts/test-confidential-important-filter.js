const assert = require('assert');

const {
  analyzeDocs,
  buildComprehensiveReportPrompt,
  buildTeamReportPrompt,
  createMeetingBaseline,
  extractInfo,
  filterAnalyzableMeetings,
  isConfidentialMeetingTitle,
  isImportantMeetingTitle,
  sortImportantMeetingsFirst
} = require('./shared');

const confidentialDoc = {
  name: '20260512-【保密】薪酬调整会议.otl',
  conclusions: ['保密事项不得外传'],
  todos: ['保密待办不得进入报告'],
  rawContent: '保密正文'
};
const normalDoc = {
  name: '20260513-项目周会.otl',
  conclusions: ['普通事项需要继续推进'],
  todos: ['05月20日完成普通事项'],
  rawContent: '普通正文'
};
const importantDoc = {
  name: '20260514-【重要】版本风险评审.otl',
  conclusions: ['版本风险需要重点跟进'],
  todos: ['05月21日完成风险收敛'],
  rawContent: '重要正文'
};

assert.strictEqual(isConfidentialMeetingTitle(confidentialDoc.name), true);
assert.strictEqual(isImportantMeetingTitle(importantDoc.name), true);
assert.strictEqual(isImportantMeetingTitle('20260514-重要但无标记.otl'), false);

const extracted = extractInfo(
  '参会人员：张三、李四\n结论1：版本风险需要重点跟进',
  importantDoc.name,
  []
);
const reportExtracted = {
  ...extracted,
  important: extracted.important || isImportantMeetingTitle(importantDoc.name)
};
assert.strictEqual(reportExtracted.important, true, 'report flow should mark title-tagged meetings as important');

const analyzable = filterAnalyzableMeetings([confidentialDoc, normalDoc, importantDoc]);
assert.deepStrictEqual(
  analyzable.map(doc => doc.name),
  [normalDoc.name, importantDoc.name],
  'confidential meetings should be excluded before analysis'
);

const ordered = sortImportantMeetingsFirst([normalDoc, importantDoc]);
assert.deepStrictEqual(
  ordered.map(doc => doc.name),
  [importantDoc.name, normalDoc.name],
  'important meetings should be prioritized for extraction and summarization'
);

const baseline = createMeetingBaseline([{
  team: 'Alpha',
  meetingListItems: [confidentialDoc, normalDoc, importantDoc],
  documents: [confidentialDoc, normalDoc, importantDoc]
}], { applyMeetingTitleFilters: true });
assert.strictEqual(baseline.counts.meetingListCount, 2);
assert.strictEqual(baseline.counts.analyzedDocumentCount, 2);
assert.deepStrictEqual(baseline.teams[0].documentNames, [normalDoc.name, importantDoc.name]);

const analysis = analyzeDocs(filterAnalyzableMeetings([confidentialDoc, importantDoc]), 'Alpha');
assert.strictEqual(analysis.importantCount, 1);
assert(!analysis.allConclusionItems.some(item => item.text.includes('保密')));

const prompt = buildTeamReportPrompt(
  { documents: sortImportantMeetingsFirst(filterAnalyzableMeetings([confidentialDoc, normalDoc, importantDoc])) },
  analyzeDocs(filterAnalyzableMeetings([normalDoc, importantDoc]), 'Alpha'),
  'Alpha',
  { startDate: '05-12', endDate: '05-24' }
);
assert(!prompt.includes('薪酬调整会议'));
assert(prompt.indexOf('版本风险评审') < prompt.indexOf('项目周会'));

const comprehensivePrompt = buildComprehensiveReportPrompt([{
  teamName: 'Alpha',
  data: { documents: [normalDoc, importantDoc] },
  analysis: analyzeDocs([normalDoc, importantDoc], 'Alpha')
}], {
  startDate: '05-12',
  endDate: '05-24',
  grandTotalDocs: 2,
  teamCount: 1,
  teamSummaries: {
    Alpha: 'normal summary without enough detail'
  }
});
assert(
  comprehensivePrompt.includes('IMPORTANT MEETING PRIORITY'),
  'comprehensive prompt should include an explicit important meeting priority rule'
);
assert(
  comprehensivePrompt.includes('IMPORTANT MEETING DIGEST'),
  'comprehensive prompt should include a separate important meeting digest even when team summaries are compacted'
);
assert(
  comprehensivePrompt.indexOf(importantDoc.conclusions[0]) < comprehensivePrompt.indexOf('normal summary without enough detail'),
  'important meeting content should be injected before compacted team summaries'
);

console.log('confidential and important filter tests passed');
