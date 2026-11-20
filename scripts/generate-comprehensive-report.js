const fs = require('fs');
const path = require('path');
const { reportMode, teamSummaryPath } = require('./report-agent');
const {
  C, FONT, hCell, cCell, bullet, h1, h2, h3, p, pb,
  makeHeader, makeFooter, makeCoverPage,
  cleanText, isValidConclusion, makeSuggestion, textSimilar, dedupTexts, analyzeDocs,
  generateStrategicAnalysis, callLLM, buildComprehensiveReportPrompt, parseReportMarkdown,
  formatSourceRef, withSourceRef, normalizeMultiSourceBulletPrefixes,
  compactTeamSummariesForComprehensive, summarizeTeamSummaryCompression,
  docStyles, docNumbering, resolveWorkspaceDir, outputPath, findInputFile, writeOutputJson, normalizeDate, formatDateChinese, dateInRange, meetingDateInRange,
  extractMeetingDate, readMeetingBaseline, writeMeetingBaseline, getRiskImpactScope, classifyMeetingType, summarizePrimaryMeetingTypes,
  formatGenerationMode, printAiReviewWarning,
  isMultiSourceTeam, getMultiSourceTeamNames, groupByLabel,
  filterAnalyzableMeetings, isImportantMeetingTitle, sortImportantMeetingsFirst,
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, PageNumber
} = require('./shared');

function getReportLimits(config = {}) {
  const report = config.report || {};
  return {
    perDocumentItemLimit: Number(report.perDocumentItemLimit) || 5,
    sectionItemLimit: Number(report.sectionItemLimit) || 12,
    multiSourceSectionItemLimit: Number(report.multiSourceSectionItemLimit) || 10,
    promptMinItems: Number(report.promptMinItems) || 5,
    promptMaxItems: Number(report.promptMaxItems) || 12
  };
}

function isMultiSource(td, multiSourceSet) {
  if (!multiSourceSet.has(td.teamName)) return false;
  const labels = new Set(td.data.documents.map(d => d.sourceLabel).filter(Boolean));
  return labels.size > 1;
}

function teamDocCount(td) {
  return ((td && td.data && td.data.documents) || []).length;
}

function sections(text, level) {
  const heading = new RegExp('^#{' + level + '}[ \\t]+([^\\n]+)$', 'gm');
  const matches = [...text.matchAll(heading)];
  return matches.map((match, i) => ({
    title: match[1].trim(),
    body: text.slice(match.index + match[0].length, matches[i + 1]?.index).trim()
  }));
}

