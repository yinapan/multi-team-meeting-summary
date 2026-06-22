const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  classifyImportantByParticipants,
  classifyImportantForCachedFile,
  buildImportantSetFromTeamSummaries,
  applyImportantRecordsToMap,
  scanImportantCandidateFiles,
  determineScanMode,
  parseKanbanDateRange,
  kanbanOutputName,
  buildKanbanDataFromTeamSummaries,
  mergeKanbanData,
  countMeetings,
  reconcileWithExistingKanban,
  pruneMeetingsWithoutConcreteDate,
  isImportantMeeting,
  generateHtml
} = require('./generate-kanban');
const {
  extractDateFromFileName,
  extractMeetingDate,
  getWeekKey,
  extractParticipants,
  normalizeTitle
} = require('./shared');

const redPeople = ['红印', '孙红印', '邹涛'];

assert.deepStrictEqual(
  parseKanbanDateRange(['0610', '0622']),
  {
    startDate: '06-10',
    endDate: '06-22',
    startLabel: '0610',
    endLabel: '0622'
  },
  'kanban should accept compact MMDD date range arguments'
);

assert.strictEqual(
  kanbanOutputName('浼氳鐪嬫澘.html', { startLabel: '0610', endLabel: '0622' }),
  '浼氳鐪嬫澘-0610-0622.html',
  'date-range kanban output should not overwrite the full kanban'
);

const rangeKanban = buildKanbanDataFromTeamSummaries([
  {
    team: 'RangeTeam',
    weeks: {
      '0608-0614': {
        meetings: [
          {
            title: '0610 Range Meeting',
            url: 'range-url',
            important: 'orange',
            meetingDate: { month: 6, day: 10 }
          }
        ]
      }
    }
  }
]);
assert.deepStrictEqual(Object.keys(rangeKanban.teams[0].weeks), ['0608-0614']);
assert.strictEqual(
  rangeKanban.teams[0].weeks['0608-0614'][0].text,
  `${new Date().getFullYear()}0610 - 0610 Range Meeting`,
  'date-range kanban should be built only from batch-read team summaries'
);
assert.strictEqual(rangeKanban.teams[0].weeks['0608-0614'][0].important, 'orange');

assert.strictEqual(
  classifyImportantByParticipants('张三、孙红印、李四', redPeople, '王五'),
  'red',
  'red important people should mark a meeting red'
);

assert.strictEqual(
  classifyImportantByParticipants('张三、王五、李四', redPeople, '王五'),
  'orange',
  'team leader participation should mark a meeting orange'
);

assert.strictEqual(
  classifyImportantByParticipants('张三、孙红印、王五', redPeople, '王五'),
  'red',
  'red important people should take priority over team leader orange'
);

assert.strictEqual(
  classifyImportantByParticipants('', redPeople, '王五'),
  false,
  'empty participant list should not be marked important'
);

assert.strictEqual(
  classifyImportantByParticipants('张三、李 明 俊、李四', redPeople, '李明俊'),
  'orange',
  'leader names should match even when spaces are inserted between characters'
);

assert.strictEqual(
  classifyImportantByParticipants('张三 李明俊 李四', redPeople, '李明俊'),
  'orange',
  'leader names should match when participant names are separated by spaces'
);

assert.strictEqual(
  classifyImportantByParticipants('张三、李明俊杰、李四', redPeople, '李明俊'),
  false,
  'leader names should not match as a substring inside a longer Chinese name'
);

assert.strictEqual(
  classifyImportantByParticipants('张三、李明 俊杰、李四', redPeople, '李明俊'),
  false,
  'leader names should not match when spaces belong to a different longer Chinese name'
);

assert.strictEqual(
  classifyImportantByParticipants('张三、李明俊等、李四', redPeople, '李明俊'),
  'orange',
  'leader names followed by common suffixes such as 等 should still match'
);

