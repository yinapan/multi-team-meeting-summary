const assert = require('assert');
const fs = require('fs');
const path = require('path');

const shared = require('./shared');

const prompt = shared.buildComprehensiveReportPrompt([], {
  startDate: '05-11',
  endDate: '05-24',
  grandTotalDocs: 0,
  teamCount: 0
});

assert(prompt.includes('公司层级信息贯通'), 'prompt should require company-level trend synthesis');
assert(prompt.includes('风险项、等级、影响范围'), 'risk matrix should use the 3-column template');
const riskPrompt = prompt.slice(prompt.indexOf('## 2.3'), prompt.indexOf('## 3.1', prompt.indexOf('## 2.3')));
assert(!riskPrompt.includes('| 量化影响 |'), 'risk matrix prompt should not require quantified impact column');
assert(!riskPrompt.includes('| 来源会议 |'), 'risk matrix prompt should not require source meeting column');

const source = fs.readFileSync(path.join(__dirname, 'generate-comprehensive-report.js'), 'utf-8');
assert(source.includes('meeting-baseline'), 'comprehensive report should read/write a shared meeting baseline');
assert(source.includes('summarizePrimaryMeetingTypes'), 'appendix should use shared meeting type summary');
assert(source.includes('buildAppendixMeetingRows'), 'appendix should emit meeting list details from the shared analyzed data');
assert(source.includes('sortTeamsByDocumentCount'), 'appendix team summary should be sorted by analyzed document count');
assert(source.includes('classifyMeetingType'), 'appendix meeting details should use the shared meeting type classifier');
const fallbackRiskSource = source.slice(source.indexOf('elements.push(h2("2.3'), source.indexOf('// 三、', source.indexOf('elements.push(h2("2.3')));
assert(!fallbackRiskSource.includes('来源会议'), 'fallback risk matrix should not emit source meeting column');

console.log('comprehensive report contract tests passed');