// Compute the statistics from the same records and list items shown in the report.
function formatTeamSections(body, teamDataList, multiSourceSet, pending) {
  function requireHeadings(blocks, names, scope) {
    const found = new Set(blocks.map(block => block.title));
    if (blocks.length !== names.length || names.some(name => !found.has(name))) {
      throw pending(`${scope}应分别包含以下小节：${names.join('、')}。`);
    }
  }

  function countDetails(blocks, scope, prefix = '') {
    requireHeadings(blocks, ['核心议题', '关键决议'], scope);
    if (blocks[0].title !== '核心议题') throw pending(`${scope}请先写核心议题，再写关键决议。`);
    return blocks.map(({ title, body }) => {
      const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
      if (lines.length === 1 && !/^[•*\-#]/.test(lines[0]) &&
          /未记录|未形成|未明确|未发现|未列出|未提及|暂无|无明确|数据不足|^无[。.]?$/.test(lines[0])) return 0;
      const listed = lines.length && lines.every(line => {
        const item = line.match(/^(?:[•*\-]|\d+[.、])\s+(\S.*)$/);
        return item && item[1].startsWith(prefix) && item[1].length > prefix.length;
      });
      if (!listed) throw pending(`${scope}的“${title}”须逐条使用项目符号${prefix ? '并带 ' + prefix + ' 前缀' : ''}；缺少依据时写明本期纪要未记录该项。`);
      return lines.length;
    });
  }

  const teams = sections(body, 2);
  const entries = new Map(teamDataList.map(td => [td.teamName, td]));
  requireHeadings(teams, [...entries.keys()], '第四章');
  const formatted = teams.map(({ title: team, body }) => {
    const { data, analysis } = entries.get(team);
    const [stats, ...details] = sections(body, 3);
    if (stats?.title !== '会议统计') throw pending(`${team}应以“### 会议统计”开始。`);
    let counts;
    if (multiSourceSet.has(team)) {
      const labels = [...groupByLabel(data.documents, team).keys()];
      requireHeadings(details, labels, team);
      counts = [0, 0];
      for (const source of details) {
        const prefix = `【${team}-${source.title}】`;
        const [topics, decisions] = countDetails(sections(source.body, 4), prefix, prefix);
        counts[0] += topics;
        counts[1] += decisions;
      }
    } else {
      counts = countDetails(details, team);
    }
    const statsText = `本期共 ${data.documents.length} 场会议，其中 ${analysis.importantCount} 场为重要会议。下文汇总 ${counts[0]} 项核心议题、${counts[1]} 项关键决议。`;
    return [`## ${team}`, '### 会议统计', statsText, ...details.map(block => `### ${block.title}\n\n${block.body}`)].join('\n\n');
  });
  return formatted.join('\n\n');
}

const CHAPTER_TITLES = ['二、风险点分析', '三、重点关注节点', '四、各团队会议汇总', '五、综合评估与建议'];
const GRADE_LABELS = ['推进较好', '推进一般', '待加强'];
const NODE_STATUSES = ['冲刺中', '筹备中', '开发中', '制作中', '推进中', '已过审', '已执行', '加急中'];

function bodyLines(text) {
  return text.split('\n').map(line => line.trim()).filter(Boolean);
}

function evidenceNote(line) {
  return !!line && !line.includes('\n') && /^(?:本期|本月内|未来两个月|本月|本章|本节|该主题|本主题)?(?:会议纪要|会议记录|会议|纪要|资料|数据|证据|材料|记录|依据)?(?:中|内)?(?:尚|均|仍)?(?:不足|有限|暂无|无法(?:判断|评估|分级|归纳|分析)|未(?:记录|发现|确认|明确|列出|形成|提及|识别)|(?:没有|无)(?:明确|足够|可列入|可供|已分级)|无[。.]?$)/.test(line);
}

function listItems(text, scope, fail) {
  if (evidenceNote(text.trim())) return [];
  const lines = bodyLines(text);
  const items = lines.map(line => /^(?:[•*-]|\d+[.、])\s+(\S.*)$/.exec(line)?.[1]);
  if (!items.length || items.some(item => !item)) throw fail(scope + '应逐条使用项目符号；资料不足请单独说明。');
  return items;
}

function tableRows(block, headers, fail) {
  const lines = block.body.trim().split('\n').map(line => line.trim());
  const cells = lines.map(line => /^\|.*\|$/.test(line) ? line.slice(1, -1).split('|').map(value => value.trim()) : []);
  if (lines.length < 3 || cells.some(row => row.length !== headers.length || row.some(value => !value)) ||
      headers.some((header, i) => header !== cells[0][i]) || cells[1].some(value => !/^:?-{3,}:?$/.test(value))) {
    throw fail(block.title + '需要有表头、分隔线和数据行的表格，列为“' + headers.join('、') + '”。');
  }
  return cells.slice(2);
}

function isParagraph(text) {
  return !!text && bodyLines(text).every(line => !/^(?:[#|•*-]|\d+[.、]\s)/.test(line));
}

function numberedSections(chapter, titles, fail) {
  if (!isParagraph(chapter.body.split(/^##\s/m, 1)[0].trim())) throw fail(chapter.title + '应先写概述段落。');
  const blocks = sections(chapter.body, 2);
  if (blocks.length !== titles.length || titles.some((title, i) => blocks[i].title !== title)) {
    throw fail(chapter.title + '应依次包含“' + titles.join('”“') + '”。');
  }
  return blocks;
}

function validateRisks(chapter, teamDataList, sourceNames, fail) {
  const [high, mid, matrix] = numberedSections(chapter, ['2.1 高风险事项', '2.2 中风险事项', '2.3 风险矩阵'], fail);
  const risks = new Map();
  for (const [block, level] of [[high, '高'], [mid, '中']]) {
    const items = listItems(block.body, block.title, fail);
    if (items.some(item => !item.startsWith('【' + level + '】') || !item.slice(3).trim() || /\*\*/.test(item))) {
      throw fail(block.title + '的每个条目应以【' + level + '】开头，随后直接写风险。');
    }
    risks.set(level, items);
  }
  if (!risks.get('高').length && !risks.get('中').length && evidenceNote(matrix.body)) return;
  const documents = teamDataList.flatMap(td => td.data.documents.map(doc =>
    [td.teamName, doc.sourceLabel, doc.name, ...(doc.conclusions || []), ...(doc.todos || []), doc.rawContent].join('\n').replace(/\s+/g, '')
  ));
  for (const [name, level, scope] of tableRows(matrix, ['风险项', '等级', '影响范围'], fail)) {
    const normalized = name.replace(/\s/g, '');
    if (!risks.get(level)?.some(item => item.replace(/\s/g, '').includes(normalized))) {
      throw fail('2.3 风险矩阵中的“' + name + '”应使用2.1或2.2同等级条目中的风险简名。');
    }
    for (const department of scope.split(/[、,，]/).map(value => value.trim())) {
      if (!department || /^(?:[-—/]|无|未知|未明确|待定|待确认)$/.test(department) ||
          (!sourceNames.has(department) && !documents.some(text => text.includes(department.replace(/\s+/g, ''))))) {
        throw fail('2.3 风险矩阵的影响范围应使用本期部门或会议材料中的项目名称：' + scope);
      }
    }
  }
}

function validateMilestones(chapter, teamNames, sourceNames, fail) {
  const blocks = numberedSections(chapter, ['3.1 近期节点（本月内）', '3.2 中期节点（未来两个月）', '3.3 持续跟进事项'], fail);
  for (const block of blocks.slice(0, 2)) {
    if (evidenceNote(block.body)) continue;
    for (const [, , owner, status] of tableRows(block, ['节点', '时间', '负责人/部门', '状态'], fail)) {
      const owners = owner.split(/[、,，]/).map(name => name.trim());
      if (owners.some(name => !teamNames.has(name) && !sourceNames.has(name))) throw fail(block.title + '的负责人/部门必须是本期团队或团队-来源：' + owner);
      if (!NODE_STATUSES.includes(status)) throw fail(block.title + '的状态“' + status + '”不在可选范围：' + NODE_STATUSES.join('、'));
    }
  }
  for (const item of listItems(blocks[2].body, blocks[2].title, fail)) {
    const match = /^【([^】]+)】\s*\S/.exec(item);
    if (!match || !sourceNames.has(match[1])) throw fail('3.3 持续跟进事项应以实际【团队】或多来源【团队-来源】开头。');
  }
}

function validateAssessments(chapter, teamNames, sourceNames, fail) {
  const blocks = sections(chapter.body, 2);
  const note = chapter.body.split(/^##\s/m, 1)[0].trim();
  if (note && !evidenceNote(note)) throw fail('第五章应按5.1起的战略主题撰写。');
  if (blocks.length > 5 || (blocks.length < 4 && !evidenceNote(note))) throw fail('第五章应包含4至5个战略主题；材料不足时说明原因。');
  const titles = new Set();
  blocks.forEach((block, i) => {
    const title = /^5\.(\d+)\s+(.+)$/.exec(block.title);
    if (!title || Number(title[1]) !== i + 1 || titles.has(title[2]) || teamNames.has(title[2]) || sourceNames.has(title[2])) {
      throw fail('第五章主题应按5.1起连续编号，各使用一个独立的战略主题标题：' + block.title);
    }
    titles.add(title[2]);
    if (evidenceNote(block.body)) return;
    const lines = bodyLines(block.body);
    if (!isParagraph(lines[0])) throw fail(block.title + '须先写事实概述，再逐项评估进展。');
    if (lines.length === 2 && evidenceNote(lines[1])) return;
    let lastGrade = -1;
    for (const [index, line] of lines.slice(1).entries()) {
      if (index === lines.length - 2 && lastGrade >= 0 && /^(?:\*\*建议[：:]?\*\*[：:]?|建议[：:])\s*\S/.test(line)) continue;
      const grade = /^[•*-]\s+\*\*(推进较好|推进一般|待加强)(?:\*\*[：:]|[：:]\*\*)\s*(.+)$/.exec(line);
      if (!grade || GRADE_LABELS.indexOf(grade[1]) <= lastGrade) throw fail(block.title + '应按序分列有依据的“推进较好、推进一般、待加强”，使用加粗标签和项目符号。');
      const evidence = grade[2].trim();
      const owner = [...sourceNames].find(name => evidence.includes(name));
      if (!owner || !/[\p{L}\p{N}]/u.test(evidence.replace(owner, ''))) throw fail(block.title + '“' + grade[1] + '”须写明本期团队或团队-来源及其事实依据。');
      lastGrade = GRADE_LABELS.indexOf(grade[1]);
    }
    if (lastGrade < 0) throw fail(block.title + '缺少有事实支持的推进分级；证据不足须明确说明。');
  });
}

function formatComprehensiveAnalysis(markdown, teamDataList, multiSourceSet, fail, allowMissingTail = false) {
  const normalized = markdown.trim().replace(/\r\n/g, '\n');
  const chapters = sections(normalized, 1);
  const count = chapters.length;
  if ((allowMissingTail ? count < 2 || count > 4 : count !== 4) ||
      chapters.some((chapter, i) => chapter.title !== CHAPTER_TITLES[i])) {
    throw fail('综合报告应从“1.2 主要趋势”起，按顺序使用第二至第五章的原定标题。');
  }
  if (chapters[2]) chapters[2].body = formatTeamSections(chapters[2].body, teamDataList, multiSourceSet, fail);
  const intro = normalized.split(/^#\s/m, 1)[0].trim();
  const trends = sections(intro, 2);
  if (trends.length !== 1 || trends[0].title !== '1.2 主要趋势' || !intro.startsWith('## ')) throw fail('第一章分析必须从“## 1.2 主要趋势”开始。');
  const lines = bodyLines(trends[0].body);
  const notes = lines.filter(evidenceNote);
  const trendItems = listItems(lines.filter(line => !evidenceNote(line)).join('\n') || notes[0] || '', '1.2 主要趋势', fail);
  if (trendItems.length > 6 || (trendItems.length < 5 && !notes.length)) throw fail('1.2 主要趋势应分列5–6项，材料不足时说明原因。');
  const teamNames = new Set(teamDataList.map(td => td.teamName));
  const sourceNames = new Set();
  for (const { teamName, data } of teamDataList) {
    if (!multiSourceSet.has(teamName)) sourceNames.add(teamName);
    else for (const label of groupByLabel(data.documents, teamName).keys()) sourceNames.add(teamName + '-' + label);
  }
  for (const match of normalized.matchAll(/【([^】\n]+)】/g)) {
    const label = match[1];
    if ([...multiSourceSet].some(team => label === team || label.startsWith(team + '-')) && !sourceNames.has(label)) {
      throw fail('多来源标记【' + label + '】应使用本期实际的【团队-来源】。');
    }
  }
  validateRisks(chapters[0], teamDataList, sourceNames, fail);
  validateMilestones(chapters[1], teamNames, sourceNames, fail);
  if (chapters[3]) validateAssessments(chapters[3], teamNames, sourceNames, fail);
  return [intro, ...chapters.map(chapter => '# ' + chapter.title + '\n\n' + chapter.body)].join('\n\n') + '\n';
}

function sortTeamsByDocumentCount(teamDataList) {
  return [...(teamDataList || [])].sort((a, b) =>
    teamDocCount(b) - teamDocCount(a) || String(a.teamName || '').localeCompare(String(b.teamName || ''), 'zh-Hans-CN')
  );
}

function stripDocExt(name) {
  return String(name || '').replace(/\.(\w+)$/i, '');
}

function buildInclusionNote(reportCounts, baseline) {
  const unreadableCount = reportCounts.meetingListCount - reportCounts.analyzedDocumentCount;
  if (unreadableCount <= 0) return [];
  const unreadableExts = new Set();
  for (const t of (baseline && baseline.teams || [])) {
    for (const m of (t.unreadableMeetings || [])) {
      const ext = (m.name || '').match(/\.(\w+)$/i);
      if (ext) unreadableExts.add(ext[1].toLowerCase());
      else unreadableExts.add('无后缀');
    }
  }
  const extList = [...unreadableExts].join('、');
  return [
    new Paragraph({ spacing: { before: 300 }, children: [
      new TextRun({ text: "说明：", bold: true, size: 20, font: FONT }),
      new TextRun({ text: `"会议清单数"为扫描到的全部会议条目；"成功读取数"为成功提取正文内容的文档；"纳入分析数"为最终进入报告分析的文档总数。本次有 ${unreadableCount} 份文档（${extList} 格式）无法通过文本接口读取正文，故纳入分析数低于会议清单数，但不影响其在清单中的收录。`, size: 20, font: FONT, color: C.gray })
    ]})
  ];
}

// ========== 跨团队风险去重 ==========
function dedupRisks(risks) {
  const result = [];
  for (const r of risks) {
    const isDup = result.some(existing => {
      if (existing.text === r.text) return true;
      if (existing.text.substring(0, 20) === r.text.substring(0, 20)) return true;
      return false;
    });
    if (!isDup) result.push(r);
  }
  return result;
}

function firstAnalysisSource(analysis) {
  const item = (analysis.allConclusionItems || [])[0] || (analysis.allTodoItems || [])[0] || {};
  return item.source || '';
}

function sourcedItemText(item) {
  if (typeof item === 'string') return item;
  return withSourceRef(item.text, item.source);
}

function plainItemText(item) {
  return typeof item === 'string' ? item : (item && item.text) || '';
}

function makeRiskMatrixRows(highRisks, midRisks, highLimit = 8, midLimit = 5) {
  return [
    ...(highRisks || []).slice(0, highLimit).map(r => ({
      text: String(r.text || '').substring(0, 60),
      level: '高',
      scope: getRiskImpactScope(r)
    })),
    ...(midRisks || []).slice(0, midLimit).map(r => ({
      text: String(r.text || '').substring(0, 60),
      level: '中',
      scope: getRiskImpactScope(r)
    }))
  ];
}

function baselineCountsForReport(baseline, fallback) {
  const counts = (baseline && baseline.counts) || {};
  return {
    meetingListCount: Number(counts.meetingListCount) || fallback.meetingListCount || fallback.analyzedDocumentCount || 0,
    successfulReadCount: Number(counts.successfulReadCount) || fallback.successfulReadCount || fallback.analyzedDocumentCount || 0,
    analyzedDocumentCount: Number(counts.analyzedDocumentCount) || fallback.analyzedDocumentCount || 0
  };
}

// ========== 规则回退：生成 1.2-5 章节 ==========
function buildFallbackContent(teamDataList, allHighRisks, allMidRisks, opts) {
  const { grandTotalDocs, multiSourceSet, reportLimits = getReportLimits() } = opts;
  const elements = [];

  // 1.2 主要趋势
  elements.push(h2("1.2 主要趋势"));
  const trendItems = [];
  teamDataList.forEach(td => {
    if (isMultiSource(td, multiSourceSet)) {
      const groups = groupByLabel(td.data.documents, td.teamName);
      for (const [label, docs] of groups) {
        const labelAnalysis = analyzeDocs(docs, td.teamName, { ...opts, label });
        for (const t of (labelAnalysis.trends || []).slice(0, 2)) {
          trendItems.push({ team: `${td.teamName}-${label}`, text: withSourceRef(t, firstAnalysisSource(labelAnalysis)) });
        }
      }
    } else {
      for (const t of (td.analysis.trends || []).slice(0, 3)) {
        trendItems.push({ team: td.teamName, text: withSourceRef(t, firstAnalysisSource(td.analysis)) });
      }
    }
  });
  const seen = new Set();
  const dedupedTrends = trendItems.filter(it => {
    const key = it.text.substring(0, 20);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (dedupedTrends.length > 0) {
    dedupedTrends.slice(0, 8).forEach(it => elements.push(bullet(it.text, { bold: `【${it.team}】` })));
  } else {
    teamDataList.flatMap(td => (td.analysis.allConclusionItems || []).slice(0, 3)).slice(0, 5).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220))));
  }

  // 二、风险点分析
  elements.push(pb(), h2("二、风险点分析"));
  elements.push(p("基于本期会议记录的综合分析，识别出以下需要重点关注的风险点："));
  elements.push(h3("2.1 高风险事项"));
  if (allHighRisks.length > 0) {
    allHighRisks.slice(0, 10).forEach(r => {
      const prefix = r.label ? `${r.team}-${r.label}` : r.team;
      elements.push(bullet(`${prefix}${withSourceRef(r.text, r.source)}`, { bold: '【高】' }));
    });
  } else {
    elements.push(p("本期会议记录中未发现高风险事项。", { color: C.gray }));
  }
  elements.push(h3("2.2 中风险事项"));
  if (allMidRisks.length > 0) {
    allMidRisks.slice(0, 10).forEach(r => {
      const prefix = r.label ? `${r.team}-${r.label}` : r.team;
      elements.push(bullet(`${prefix}${withSourceRef(r.text, r.source)}`, { bold: '【中】' }));
    });
  } else {
    elements.push(p("本期会议记录中未发现中风险事项。", { color: C.gray }));
  }
  elements.push(h3("2.3 风险矩阵"));
  const allRisksForMatrix = makeRiskMatrixRows(allHighRisks, allMidRisks);
  if (allRisksForMatrix.length > 0) {
    elements.push(new Table({ columnWidths: [3500, 1800, 3726], rows: [
      new TableRow({ tableHeader: true, children: [hCell("风险项", 3500), hCell("等级", 1800), hCell("影响范围", 3726)] }),
      ...allRisksForMatrix.map(r => new TableRow({ children: [cCell(r.text, 3500), cCell(r.level, 1800, { color: r.level === '高' ? C.red : C.orange }), cCell(r.scope, 3726)] }))
    ]}));
  }

  // 三、重点关注节点
  elements.push(pb(), h2("三、重点关注节点"));
  elements.push(p("根据会议记录中的决议事项，以下节点需要重点关注与跟进："));
  elements.push(h3("3.1 近期节点（本月内）"));
  const allNear = [];
  teamDataList.forEach(td => {
    if (td.labelAnalyses) {
      for (const [label, la] of td.labelAnalyses) {
        la.nearTermNodes.forEach(n => allNear.push({ ...n, team: td.teamName, label }));
      }
    } else {
      td.analysis.nearTermNodes.forEach(n => allNear.push({ ...n, team: td.teamName }));
    }
  });
  if (allNear.length > 0) {
    elements.push(new Table({ columnWidths: [1200, 1600, 3400, 2826], rows: [
      new TableRow({ tableHeader: true, children: [hCell("时间节点", 1200), hCell("责任方", 1600), hCell("关键事项", 3400), hCell("来源会议", 2826)] }),
      ...allNear.map(n => {
        const owner = n.team;
        const src = n.source || (n.label ? `${n.team}-${n.label}` : n.team);
        return new TableRow({ children: [cCell(n.dateStr, 1200), cCell(owner, 1600), cCell(n.text.substring(0, 80), 3400), cCell(src, 2826)] });
      })
    ]}));
  } else {
    elements.push(p("本月内暂无明确时间节点。", { color: C.gray }));
  }
  elements.push(h3("3.2 中期节点（未来两个月）"));
  const allMidNodes = [];
  teamDataList.forEach(td => {
    if (td.labelAnalyses) {
      for (const [label, la] of td.labelAnalyses) {
        la.midTermNodes.forEach(n => allMidNodes.push({ ...n, team: td.teamName, label }));
      }
    } else {
      td.analysis.midTermNodes.forEach(n => allMidNodes.push({ ...n, team: td.teamName }));
    }
  });
  if (allMidNodes.length > 0) {
    elements.push(new Table({ columnWidths: [1200, 1600, 3400, 2826], rows: [
      new TableRow({ tableHeader: true, children: [hCell("时间节点", 1200), hCell("责任方", 1600), hCell("关键事项", 3400), hCell("来源会议", 2826)] }),
      ...allMidNodes.map(n => {
        const owner = n.team;
        const src = n.source || (n.label ? `${n.team}-${n.label}` : n.team);
        return new TableRow({ children: [cCell(n.dateStr, 1200), cCell(owner, 1600), cCell(n.text.substring(0, 80), 3400), cCell(src, 2826)] });
      })
    ]}));
  } else {
    elements.push(p("未来两个月暂无明确时间节点。", { color: C.gray }));
  }
  elements.push(h3("3.3 持续跟进事项"));
  const nodeTexts = [...allNear, ...allMidNodes].map(n => n.text);
  const followItems = [];
  teamDataList.forEach(td => {
    if (td.labelAnalyses) {
      for (const [label, la] of td.labelAnalyses) {
        const filtered = (la.allTodoItems || []).filter(item => !nodeTexts.some(nt => textSimilar(item.text, nt) > 0.6));
        filtered.slice(0, 3).forEach(item => followItems.push({ team: `${td.teamName}-${label}`, text: sourcedItemText(item) }));
      }
    } else {
      const filtered = (td.analysis.allTodoItems || []).filter(item => !nodeTexts.some(nt => textSimilar(item.text, nt) > 0.6));
      filtered.slice(0, 4).forEach(item => followItems.push({ team: td.teamName, text: sourcedItemText(item) }));
    }
  });
  followItems.slice(0, 10).forEach(it => elements.push(bullet(it.text.substring(0, 100), { bold: `【${it.team}】` })));

  elements.push(...buildFallbackSection4(teamDataList, reportLimits));
  elements.push(...buildFallbackSection5(teamDataList, grandTotalDocs));

  return elements;
}

function prioritizedDocItems(docs, teamName, kind, reportLimits, label = '') {
  const field = kind === 'todos' ? 'todos' : 'conclusions';
  const baseLimit = Number(reportLimits.perDocumentItemLimit) || 5;
  const importantLimit = Math.max(baseLimit * 2, baseLimit + 3);
  return sortImportantMeetingsFirst(docs)
    .flatMap(d => {
      const important = d.important || isImportantMeetingTitle(d.name || d.title);
      return (d[field] || [])
        .slice(0, important ? importantLimit : baseLimit)
        .map(text => ({
        text: cleanText(text),
        source: formatSourceRef(teamName, d),
        important,
        label
      }))
        .filter(item => isValidConclusion(item.text));
    });
}

function buildFallbackSection4(teamDataList, reportLimits = getReportLimits()) {
  const elements = [];
  elements.push(pb(), h2("四、各团队会议汇总"));
  elements.push(p("本章节按团队进行划分，详细列出各模块的会议统计、核心议题与关键决议。"));
  teamDataList.forEach(td => {
    elements.push(h2(td.teamName));
    if (td.labelGroups && td.labelGroups.size > 1) {
      elements.push(p(`本团队包含 ${td.labelGroups.size} 个子项目：${[...td.labelGroups.keys()].join('、')}，共 ${td.data.documents.length} 份会议记录。`));
      for (const [label, docs] of td.labelGroups) {
        elements.push(h3(`${label}（${docs.length}份）`));
        elements.push(p("核心议题：", { bold: true }));
        prioritizedDocItems(docs, td.teamName, 'conclusions', reportLimits, label).slice(0, reportLimits.multiSourceSectionItemLimit).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220), { bold: `【${td.teamName}-${label}】` })));
        elements.push(p("关键决议：", { bold: true }));
        prioritizedDocItems(docs, td.teamName, 'todos', reportLimits, label).slice(0, reportLimits.multiSourceSectionItemLimit).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220), { bold: `【${td.teamName}-${label}】` })));
      }
    } else {
      elements.push(h3("会议统计"));
      elements.push(p(`会议数量：${td.data.documents.length}份${td.analysis.importantCount > 0 ? `（其中重要会议${td.analysis.importantCount}份）` : ''}`, { bold: true }));
      elements.push(h3("核心议题"));
      prioritizedDocItems(td.data.documents, td.teamName, 'conclusions', reportLimits).slice(0, reportLimits.sectionItemLimit).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220))));
      elements.push(h3("关键决议"));
      prioritizedDocItems(td.data.documents, td.teamName, 'todos', reportLimits).slice(0, reportLimits.sectionItemLimit).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220))));
    }
  });
  return elements;
}