const summaries = [
  {
    team: '测试团队',
    weeks: {
      '0430-0503': {
        meetings: [
          {
            title: '20260501_红印发言复盘',
            url: 'url-title-only',
            participants: '张三、李四'
          },
          {
            title: '20260502_例会',
            url: 'url-red',
            participants: '张三、邹涛'
          },
          {
            title: '20260503_负责人会议',
            url: 'url-orange',
            participants: '张三、王五'
          }
        ]
      }
    }
  }
];

const importantMap = buildImportantSetFromTeamSummaries(summaries, redPeople, { 测试团队: '王五' });
assert.strictEqual(isImportantMeeting('url-title-only', '20260501_红印发言复盘', importantMap), false);
assert.strictEqual(isImportantMeeting('url-red', '20260502_例会', importantMap), 'red');
assert.strictEqual(isImportantMeeting('url-orange', '20260503_负责人会议', importantMap), 'orange');
assert.strictEqual(isImportantMeeting('', '20260503 负责人会议', importantMap), 'orange');

const legendHtml = generateHtml({ lastUpdate: '2026-05-18', teams: [] });
assert.ok(
  legendHtml.includes('<span class="legend-item meeting important">'),
  'red legend sample should reuse the red meeting card class'
);
assert.ok(
  legendHtml.includes('<span class="legend-item meeting important-orange">'),
  'orange legend sample should reuse the orange meeting card class'
);
assert.ok(
  legendHtml.includes('<span class="date matrix-date">05/08</span>'),
  'legend sample should include the same date column used by meeting rows'
);
assert.ok(
  legendHtml.includes('<span class="title-flag matrix-title-flag status-important">红色重要</span><span class="legend-note">公司领导参加</span>'),
  'red legend sample should not include a separator between flag and note'
);
assert.ok(
  legendHtml.includes('<span class="title-flag matrix-title-flag status-important-orange">橙色重要</span><span class="legend-note">一级部门负责人参加</span>'),
  'orange legend sample should not include a separator between flag and note'
);
assert.ok(
  !legendHtml.includes('<span class="title-flag status-important">红色重要</span><span class="title-separator">-</span><span class="legend-note">'),
  'red legend sample should remove the separator'
);
assert.ok(
  !legendHtml.includes('<span class="title-flag status-important-orange">橙色重要</span><span class="title-separator">-</span><span class="legend-note">'),
  'orange legend sample should remove the separator'
);
assert.ok(
  /\.legend-note\s*\{\s*color:\s*inherit;/.test(legendHtml),
  'legend note text should inherit red/orange meeting title color'
);
assert.ok(
  legendHtml.includes('<span class="date matrix-date">05/08</span>'),
  'legend date should use the same compact date class as table meetings'
);
assert.ok(
  legendHtml.includes('<span class="meeting-title matrix-meeting-title">'),
  'legend title should use the same compact title class as table meetings'
);
assert.ok(
  !legendHtml.includes('<button data-filter="important">重要</button>'),
  'filter toolbar should not render the aggregate important button'
);
assert.ok(
  legendHtml.includes('<button data-filter="red">红色重要</button>'),
  'filter toolbar should keep red important button'
);
assert.ok(
  legendHtml.includes('<button data-filter="orange">橙色重要</button>'),
  'filter toolbar should keep orange important button'
);
assert.ok(
  /--week-col-width:\s*340px;/.test(legendHtml),
  'week columns should have a stable minimum width to avoid squeezed meeting cards'
);
assert.ok(
  /table\s*\{\s*width:\s*max-content;\s*border-collapse:/.test(legendHtml),
  'table should use content width so few selected weeks do not stretch columns'
);
assert.ok(
  !/table\s*\{[^}]*min-width:\s*100%;/.test(legendHtml),
  'table should not force full viewport width when only a few weeks are visible'
);
assert.ok(
  /th:not\(:first-child\),\s*td:not\(:first-child\)\s*\{[^}]*min-width:\s*var\(--week-col-width\);/s.test(legendHtml),
  'week cells should use the stable week column width'
);
const crossYearHtml = generateHtml({
  lastUpdate: '2026-06-22',
  teams: [
    {
      name: '跨年测试',
      weeks: {
        '0615-0621': [{ text: '20260618 普通会议', url: '' }],
        '1229-0104': [{ text: '20260101 跨年会议', url: '' }],
        '0105-0111': [{ text: '20260105 年初会议', url: '' }]
      }
    }
  ]
});
assert.ok(
  crossYearHtml.indexOf('"1229-0104"') < crossYearHtml.indexOf('"0105-0111"'),
  'cross-year week should sort near January instead of after June'
);
assert.ok(
  crossYearHtml.includes('"1229-0104":{"label":"2025/12/29 - 2026/1/4"'),
  'cross-year week label should include years to avoid looking like December 2026'
);
assert.ok(
  /\.meeting\s*\{[^}]*grid-template-columns:\s*46px minmax\(0,\s*1fr\);/s.test(legendHtml),
  'meeting cards should reserve a fixed date column and leave room for titles'
);
assert.ok(
  /\.matrix-meeting-title\s*\{[^}]*font-size:\s*14px;/s.test(legendHtml),
  'table meeting titles should use a smaller font than the hero legend'
);
assert.ok(
  /\.matrix-title-flag\s*\{[^}]*font-size:\s*13px;/s.test(legendHtml),
  'table important flags should use a compact font size'
);
assert.ok(
  /\.matrix-date\s*\{[^}]*font-size:\s*13px;/s.test(legendHtml),
  'table meeting dates should use a compact font size'
);

assert.strictEqual(
  extractParticipants('## 【参会人员】\n\n张三、孙红印、李四  \n\n## 【会议记录】\n正文'),
  '张三、孙红印、李四',
  'participants should be extracted from the line after the section heading'
);

assert.strictEqual(
  extractParticipants('张三、孙红印、李四  \n## 【参会人员】\n\n## 【会议记录】\n正文'),
  '张三、孙红印、李四',
  'participants should be extracted from the line before the section heading'
);

assert.strictEqual(
  extractParticipants('参会人员：张三、孙红印、李四\n## 【会议记录】\n正文'),
  '张三、孙红印、李四',
  'participants should be extracted from the same line after a label'
);

assert.strictEqual(
  extractParticipants('• 参会⼈：张三、红印  \n• 纪要整理⼈：潘亚楠'),
  '张三、红印',
  'participants should support CJK compatibility person character'
);

assert.strictEqual(
  extractParticipants('张三、李四\n\n### 与会人员：\n\n王五、赵六\n\n### 会议记录\n正文'),
  '王五、赵六',
  'participants after the heading should take priority over unrelated previous text'
);

assert.strictEqual(
  extractParticipants('| 会议时间 | 2026-05-12 |\n| 参会人员 | 张三、李明俊、李四 |\n| 纪要整理人 | 小助手 |'),
  '张三、李明俊、李四',
  'participants should be extracted from markdown table cells'
);

assert.strictEqual(
  extractParticipants('### 出席者\n\n王五、赵六\n\n### 会议纪要\n正文'),
  '王五、赵六',
  'participants should support 出席者 headings'
);

assert.strictEqual(
  extractParticipants('### 参会人员\n\n### 会议时间\n2026-05-12\n### 会议记录\n正文'),
  '',
  'participants should not fall through to meeting time when the participant section is empty'
);

const currentYear = new Date().getFullYear();
const shortYear = String(currentYear).slice(-2);

assert.deepStrictEqual(
  extractDateFromFileName(`星砂岛${shortYear}0506例会.otl`),
  { month: 5, day: 6 },
  'two-digit YYMMDD dates in project filenames should be recognized'
);

assert.deepStrictEqual(
  extractDateFromFileName(`星砂岛项目${shortYear}.3.30例会-会议记录.otl`),
  { month: 3, day: 30 },
  'two-digit YY.M.D dates should be recognized'
);

assert.deepStrictEqual(
  extractDateFromFileName(`${currentYear}422 AI客服运研专项会 会议记录.otl`),
  { month: 4, day: 22 },
  'current-year YYYYMDD dates without leading month zero should be recognized'
);

assert.deepStrictEqual(
  extractDateFromFileName('5.11 周会与项目进度同步-会议记录.otl'),
  { month: 5, day: 11 },
  'M.D date prefixes should be recognized'
);

assert.deepStrictEqual(
  extractDateFromFileName('04-20会议纪要3D角色AI辅助制作阶段性分享讨论.docx'),
  { month: 4, day: 20 },
  'MM-DD date prefixes should be recognized'
);

assert.deepStrictEqual(
  extractDateFromFileName(`行政管理部-周报（${currentYear} 年 4 月 20 日 - 4 月 24 日）.otl`),
  { month: 4, day: 20 },
  'Chinese dates with spaces and a four-digit year should be recognized'
);

assert.strictEqual(
  extractDateFromFileName(`${currentYear}05智能客服一期 · 三方会议核对要点及分工.otl`),
  null,
  'year-month prefixes without a day should not be guessed as a concrete meeting date'
);

assert.deepStrictEqual(
  extractMeetingDate(
    '星砂岛复盘会.otl',
    `星砂岛复盘会\n## 【会议时间】\n${currentYear}-05-12 15:00 - 16:00\n## 【参会人员】\n高勇、张三`
  ),
  { month: 5, day: 12 },
  'files without a date in the name should fall back to the meeting time in document content'
);

assert.deepStrictEqual(
  extractMeetingDate(
    `${currentYear}05智能客服一期 · 三方会议核对要点及分工.otl`,
    `会议时间：${currentYear}年5月19日 10:00\n参会人员：李明俊、张三`
  ),
  { month: 5, day: 19 },
  'year-month filenames should only get a day from document content'
);

assert.deepStrictEqual(
  extractMeetingDate(
    '无日期项目会议.otl',
    `无日期项目会议\n## 【会议时间】\n5月19日 10:00\n## 【参会人员】\n李明俊、张三`
  ),
  { month: 5, day: 19 },
  'meeting time fallback should support month-day content without a year'
);

assert.strictEqual(
  extractMeetingDate(
    '无日期项目会议.otl',
    `项目会议\n## 【会议目标】\n明确版本计划\n## 【后续工作】\n1. ${currentYear}年5月19日前提交方案`
  ),
  null,
  'content fallback should not use arbitrary deadline dates as the meeting date'
);

assert.notStrictEqual(
  getWeekKey(`星砂岛${shortYear}0506例会.otl`),
  'unknown',
  'recognized two-digit year dates should be assigned to a week'
);

assert.notStrictEqual(
  getWeekKey(
    '星砂岛复盘会.otl',
    `会议时间：${currentYear}-05-12 15:00\n参会人员：高勇、张三`
  ),
  'unknown',
  'document content fallback dates should be assigned to a week'
);

assert.strictEqual(
  normalizeTitle(`星砂岛${shortYear}0506例会.otl`),
  `${currentYear}0506 - 星砂岛例会`,
  'normalized kanban titles should expose a YYYYMMDD prefix for YYMMDD files'
);

assert.strictEqual(
  normalizeTitle('星砂岛复盘会.otl', { month: 5, day: 12 }),
  `${currentYear}0512 - 星砂岛复盘会`,
  'normalized kanban titles should support an explicit date fallback from document content'
);

assert.strictEqual(
  normalizeTitle(`星砂岛项目${shortYear}.3.30例会-会议记录.otl`),
  `${currentYear}0330 - 星砂岛项目例会`,
  'normalized kanban titles should expose a YYYYMMDD prefix for YY.M.D files'
);

assert.strictEqual(determineScanMode([], true), 'incremental');
assert.strictEqual(determineScanMode(['--incremental'], true), 'incremental');
assert.strictEqual(determineScanMode(['--refresh'], true), 'full');
assert.strictEqual(determineScanMode([], false), 'full');

const merged = mergeKanbanData(
  {
    teams: [
      { name: 'A', weeks: { '0504-0510': [{ text: '20260508 - 新会议', url: 'new-url', important: false }] } }
    ],
    lastUpdate: '2026-05-13'
  },
  {
    teams: [
      { name: 'A', weeks: { '0427-0503': [{ text: '20260430 - 历史会议', url: 'old-url', important: false }] } },
      { name: 'B', weeks: { '0504-0510': [{ text: '20260506 - 其他团队', url: 'other-url', important: false }] } }
    ],
    lastUpdate: '2026-05-12'
  }
);
assert.strictEqual(merged.teams.length, 2);
assert.strictEqual(merged.teams.find(t => t.name === 'A').weeks['0504-0510'].length, 1);
assert.strictEqual(merged.teams.find(t => t.name === 'A').weeks['0427-0503'].length, 1);
assert.strictEqual(merged.teams.find(t => t.name === 'B').weeks['0504-0510'].length, 1);

const lowCoverageExisting = {
  teams: [
    {
      name: '星砂岛',
      weeks: {
        '0504-0510': [
          { text: '20260506 - 星砂岛例会', url: 'star-1' },
          { text: '20260507 - 星砂岛复盘', url: 'star-2' }
        ]
      }
    },
    {
      name: '质量中心',
      weeks: {
        '0504-0510': [{ text: '20260506 - 质量周会', url: 'qa-1' }]
      }
    }
  ],
  lastUpdate: '2026-05-18'
};
const lowCoverageScanned = {
  teams: [
    { name: '星砂岛', weeks: {} },
    {
      name: '质量中心',
      weeks: { '0504-0510': [{ text: '20260507 - 新质量会', url: 'qa-2' }] }
    }
  ],
  lastUpdate: '2026-05-19'
};
const guarded = reconcileWithExistingKanban(lowCoverageScanned, lowCoverageExisting);
assert.strictEqual(
  countMeetings(guarded),
  4,
  'coverage guard should preserve old meetings when a KDocs scan loses a team'
);
assert.strictEqual(
  guarded.teams.find(t => t.name === '星砂岛').weeks['0504-0510'].length,
  2,
  'coverage guard should restore teams scanned as empty'
);

const pruned = pruneMeetingsWithoutConcreteDate({
  teams: [
    {
      name: '运营发行中心',
      weeks: {
        '1201-1207': [
          { text: '202605智能客服一期 · 三方会议核对要点及分工', url: 'month-only' },
          { text: '202601-AI快速原型开发指南分享-会议记录', url: 'year-month-only' }
        ],
        '0126-0201': [
          { text: '20260126 - 摩尔线程大会精炼分享', url: 'concrete-date' }
        ],
        '1207-1213': [
          { text: `${currentYear}1213 - 20240414-游戏行业新闻周报AI生成工作流优化讨论`, url: 'future-misparsed' }
        ]
      }
    }
  ]
});
assert.strictEqual(
  pruned.teams[0].weeks['1201-1207'],
  undefined,
  'month-only titles should be pruned instead of staying in a fake December week'
);
assert.strictEqual(
  pruned.teams[0].weeks['0126-0201'].length,
  1,
  'concrete YYYYMMDD titles should not be pruned'
);
assert.strictEqual(
  pruned.teams[0].weeks['1207-1213'],
  undefined,
  'future dates produced by stale title parsing should be pruned'
);

const refreshedImportantMap = new Map([['stale-url', 'red']]);
applyImportantRecordsToMap(refreshedImportantMap, [
  {
    team: '质量中心',
    name: '20260430 - AI组周例会 - 会议记录.otl',
    url: 'fresh-url',
    content: '• 参会⼈：杨明邦、红印\n• 纪要整理⼈：潘亚楠'
  },
  {
    team: '质量中心',
    name: '20260429 - 普通会议.otl',
    url: 'stale-url',
    content: '• 参会人：杨明邦\n• 纪要整理人：潘亚楠'
  }
], redPeople, { 质量中心: '负责人' }, true);
assert.strictEqual(isImportantMeeting('fresh-url', '20260430 - AI组周例会 - 会议记录', refreshedImportantMap), 'red');
assert.strictEqual(isImportantMeeting('stale-url', '20260429 - 普通会议', refreshedImportantMap), false);

const cachedTeam = 'TestQualityImportant';
const cachedDir = path.join(__dirname, '..', 'cache', cachedTeam, 'docs');
fs.mkdirSync(cachedDir, { recursive: true });
fs.writeFileSync(
  path.join(cachedDir, 'cached-file.json'),
  JSON.stringify({
    mtime: 'm1',
    content: '参会人员：张三、TeamLeader、李四\n\n## 会议记录\n正文'
  }),
  'utf-8'
);
assert.strictEqual(
  classifyImportantForCachedFile(
    { name: cachedTeam },
    { id: 'cached-file', mtime: 'm1', name: '20260410 - weekly.otl', link: 'cache-url' },
    redPeople,
    { [cachedTeam]: 'TeamLeader' }
  ),
  'orange',
  'current doc cache should mark historical kanban meetings with team leader participation'
);

const strictImportantMap = new Map();
applyImportantRecordsToMap(strictImportantMap, [
  {
    team: cachedTeam,
    title: 'NPC资源需求与优化方案讨论',
    content: '参会人员：TeamLeader、张三、李四'
  }
], redPeople, { [cachedTeam]: 'TeamLeader' }, true);
assert.strictEqual(
  isImportantMeeting('https://www.kdocs.cn/l/cache-url', '20260429 - NPC资源需求与优化方案讨论', strictImportantMap),
  false,
  'important markers must not be generalized from stripped titles to different dated meetings'
);

applyImportantRecordsToMap(strictImportantMap, [
  {
    team: cachedTeam,
    title: '20260429 - NPC资源需求与优化方案讨论',
    url: 'https://www.kdocs.cn/l/cache-url',
    content: '参会人员：TeamLeader、张三、李四'
  }
], redPeople, { [cachedTeam]: 'TeamLeader' }, true);
assert.strictEqual(
  isImportantMeeting('https://www.kdocs.cn/l/cache-url', '20260429 - NPC资源需求与优化方案讨论', strictImportantMap),
  'orange',
  'important markers should apply when the same meeting is matched by url or full title'
);

applyImportantRecordsToMap(strictImportantMap, [
  {
    team: '质量中心',
    title: '20260430 - AI组周例会',
    url: 'https://www.kdocs.cn/l/important-ai-weekly',
    content: '参会人员：李爱华、张三'
  }
], redPeople, { 质量中心: '李爱华' }, true);
assert.strictEqual(
  isImportantMeeting('https://www.kdocs.cn/l/cfNsYtmh8F77', '20260515 - AI组周例会', strictImportantMap),
  false,
  'recurring weekly meetings must be marked only from their own participant list, not from another dated meeting'
);
fs.rmSync(path.join(__dirname, '..', 'cache', cachedTeam), { recursive: true, force: true });

async function runAsyncTests() {
  const scanCalls = [];
  const scanned = await scanImportantCandidateFiles(
    {
      name: '运营发行中心',
      drive_id: 'drive-1',
      months: { '4月': 'folder-1' }
    },
    null,
    {
      scanMode: 'hybrid',
      scanFilesByMode: async (entry, opts) => {
        scanCalls.push({ entry, opts });
        return {
          files: [
            { id: 'nested-file', name: '20260427-K2运营发行部周会-会议纪要.otl', mtime: 'm1', link: 'nested-url' }
          ],
          stats: { mergedCount: 1 }
        };
      }
    }
  );

  assert.strictEqual(scanned.length, 1);
  assert.strictEqual(scanCalls.length, 1);
  assert.strictEqual(scanCalls[0].opts.mode, 'hybrid');
  assert.strictEqual(scanCalls[0].opts.includeAll, true);
  assert.strictEqual(
    scanned[0].name,
    '20260427-K2运营发行部周会-会议纪要.otl',
    'important refresh should scan the same nested candidate files as the kanban scan'
  );
}

runAsyncTests()
  .then(() => console.log('kanban important marking tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