function buildFallbackSection5(teamDataList, grandTotalDocs) {
  const elements = [];
  elements.push(pb(), h2("五、综合评估与建议"));

  const analyses = teamDataList.flatMap(td =>
    td.labelAnalyses ? [...td.labelAnalyses.values()] : [td.analysis]
  );
  const totalHighRisks = analyses.reduce((sum, a) => sum + (a.highRisks || []).length, 0);
  const totalMidRisks = analyses.reduce((sum, a) => sum + (a.midRisks || []).length, 0);
  const totalNearNodes = analyses.reduce((sum, a) => sum + (a.nearTermNodes || []).length, 0);
  const totalMidNodes = analyses.reduce((sum, a) => sum + (a.midTermNodes || []).length, 0);
  const totalTodos = analyses.reduce((sum, a) => sum + (a.totalTodos || 0), 0);
  const totalConclusions = analyses.reduce((sum, a) => sum + (a.totalConclusions || 0), 0);

  elements.push(h3("5.1 高度概况"));
  const riskPart = totalHighRisks + totalMidRisks > 0
    ? `识别高风险${totalHighRisks}项、中风险${totalMidRisks}项，`
    : '未识别明显高、中风险事项，';
  const nodePart = totalNearNodes + totalMidNodes > 0
    ? `后续共有${totalNearNodes + totalMidNodes}个明确时间节点需跟踪。`
    : '后续重点在于保持待办闭环。';
  elements.push(p(`本期共纳入${grandTotalDocs}份会议记录，覆盖${teamDataList.length}个团队，${riskPart}${nodePart}`));

  elements.push(h3("5.2 建议"));
  const suggestions = [];
  if (totalHighRisks > 0) {
    suggestions.push('高风险事项应逐项明确责任人、截止时间和验收标准，优先完成闭环。');
  }
  if (totalMidRisks > 0) {
    suggestions.push('中风险事项建议纳入周度跟踪清单，避免长期悬而未决。');
  }
  if (totalNearNodes + totalMidNodes > 0) {
    suggestions.push('对近期和中期节点建立统一台账，按周更新进展和阻塞点。');
  }
  if (totalTodos > totalConclusions) {
    suggestions.push('待办数量高于结论时，应加强会后决议确认，减少只记录不闭环的事项。');
  }

  const strategic = generateStrategicAnalysis(teamDataList);
  for (const item of strategic) {
    if (suggestions.length >= 5) break;
    if (!item.suggestion) continue;
    const text = item.suggestion.replace(/^建议/, '').replace(/[；;].*$/, '').trim();
    const normalized = `建议${text}`.replace(/。?$/, '。').substring(0, 120);
    if (!suggestions.some(existing => textSimilar(existing, normalized) > 0.6)) {
      suggestions.push(normalized);
    }
  }
  if (suggestions.length === 0) {
    suggestions.push('建议持续关注各项待办事项的落地情况，确保会议结论形成可追踪闭环。');
  }
  suggestions.slice(0, 5).forEach(item => elements.push(bullet(item)));
  return elements;
}

// ========== 主函数 ==========
async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || !args[1]) {
    console.error('用法: node generate-comprehensive-report.js <start_date> <end_date>');
    console.error('示例: node generate-comprehensive-report.js 04-13 04-26');
    process.exit(1);
  }
  const startDate = normalizeDate(args[0]);
  const endDate = normalizeDate(args[1]);
  const workspaceDir = resolveWorkspaceDir();
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
  const mode = reportMode(config);
  const reportLimits = getReportLimits(config);

  const multiSourceNames = getMultiSourceTeamNames(config);
  const multiSourceSet = new Set(multiSourceNames);

  const teamDataList = [];
  let grandTotalDocs = 0, grandTotalScanned = 0, grandTotalConclusions = 0, grandTotalTodos = 0;
  let allHighRisks = [], allMidRisks = [];

  for (const team of config.teams) {
    const dataFile = findInputFile(`team-summary-${team.name}.json`);
    let data;
    if (fs.existsSync(dataFile)) {
      data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    } else {
      const allFile = findInputFile('all-team-summaries.json');
      if (!fs.existsSync(allFile)) { console.log(`跳过 ${team.name}：无数据文件`); continue; }
      const allData = JSON.parse(fs.readFileSync(allFile, 'utf-8'));
      const teamEntry = allData.find(t => t.team === team.name);
      if (!teamEntry) { console.log(`跳过 ${team.name}：未找到团队数据`); continue; }
      const documents = [];
      for (const wData of Object.values(teamEntry.weeks)) {
        for (const m of wData.meetings) {
          documents.push({ name: m.title, conclusions: m.conclusions || [], todos: m.todos || [], important: m.important || isImportantMeetingTitle(m.title), rawContent: m.rawContent || '', sourceLabel: m.sourceLabel || null, meetingDate: m.meetingDate || null });
        }
      }
      data = { team: team.name, documents };
    }
    data.documents = sortImportantMeetingsFirst(filterAnalyzableMeetings(data.documents).map(d => ({
      ...d,
      important: d.important || isImportantMeetingTitle(d.name || d.title)
    })).filter(d =>
      d.meetingDate ? meetingDateInRange(d.meetingDate, startDate, endDate) : dateInRange(d.name, startDate, endDate, d.rawContent || '', d.mtime || null, d.ctime || null, d.folderName || null)
    ));
    if (data.documents.length === 0) { console.log(`跳过 ${team.name}：日期范围内无文档`); continue; }
    const analysis = analyzeDocs(data.documents, team.name, { startDate, endDate });

    const tdEntry = { teamName: team.name, data, analysis };

    if (multiSourceSet.has(team.name)) {
      const groups = groupByLabel(data.documents, team.name);
      if (groups.size > 1) {
        tdEntry.labelGroups = groups;
        tdEntry.labelAnalyses = new Map();
        for (const [label, docs] of groups) {
          const la = analyzeDocs(docs, team.name, { startDate, endDate, label });
          tdEntry.labelAnalyses.set(label, la);
          allHighRisks.push(...la.highRisks.map(r => ({ ...r, team: team.name, label })));
          allMidRisks.push(...la.midRisks.map(r => ({ ...r, team: team.name, label })));
        }
      } else {
        allHighRisks.push(...analysis.highRisks.map(r => ({ ...r, team: team.name })));
        allMidRisks.push(...analysis.midRisks.map(r => ({ ...r, team: team.name })));
      }
    } else {
      allHighRisks.push(...analysis.highRisks.map(r => ({ ...r, team: team.name })));
      allMidRisks.push(...analysis.midRisks.map(r => ({ ...r, team: team.name })));
    }

    teamDataList.push(tdEntry);
    grandTotalDocs += data.documents.length;
    grandTotalScanned += data.totalScanned || data.documents.length;
    grandTotalConclusions += analysis.totalConclusions;
    grandTotalTodos += analysis.totalTodos;
  }

  allHighRisks = dedupRisks(allHighRisks);
  allMidRisks = allMidRisks.filter(mr => !allHighRisks.some(hr => textSimilar(hr.text, mr.text) > 0.5));
  allMidRisks = dedupRisks(allMidRisks);

  let baseline = readMeetingBaseline(startDate, endDate);
  if (!baseline) {
    const written = writeMeetingBaseline(teamDataList, {
      startDate,
      endDate,
      source: 'generate-comprehensive-report'
    });
    baseline = written.baseline;
    console.log(`meeting-baseline: ${written.file}`);
  }
  const grandTotalAll = teamDataList.reduce((s, t) => s + (t.data.meetingListCount || t.data.totalScanned || t.data.documents.length), 0);
  const reportCounts = baselineCountsForReport(baseline, {
    meetingListCount: grandTotalAll,
    successfulReadCount: grandTotalDocs,
    analyzedDocumentCount: grandTotalDocs
  });

  const teamCount = teamDataList.length;
  const appendixTeamRows = sortTeamsByDocumentCount(teamDataList);

  const inclusionRate = reportCounts.meetingListCount > 0 ? Math.round((reportCounts.analyzedDocumentCount / reportCounts.meetingListCount) * 100) : 100;
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  // === 读取团队 LLM 摘要（两阶段模式） ===
  const teamSummaries = {};
  for (const td of teamDataList) {
    const summaryFile = mode === 'agent'
      ? teamSummaryPath(startDate, endDate, td.teamName, td.data.documents)
      : findInputFile(`team-llm-summary-${td.teamName}.md`);
    if (fs.existsSync(summaryFile)) {
      teamSummaries[td.teamName] = fs.readFileSync(summaryFile, 'utf-8');
      console.log(`[${td.teamName}] 使用已有 LLM 摘要 (${(teamSummaries[td.teamName].length / 1024).toFixed(1)}KB)`);
    }
  }
  const hasSummaries = Object.keys(teamSummaries).length > 0;
  const compactComprehensiveSummaries = !(config.llm && config.llm.compactComprehensiveSummaries === false);
  const maxTeamSummaryChars = Number(config.llm && config.llm.maxTeamSummaryChars) || 2600;
  if (hasSummaries && compactComprehensiveSummaries) {
    const compacted = compactTeamSummariesForComprehensive(teamSummaries, { maxCharsPerTeam: maxTeamSummaryChars });
    const stats = summarizeTeamSummaryCompression(teamSummaries, compacted);
    console.log(`综合报告摘要预压缩: ${(stats.rawChars / 1024).toFixed(1)}KB -> ${(stats.compactChars / 1024).toFixed(1)}KB (${stats.ratio}%, 每团队上限 ${maxTeamSummaryChars} 字符)`);
  } else if (hasSummaries) {
    console.log('综合报告摘要预压缩: 已关闭');
  }

  // === LLM 生成全部分析内容（1.2-5章），回退到规则分析 ===
  let analyticalElements;
  let llmTruncated = false;
  let generationMode = 'unknown';
  let analysisModel = null;
  const ruleFallbackSections = [];
  const prompt = buildComprehensiveReportPrompt(teamDataList, {
    startDate, endDate, grandTotalDocs: reportCounts.analyzedDocumentCount, teamCount,
    teamSummaries: hasSummaries ? teamSummaries : undefined,
    compactTeamSummaries: compactComprehensiveSummaries,
    maxTeamSummaryChars,
    reportLimits,
    multiSourceTeamNames: multiSourceNames
  });
  console.log(`综合报告分析模式：${mode}，输入 ${(prompt.length / 1024).toFixed(1)}KB`);
  let llmResult = await callLLM(prompt, config, {
    startDate, endDate,
    onModel: name => { analysisModel = name; },
    formatAnswer: (answer, pending) => formatComprehensiveAnalysis(answer, teamDataList, multiSourceSet, pending)
  });
  if (llmResult) {
    if (mode !== 'agent') {
      llmResult = formatComprehensiveAnalysis(llmResult, teamDataList, multiSourceSet, reason => new Error('综合报告格式不完整：' + reason), true);
      llmTruncated = !/^# 五、综合评估与建议$/m.test(llmResult);
      if (llmTruncated) console.log('⚠️ LLM 输出缺少末尾章节，将用规则分析补充缺失章节');
    }
    llmResult = normalizeMultiSourceBulletPrefixes(llmResult, multiSourceNames);
    console.log(`LLM 返回 ${(llmResult.length / 1024).toFixed(1)}KB，解析中...`);
    analyticalElements = parseReportMarkdown(llmResult);
    if (analyticalElements && analyticalElements.length > 0) {
      generationMode = mode === 'agent' ? 'agent' : (llmTruncated ? 'llm-with-rules-supplement' : 'llm');
      const summaryFile = outputPath(`comprehensive-llm-summary-${startDate.replace(/\-/g, '')}-${endDate.replace(/\-/g, '')}.md`);
      fs.writeFileSync(summaryFile, llmResult, 'utf-8');
      console.log(`分析正文已保存: ${path.basename(summaryFile)}`);
    }
  }
  if (!analyticalElements || analyticalElements.length === 0) {
    if (mode === 'agent') throw new Error('无法解析 agent 的综合报告 Markdown。');
    console.log('LLM 不可用或返回为空，使用规则分析...');
    generationMode = 'rules-fallback';
    analyticalElements = buildFallbackContent(teamDataList, allHighRisks, allMidRisks, { grandTotalDocs: reportCounts.analyzedDocumentCount, startDate, endDate, multiSourceSet, reportLimits });
  } else if (llmTruncated) {
    const hasFourInLlm = /^# 四、各团队会议汇总$/m.test(llmResult);
    if (!hasFourInLlm) {
      console.log('补充第四、五部分（规则回退）...');
      ruleFallbackSections.push('section4', 'section5');
      analyticalElements.push(...buildFallbackSection4(teamDataList, reportLimits));
      analyticalElements.push(...buildFallbackSection5(teamDataList, reportCounts.analyzedDocumentCount));
    } else {
      console.log('补充第五部分（综合评估与建议，规则回退）...');
      ruleFallbackSections.push('section5');
      analyticalElements.push(...buildFallbackSection5(teamDataList, reportCounts.analyzedDocumentCount));
    }
  }
  const llmUsed = generationMode === 'agent' || generationMode === 'llm' || generationMode === 'llm-with-rules-supplement';
  const models = llmUsed ? [analysisModel] : [];
  const generationModeLabel = formatGenerationMode(generationMode, models);
  console.log(`综合报告生成模式: ${generationModeLabel}`);

  const batchStatsFile = findInputFile('batch-read-stats.json');
  const batchStats = fs.existsSync(batchStatsFile) ? JSON.parse(fs.readFileSync(batchStatsFile, 'utf-8')) : null;
  const dataSourceMode = batchStats && (batchStats.mode === 'cache-rebuild' || batchStats.cacheRebuildUsed)
    ? 'cache-rebuild'
    : 'direct-read';
  const generationLabel = llmUsed ? `${generationModeLabel} 生成综合分析` : '未使用 LLM，使用规则回退生成';
  const dataSourceLabel = dataSourceMode === 'cache-rebuild' ? '限流后缓存重建' : '直接读取/缓存命中';

  const dateLabel = `${now.getFullYear()}年${formatDateChinese(startDate)} - ${formatDateChinese(endDate)}`;
  const coverSection = makeCoverPage({
    title1: '会议记录', title2: '汇总分析报告',
    dateRange: dateLabel,
    stats: [`共收录 ${reportCounts.analyzedDocumentCount} 份会议记录`, `覆盖 ${teamCount} 个团队`],
    editDate: dateStr
  });

  const doc = new Document({
    styles: docStyles,
    numbering: docNumbering,
    sections: [
      coverSection,
      // 正文
      { properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
        headers: { default: makeHeader(`${config.org_name ? config.org_name + ' ' : ''}会议记录汇总分析报告`, dateLabel) },
        footers: { default: makeFooter() },
        children: [
          h2("一、执行摘要"),
          h3("1.0 生成说明与复核提醒"),
          p(`生成方式：${generationLabel}。数据来源：${dataSourceLabel}。`, { color: C.red }),
          p("⚠️ 本报告为 AI 生成产物，可能存在遗漏、误读、归因错误或表格统计偏差；关键事实、风险等级、时间节点和责任归属请务必结合原始会议记录人工审核。", { color: C.red }),
          ...(dataSourceMode === 'cache-rebuild' ? [
            p("⚠️ 本次生成过程中检测到 KDocs 限流，报告使用本地缓存数据重建；限流解除后需要重新跑数据以刷新最新内容。", { color: C.red })
          ] : []),
          new Paragraph({ spacing: { before: 200 }, children: [] }),
          p(`本报告涵盖${teamDataList.map(t => t.teamName).join('、')}共${teamCount}个团队；会议清单共${reportCounts.meetingListCount}条，成功读取${reportCounts.successfulReadCount}份，纳入分析${reportCounts.analyzedDocumentCount}份。所有内容均基于实际会议记录文档提取，团队分类严格按配置映射关系归类。`),
          new Paragraph({ spacing: { before: 200 }, children: [] }),
          h3("1.1 核心发现"),
          new Table({ columnWidths: [3000, 6026], rows: [
            new TableRow({ tableHeader: true, children: [hCell("统计项", 3000), hCell("数值", 6026)] }),
            new TableRow({ children: [cCell("会议记录总数", 3000), cCell(`${reportCounts.analyzedDocumentCount}份`, 6026)] }),
            new TableRow({ children: [cCell("覆盖团队数", 3000), cCell(`${teamCount}个`, 6026)] }),
            new TableRow({ children: [cCell("时间跨度", 3000), cCell(`${now.getFullYear()}.${startDate} - ${endDate}`, 6026)] }),
            new TableRow({ children: [cCell("提取的结论条数", 3000), cCell(`${grandTotalConclusions}`, 6026)] }),
            new TableRow({ children: [cCell("提取的待办条数", 3000), cCell(`${grandTotalTodos}`, 6026)] })
          ]}),

          ...analyticalElements,

          pb(),
          h2("六、附录：会议清单与文档纳入率"),
          h3("团队汇总"),
          new Table({ columnWidths: [2500, 4300, 2226], rows: [
            new TableRow({ tableHeader: true, children: [hCell("团队", 2500), hCell("主要会议类型", 4300), hCell("文档数", 2226)] }),
            ...appendixTeamRows.map(td => new TableRow({ children: [
              cCell(td.teamName, 2500),
              cCell(summarizePrimaryMeetingTypes(td.data.documents, 5), 4300),
              cCell(`${td.data.documents.length}份`, 2226)
            ]}))
          ]}),
          h3("纳入率统计"),
          new Table({ columnWidths: [2313, 1500, 5213], rows: [
            new TableRow({ tableHeader: true, children: [hCell("统计项", 2313), hCell("数值", 1500), hCell("说明", 5213)] }),
            new TableRow({ children: [cCell("会议清单数", 2313), cCell(`${reportCounts.meetingListCount}条`, 1500, { bold: true }), cCell("统一数据基线中的会议条目", 5213)] }),
            new TableRow({ children: [cCell("成功读取数", 2313), cCell(`${reportCounts.successfulReadCount}份`, 1500, { bold: true }), cCell("成功读取正文或提取结构化内容的文档", 5213)] }),
            new TableRow({ children: [cCell("纳入分析数", 2313), cCell(`${reportCounts.analyzedDocumentCount}份`, 1500, { bold: true }), cCell("进入正文分析与附录统计的文档", 5213)] }),
            new TableRow({ children: [cCell("文档纳入率", 2313), cCell(`${inclusionRate}%`, 1500, { bold: true }), cCell(`${reportCounts.analyzedDocumentCount}/${reportCounts.meetingListCount}`, 5213)] })
          ]}),
          ...buildInclusionNote(reportCounts, baseline),
          new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "— 报告完 —", color: C.gray, size: 20, font: FONT })] })
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  const reportPrefix = config.org_name ? `${config.org_name}会议记录汇总分析报告` : '综合分析报告';
  let outFile = outputPath(`${reportPrefix}-${startDate.replace(/\-/g, '')}-${endDate.replace(/\-/g, '')}.docx`);
  try {
    fs.writeFileSync(outFile, buffer);
  } catch (e) {
    if (e.code !== 'EBUSY') throw e;
    const ts = new Date().toISOString().replace(/[T:]/g, '-').substring(0, 16);
    outFile = outputPath(`${reportPrefix}-${startDate.replace(/\-/g, '')}-${endDate.replace(/\-/g, '')}-${ts}.docx`);
    fs.writeFileSync(outFile, buffer);
    console.log(`原文件被占用，已另存为: ${path.basename(outFile)}`);
  }
  const statsFile = writeOutputJson('comprehensive-report-generation-stats.json', {
    type: 'comprehensive-report',
    startDate,
    endDate,
    generatedAt: new Date().toISOString(),
    mode: generationMode,
    models,
    ruleFallbackSections,
    llmUsed,
    rulesFallbackUsed: generationMode === 'rules-fallback' || ruleFallbackSections.length > 0,
    output: path.basename(outFile),
    dataSourceMode,
    cacheRebuildReason: dataSourceMode === 'cache-rebuild'
      ? 'KDocs 返回限流，报告使用本地缓存数据生成；限流解除后需要重新跑数据。'
      : null,
    baseline: baseline.counts,
    documents: reportCounts.analyzedDocumentCount,
    teams: teamCount
  });
  console.log(`综合报告生成模式统计: ${statsFile}`);
  console.log(`综合报告已生成: ${(buffer.length / 1024).toFixed(1)}KB -> ${path.basename(outFile)}`);
  printAiReviewWarning({
    title: '综合会议记录分析报告',
    output: outFile,
    statsFile,
    mode: generationMode,
    models,
    llmUsed,
    timingSummary: `会议清单 ${reportCounts.meetingListCount} 条，成功读取 ${reportCounts.successfulReadCount} 份，纳入分析 ${reportCounts.analyzedDocumentCount} 份，覆盖团队 ${teamCount} 个，数据来源：${dataSourceLabel}`
  });
  if (dataSourceMode === 'cache-rebuild') {
    console.log('⚠️ 本次综合报告使用缓存数据生成；KDocs 限流解除后需要重新跑数据。');
  }
}

main().catch(error => {
  const pending = error.code === 'AGENT_ANALYSIS_PENDING';
  console.error(error.message);
  process.exitCode = pending ? 75 : 1;
  writeOutputJson('comprehensive-report-generation-stats.json', {
    type: 'comprehensive-report',
    startDate: normalizeDate(process.argv[2]),
    endDate: normalizeDate(process.argv[3]),
    generatedAt: new Date().toISOString(),
    mode: pending ? 'pending' : 'error',
    llmUsed: false,
    message: error.message
  });
});
