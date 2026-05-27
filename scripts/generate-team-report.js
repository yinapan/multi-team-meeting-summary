const fs = require('fs');
const path = require('path');
const {
  C, FONT, hCell, cCell, bullet, h1, h2, h3, p, pb,
  makeHeader, makeFooter, makeCoverPage,
  cleanText, isValidConclusion, makeSuggestion, textSimilar, dedupTexts, analyzeDocs,
  callLLM, buildTeamReportPrompt, parseReportMarkdown,
  formatSourceRef, withSourceRef, normalizeMultiSourceBulletPrefixes,
  formatGenerationMode, printAiReviewWarning,
  docStyles, docNumbering, resolveWorkspaceDir, outputPath, findInputFile, readInputJson, writeOutputJson, normalizeDate, formatDateChinese, dateInRange, meetingDateInRange,
  isMultiSourceTeam, groupByLabel,
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, PageNumber, PageBreak
} = require('./shared');

// ========== 规则回退：生成 1.2-5 章节 ==========
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

function firstAnalysisSource(analysis) {
  const item = (analysis.allConclusionItems || [])[0] || (analysis.allTodoItems || [])[0] || {};
  return item.source || '';
}

function sourcedItemText(item) {
  if (typeof item === 'string') return item;
  return withSourceRef(item.text, item.source);
}

function buildFallbackContent(data, analysis, teamName, opts) {
  const { totalDocs, importantCount, reportLimits = getReportLimits() } = opts;
  const elements = [];

  // 1.2 主要趋势
  elements.push(h2("1.2 主要趋势"));
  const fallbackSource = firstAnalysisSource(analysis);
  if (analysis.trends.length > 0) {
    analysis.trends.slice(0, 5).forEach(t => elements.push(bullet(withSourceRef(t, fallbackSource))));
  } else {
    (analysis.allConclusionItems || []).slice(0, 5).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220))));
  }

  // 二、风险点分析
  elements.push(pb(), h1("二、风险点分析"));
  elements.push(p("基于本期会议记录的综合分析，识别出以下需要重点关注的风险点："));
  elements.push(h2("2.1 高风险事项"));
  if (analysis.highRisks.length > 0) {
    analysis.highRisks.slice(0, 10).forEach(r => elements.push(bullet(withSourceRef(r.text, r.source), { bold: '【高】' })));
  } else {
    elements.push(p("本期会议记录中未发现高风险事项。", { color: C.gray }));
  }
  elements.push(h2("2.2 中风险事项"));
  if (analysis.midRisks.length > 0) {
    analysis.midRisks.slice(0, 10).forEach(r => elements.push(bullet(withSourceRef(r.text, r.source), { bold: '【中】' })));
  } else {
    elements.push(p("本期会议记录中未发现中风险事项。", { color: C.gray }));
  }
  elements.push(h2("2.3 风险矩阵"));
  const risksForMatrix = [
    ...analysis.highRisks.slice(0, 8).map(r => ({ text: r.text.substring(0, 60), level: '高', keyword: `${r.keyword}；${r.source || ''}` })),
    ...analysis.midRisks.slice(0, 5).map(r => ({ text: r.text.substring(0, 60), level: '中', keyword: `${r.keyword}；${r.source || ''}` }))
  ];
  if (risksForMatrix.length > 0) {
    elements.push(new Table({ columnWidths: [3500, 1800, 3726], rows: [
      new TableRow({ tableHeader: true, children: [hCell("风险项", 3500), hCell("等级", 1800), hCell("影响范围", 3726)] }),
      ...risksForMatrix.map(r => new TableRow({ children: [cCell(r.text, 3500), cCell(r.level, 1800, { bold: true, color: r.level === '高' ? C.red : C.orange }), cCell(r.keyword, 3726)] }))
    ]}));
  }

  // 三、重点关注节点
  elements.push(pb(), h1("三、重点关注节点"));
  elements.push(p("根据会议记录中的决议事项，以下节点需要重点关注与跟进："));
  elements.push(h2("3.1 近期节点（本月内）"));
  if (analysis.nearTermNodes.length > 0) {
    elements.push(new Table({ columnWidths: [1600, 2200, 5226], rows: [
      new TableRow({ tableHeader: true, children: [hCell("时间节点", 1600), hCell("责任方", 2200), hCell("关键事项", 5226)] }),
      ...analysis.nearTermNodes.map(n => new TableRow({ children: [cCell(n.dateStr, 1600), cCell(n.owner || '未指定', 2200), cCell(withSourceRef(n.text.substring(0, 100), n.source), 5226)] }))
    ]}));
  } else {
    elements.push(p("本月内暂无明确时间节点。", { color: C.gray }));
  }
  elements.push(h2("3.2 中期节点（未来两个月）"));
  if (analysis.midTermNodes.length > 0) {
    elements.push(new Table({ columnWidths: [1600, 2200, 5226], rows: [
      new TableRow({ tableHeader: true, children: [hCell("时间节点", 1600), hCell("责任方", 2200), hCell("关键事项", 5226)] }),
      ...analysis.midTermNodes.map(n => new TableRow({ children: [cCell(n.dateStr, 1600), cCell(n.owner || '未指定', 2200), cCell(withSourceRef(n.text.substring(0, 100), n.source), 5226)] }))
    ]}));
  } else {
    elements.push(p("未来两个月暂无明确时间节点。", { color: C.gray }));
  }
  elements.push(h2("3.3 持续跟进事项"));
  const nodeTexts = [...analysis.nearTermNodes, ...analysis.midTermNodes].map(n => n.text);
  const filtered = (analysis.allTodoItems || []).filter(item => !nodeTexts.some(nt => textSimilar(item.text, nt) > 0.6));
  if (filtered.length > 0) {
    filtered.slice(0, 8).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220))));
  } else {
    elements.push(p("无", { color: C.gray }));
  }

  // 四、团队会议汇总
  elements.push(pb(), h1("四、团队会议汇总"));
  elements.push(h3("会议统计"));
  elements.push(p(`会议数量：${totalDocs}份${importantCount > 0 ? `（其中重要会议${importantCount}份）` : ''}`, { bold: true }));
  elements.push(h3("核心议题"));
  data.documents.flatMap(d => (d.conclusions || []).slice(0, reportLimits.perDocumentItemLimit).map(c => ({ text: cleanText(c), source: formatSourceRef(teamName, d) })).filter(item => isValidConclusion(item.text))).slice(0, reportLimits.sectionItemLimit).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220))));
  elements.push(h3("关键决议"));
  data.documents.flatMap(d => (d.todos || []).slice(0, reportLimits.perDocumentItemLimit).map(t => ({ text: cleanText(t), source: formatSourceRef(teamName, d) })).filter(item => isValidConclusion(item.text))).slice(0, reportLimits.sectionItemLimit).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220))));

  // 五、综合评估与建议
  elements.push(pb(), h1("五、综合评估与建议"));
  elements.push(p(`基于本期${totalDocs}份会议记录的综合分析，提出以下评估与行动建议：`));
  elements.push(h2("5.1 整体概况"));
  elements.push(p(`本期${teamName}共开展${totalDocs}次会议，产生${analysis.totalConclusions}项结论和${analysis.totalTodos}项待办事项。`));
  if (analysis.topicCategories.length > 0) {
    elements.push(p(`议题分布：${analysis.topicCategories.slice(0, 5).map(([label, count]) => `${label}（${count}场）`).join('、')}。`));
  }
  if (analysis.highRisks.length > 0) {
    elements.push(p(`发现${analysis.highRisks.length}个高风险事项，需重点关注。`, { color: C.red, bold: true }));
  }
  if (analysis.midRisks.length > 0) {
    elements.push(p(`发现${analysis.midRisks.length}个中风险事项，建议持续跟进。`, { color: C.orange }));
  }
  elements.push(h2("5.2 建议"));
  analysis.actionSuggestions.slice(0, 5).forEach(s => elements.push(bullet(withSourceRef(s, fallbackSource))));
  if (analysis.highRisks.length > 0) {
    const seen = new Set();
    analysis.highRisks.filter(r => { if (seen.has(r.keyword)) return false; seen.add(r.keyword); return true; }).slice(0, 5).forEach(r => elements.push(bullet(withSourceRef(makeSuggestion(r), r.source))));
  }
  if (analysis.actionSuggestions.length === 0 && analysis.highRisks.length === 0) {
    elements.push(bullet("建议持续关注各项待办事项的落地情况"));
  }

  return elements;
}

// ========== 多 source 团队：带 label 标签的规则回退 ==========
function buildMultiSourceContent(data, teamName, labelGroups, labelAnalyses, opts) {
  const { totalDocs, importantCount, reportLimits = getReportLimits() } = opts;
  const elements = [];

  // 1.2 主要趋势
  elements.push(h2("1.2 主要趋势"));
  for (const [label, analysis] of labelAnalyses) {
    const source = firstAnalysisSource(analysis);
    const trends = analysis.trends.length > 0
      ? analysis.trends.slice(0, 3).map(t => withSourceRef(t, source))
      : (analysis.allConclusionItems || []).slice(0, 3).map(item => sourcedItemText(item).substring(0, 220));
    trends.forEach(t => elements.push(bullet(t, { bold: `【${teamName}-${label}】` })));
  }

  // 二、风险点分析
  elements.push(pb(), h1("二、风险点分析"));
  elements.push(p("基于本期会议记录的综合分析，识别出以下需要重点关注的风险点："));
  elements.push(h2("2.1 高风险事项"));
  let hasHighRisk = false;
  for (const [label, analysis] of labelAnalyses) {
    for (const r of analysis.highRisks.slice(0, 5)) {
      elements.push(bullet(`【${teamName}-${label}】${withSourceRef(r.text, r.source)}`, { bold: '【高】' }));
      hasHighRisk = true;
    }
  }
  if (!hasHighRisk) elements.push(p("本期会议记录中未发现高风险事项。", { color: C.gray }));

  elements.push(h2("2.2 中风险事项"));
  let hasMidRisk = false;
  for (const [label, analysis] of labelAnalyses) {
    for (const r of analysis.midRisks.slice(0, 5)) {
      elements.push(bullet(`【${teamName}-${label}】${withSourceRef(r.text, r.source)}`, { bold: '【中】' }));
      hasMidRisk = true;
    }
  }
  if (!hasMidRisk) elements.push(p("本期会议记录中未发现中风险事项。", { color: C.gray }));

  elements.push(h2("2.3 风险矩阵"));
  const risksForMatrix = [];
  for (const [label, analysis] of labelAnalyses) {
    for (const r of analysis.highRisks.slice(0, 5)) risksForMatrix.push({ text: r.text.substring(0, 60), level: '高', label, keyword: `${r.keyword}；${r.source || ''}` });
    for (const r of analysis.midRisks.slice(0, 3)) risksForMatrix.push({ text: r.text.substring(0, 60), level: '中', label, keyword: `${r.keyword}；${r.source || ''}` });
  }
  if (risksForMatrix.length > 0) {
    elements.push(new Table({ columnWidths: [2800, 1200, 1800, 3226], rows: [
      new TableRow({ tableHeader: true, children: [hCell("风险项", 2800), hCell("等级", 1200), hCell("所属项目", 1800), hCell("影响范围", 3226)] }),
      ...risksForMatrix.map(r => new TableRow({ children: [cCell(r.text, 2800), cCell(r.level, 1200, { bold: true, color: r.level === '高' ? C.red : C.orange }), cCell(r.label, 1800), cCell(r.keyword, 3226)] }))
    ]}));
  }

  // 三、重点关注节点
  elements.push(pb(), h1("三、重点关注节点"));
  elements.push(p("根据会议记录中的决议事项，以下节点需要重点关注与跟进："));
  elements.push(h2("3.1 近期节点（本月内）"));
  const allNear = [];
  for (const [label, analysis] of labelAnalyses) {
    for (const n of analysis.nearTermNodes) allNear.push({ ...n, label });
  }
  if (allNear.length > 0) {
    elements.push(new Table({ columnWidths: [1400, 1800, 1800, 4026], rows: [
      new TableRow({ tableHeader: true, children: [hCell("时间节点", 1400), hCell("所属项目", 1800), hCell("责任方", 1800), hCell("关键事项", 4026)] }),
      ...allNear.map(n => new TableRow({ children: [cCell(n.dateStr, 1400), cCell(n.label, 1800), cCell(n.owner || '未指定', 1800), cCell(withSourceRef(n.text.substring(0, 100), n.source), 4026)] }))
    ]}));
  } else {
    elements.push(p("本月内暂无明确时间节点。", { color: C.gray }));
  }

  elements.push(h2("3.2 中期节点（未来两个月）"));
  const allMid = [];
  for (const [label, analysis] of labelAnalyses) {
    for (const n of analysis.midTermNodes) allMid.push({ ...n, label });
  }
  if (allMid.length > 0) {
    elements.push(new Table({ columnWidths: [1400, 1800, 1800, 4026], rows: [
      new TableRow({ tableHeader: true, children: [hCell("时间节点", 1400), hCell("所属项目", 1800), hCell("责任方", 1800), hCell("关键事项", 4026)] }),
      ...allMid.map(n => new TableRow({ children: [cCell(n.dateStr, 1400), cCell(n.label, 1800), cCell(n.owner || '未指定', 1800), cCell(withSourceRef(n.text.substring(0, 100), n.source), 4026)] }))
    ]}));
  } else {
    elements.push(p("未来两个月暂无明确时间节点。", { color: C.gray }));
  }

  elements.push(h2("3.3 持续跟进事项"));
  const allNodeTexts = [...allNear, ...allMid].map(n => n.text);
  for (const [label, analysis] of labelAnalyses) {
    const filtered = (analysis.allTodoItems || []).filter(item => !allNodeTexts.some(nt => textSimilar(item.text, nt) > 0.6));
    filtered.slice(0, 4).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220), { bold: `【${teamName}-${label}】` })));
  }

  // 四、团队会议汇总（按 label 分小节）
  elements.push(pb(), h1("四、团队会议汇总"));
  for (const [label, docs] of labelGroups) {
    const analysis = labelAnalyses.get(label);
    elements.push(h2(label));
    elements.push(h3("会议统计"));
    const labelImportant = docs.filter(d => d.important).length;
    elements.push(p(`会议数量：${docs.length}份${labelImportant > 0 ? `（其中重要会议${labelImportant}份）` : ''}`, { bold: true }));
    elements.push(h3("核心议题"));
    docs.flatMap(d => (d.conclusions || []).slice(0, reportLimits.perDocumentItemLimit).map(c => ({ text: cleanText(c), source: formatSourceRef(teamName, d) })).filter(item => isValidConclusion(item.text))).slice(0, reportLimits.multiSourceSectionItemLimit).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220), { bold: `【${teamName}-${label}】` })));
    elements.push(h3("关键决议"));
    docs.flatMap(d => (d.todos || []).slice(0, reportLimits.perDocumentItemLimit).map(t => ({ text: cleanText(t), source: formatSourceRef(teamName, d) })).filter(item => isValidConclusion(item.text))).slice(0, reportLimits.multiSourceSectionItemLimit).forEach(item => elements.push(bullet(sourcedItemText(item).substring(0, 220), { bold: `【${teamName}-${label}】` })));
  }

  // 五、综合评估与建议
  elements.push(pb(), h1("五、综合评估与建议"));
  elements.push(p(`基于本期${totalDocs}份会议记录的综合分析，提出以下评估与行动建议：`));
  elements.push(h2("5.1 整体概况"));
  for (const [label, analysis] of labelAnalyses) {
    const docs = labelGroups.get(label);
    elements.push(p(`${label}：本期共${docs.length}次会议，产生${analysis.totalConclusions}项结论和${analysis.totalTodos}项待办。`, { bold: true }));
    if (analysis.highRisks.length > 0) {
      elements.push(p(`  发现${analysis.highRisks.length}个高风险事项，需重点关注。`, { color: C.red }));
    }
  }
  elements.push(h2("5.2 建议"));
  for (const [label, analysis] of labelAnalyses) {
    analysis.actionSuggestions.slice(0, 3).forEach(s => elements.push(bullet(withSourceRef(s, firstAnalysisSource(analysis)), { bold: `【${teamName}-${label}】` })));
    const seen = new Set();
    analysis.highRisks.filter(r => { if (seen.has(r.keyword)) return false; seen.add(r.keyword); return true; }).slice(0, 3).forEach(r => elements.push(bullet(withSourceRef(makeSuggestion(r), r.source), { bold: `【${teamName}-${label}】` })));
  }

  return elements;
}

// ========== 生成单团队报告 ==========
function generateReport(data, teamName, startDate, endDate, analyticalElements) {
  const totalDocs = data.documents.length;
  const totalScanned = data.totalScanned || totalDocs;
  const inclusionRate = totalScanned > 0 ? Math.round((totalDocs / totalScanned) * 100) : 100;
  const importantCount = data.documents.filter(d => d.important).length;

  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const dateLabel = `${now.getFullYear()}年${formatDateChinese(startDate)} - ${formatDateChinese(endDate)}`;

  const coverSection = makeCoverPage({
    title1: '会议记录', title2: '汇总分析报告',
    dateRange: dateLabel,
    stats: [`共收录 ${totalDocs} 份会议记录`, `团队：${teamName}`],
    editDate: dateStr
  });

  return new Document({
    styles: docStyles,
    numbering: docNumbering,
    sections: [
      coverSection,
      // === 正文 ===
      { properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
        headers: { default: makeHeader(`${teamName}会议记录汇总分析报告`, dateLabel) },
        footers: { default: makeFooter() },
        children: [
          h1("一、执行摘要"),
          h2("1.1 核心发现"),
          new Table({ columnWidths: [3000, 6026], rows: [
            new TableRow({ tableHeader: true, children: [hCell("统计项", 3000), hCell("数值", 6026)] }),
            new TableRow({ children: [cCell("会议记录总数", 3000), cCell(`${totalDocs}份`, 6026)] }),
            new TableRow({ children: [cCell("覆盖部门/项目数", 3000), cCell(teamName, 6026)] }),
            new TableRow({ children: [cCell("时间跨度", 3000), cCell(`${now.getFullYear()}.${startDate} - ${endDate}`, 6026)] }),
            new TableRow({ children: [cCell("核心议题数量", 3000), cCell(`${data._analysis.totalConclusions}`, 6026)] }),
            new TableRow({ children: [cCell("关键决议数量", 3000), cCell(`${data._analysis.totalTodos}`, 6026)] }),
            ...(importantCount > 0 ? [new TableRow({ children: [cCell("重要会议数量", 3000), cCell(`${importantCount}份`, 6026)] })] : [])
          ]}),

          ...analyticalElements,

          pb(),
          h1("六、附录：会议清单与文档纳入率"),
          h2("团队会议清单"),
          new Table({ columnWidths: [600, 4826, 1600, 1600], rows: [
            new TableRow({ tableHeader: true, children: [hCell("#", 600), hCell("会议名称", 4826), hCell("结论数", 1600), hCell("待办数", 1600)] }),
            ...data.documents.map((d, i) => new TableRow({ children: [
              cCell(`${i + 1}`, 600),
              cCell(d.name.replace(/\.otl$/, ''), 4826),
              cCell(`${d.conclusions.length}`, 1600),
              cCell(`${d.todos.length}`, 1600)
            ]}))
          ]}),
          new Paragraph({ spacing: { before: 300 }, children: [] }),
          h2("纳入率统计"),
          new Table({ columnWidths: [3000, 3013, 3013], rows: [
            new TableRow({ tableHeader: true, children: [hCell("统计项", 3000), hCell("数值", 3013), hCell("说明", 3013)] }),
            new TableRow({ children: [cCell("日期范围内文档数", 3000), cCell(`${totalScanned}份`, 3013, { bold: true }), cCell("日期筛选后匹配的文件", 3013)] }),
            new TableRow({ children: [cCell("已纳入分析文档数", 3000), cCell(`${totalDocs}份`, 3013, { bold: true }), cCell("成功读取并解析的文档", 3013)] }),
            new TableRow({ children: [cCell("文档纳入率", 3000), cCell(`${inclusionRate}%`, 3013, { bold: true }), cCell(`${totalDocs}/${totalScanned}`, 3013)] })
          ]}),
          new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "— 报告完 —", color: C.gray, size: 20, font: FONT })] })
        ]
      }
    ]
  });
}

// ========== 主函数 ==========
async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || !args[1]) {
    console.error('用法: node generate-team-report.js <start_date> <end_date>');
    console.error('示例: node generate-team-report.js 04-13 04-26');
    process.exit(1);
  }
  const startDate = normalizeDate(args[0]);
  const endDate = normalizeDate(args[1]);
  const workspaceDir = resolveWorkspaceDir();

  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
  const reportLimits = getReportLimits(config);
  const reportGenerationStats = [];

  async function processTeam(team) {
    const teamName = team.name;
    const dataFile = findInputFile(`team-summary-${teamName}.json`);
    const startedAt = Date.now();

    let data;
    if (fs.existsSync(dataFile)) {
      data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    } else {
      const allFile = findInputFile('all-team-summaries.json');
      if (!fs.existsSync(allFile)) {
        console.log(`跳过 ${teamName}：无数据文件`);
        reportGenerationStats.push({ team: teamName, mode: 'skipped', reason: 'no data file' });
        return;
      }
      const allData = JSON.parse(fs.readFileSync(allFile, 'utf-8'));
      const teamEntry = allData.find(t => t.team === teamName);
      if (!teamEntry) {
        console.log(`跳过 ${teamName}：未找到团队数据`);
        reportGenerationStats.push({ team: teamName, mode: 'skipped', reason: 'team data not found' });
        return;
      }
      const documents = [];
      for (const wData of Object.values(teamEntry.weeks)) {
        for (const m of wData.meetings) {
          documents.push({ name: m.title, conclusions: m.conclusions || [], todos: m.todos || [], important: m.important, rawContent: m.rawContent || '', sourceLabel: m.sourceLabel || null, meetingDate: m.meetingDate || null });
        }
      }
      data = { team: teamName, documents };
    }
    data.documents = data.documents.filter(d =>
      d.meetingDate ? meetingDateInRange(d.meetingDate, startDate, endDate) : dateInRange(d.name, startDate, endDate, d.rawContent || '')
    );
    if (data.documents.length === 0) {
      console.log(`跳过 ${teamName}：日期范围内无文档`);
      reportGenerationStats.push({ team: teamName, mode: 'skipped', reason: 'no documents in date range', documents: 0 });
      return;
    }

    const analysis = analyzeDocs(data.documents, teamName, { startDate, endDate });
    data._analysis = analysis;

    // === 生成分析内容 ===
    let analyticalElements;
    let generationMode = 'unknown';
    const generationDetails = [];
    const isMultiSource = isMultiSourceTeam(team);
    const labelGroups = isMultiSource ? groupByLabel(data.documents, teamName) : null;
    const hasMultiLabels = labelGroups && labelGroups.size > 1;

    if (hasMultiLabels) {
      // 多 source 团队：按 label 分别生成 LLM 摘要
      console.log(`[${teamName}] 多 source 团队 (${[...labelGroups.keys()].join(', ')})，按 label 分别处理`);
      const labelAnalyses = new Map();
      for (const [label, docs] of labelGroups) {
        const labelAnalysis = analyzeDocs(docs, teamName, { startDate, endDate, label });
        labelAnalyses.set(label, labelAnalysis);

        const labelData = { ...data, documents: docs };
        const prompt = buildTeamReportPrompt(labelData, labelAnalysis, teamName, { startDate, endDate, isMultiSource: true, reportLimits });
        console.log(`  [${label}] 调用 LLM（${(prompt.length / 1024).toFixed(1)}KB prompt, ${docs.length}篇）...`);
        let llmResult = await callLLM(prompt, config);
        if (llmResult) {
          llmResult = normalizeMultiSourceBulletPrefixes(llmResult, [teamName]);
          console.log(`  [${label}] LLM 返回 ${(llmResult.length / 1024).toFixed(1)}KB`);
          const summaryFile = outputPath(`team-llm-summary-${teamName}-${label}.md`);
          fs.writeFileSync(summaryFile, llmResult, 'utf-8');
          generationDetails.push({ label, mode: 'llm', bytes: Buffer.byteLength(llmResult, 'utf-8') });
        } else {
          generationDetails.push({ label, mode: 'rules-fallback', reason: 'llm unavailable or empty' });
        }
      }
      // 团队汇总 LLM 摘要：合并所有 label 的 LLM 输出
      const allLabelSummaries = [];
      for (const [label] of labelGroups) {
        const sf = findInputFile(`team-llm-summary-${teamName}-${label}.md`);
        if (fs.existsSync(sf)) allLabelSummaries.push(`## ${label}\n\n${fs.readFileSync(sf, 'utf-8')}`);
      }
      if (allLabelSummaries.length > 0) {
        const combined = normalizeMultiSourceBulletPrefixes(allLabelSummaries.join('\n\n---\n\n'), [teamName]);
        fs.writeFileSync(outputPath(`team-llm-summary-${teamName}.md`), combined, 'utf-8');
        console.log(`[${teamName}] 合并 LLM 摘要 ${(combined.length / 1024).toFixed(1)}KB，解析中...`);
        analyticalElements = parseReportMarkdown(combined);
        if (analyticalElements && analyticalElements.length > 0) generationMode = 'llm';
      }
      if (!analyticalElements || analyticalElements.length === 0) {
        console.log(`[${teamName}] LLM 解析无结果，使用规则分析...`);
        generationMode = 'rules-fallback';
        analyticalElements = buildMultiSourceContent(data, teamName, labelGroups, labelAnalyses, {
          totalDocs: data.documents.length,
          importantCount: data.documents.filter(d => d.important).length,
          reportLimits
        });
      }
    } else {
      // 单 source 团队：原有逻辑
      const prompt = buildTeamReportPrompt(data, analysis, teamName, { startDate, endDate, reportLimits });
      console.log(`[${teamName}] 调用 LLM 生成分析（${(prompt.length / 1024).toFixed(1)}KB prompt）...`);
      let llmResult = await callLLM(prompt, config);
      if (llmResult) {
        llmResult = normalizeMultiSourceBulletPrefixes(llmResult, [teamName]);
        console.log(`[${teamName}] LLM 返回 ${(llmResult.length / 1024).toFixed(1)}KB，解析中...`);
        analyticalElements = parseReportMarkdown(llmResult);
        const summaryFile = outputPath(`team-llm-summary-${teamName}.md`);
        fs.writeFileSync(summaryFile, llmResult, 'utf-8');
        if (analyticalElements && analyticalElements.length > 0) generationMode = 'llm';
      }
      if (!analyticalElements || analyticalElements.length === 0) {
        console.log(`[${teamName}] LLM 不可用，使用规则分析...`);
        generationMode = 'rules-fallback';
        analyticalElements = buildFallbackContent(data, analysis, teamName, {
          totalDocs: data.documents.length,
          importantCount: data.documents.filter(d => d.important).length,
          reportLimits
        });
      }
    }

    console.log(`[${teamName}] 生成模式: ${generationMode === 'llm' ? 'LLM' : generationMode === 'rules-fallback' ? '规则回退' : generationMode}`);
    const doc = generateReport(data, teamName, startDate, endDate, analyticalElements);
    const buffer = await Packer.toBuffer(doc);

    const outFile = outputPath(`${teamName}-会议记录汇总分析报告-${startDate.replace(/\-/g, '')}-${endDate.replace(/\-/g, '')}.docx`);
    try {
      fs.writeFileSync(outFile, buffer);
    } catch (e) {
      if (e.code === 'EBUSY') {
        const ts = new Date().toISOString().replace(/[T:]/g, '-').substring(0, 16);
        const altFile = outputPath(`${teamName}-会议记录汇总分析报告-${startDate.replace(/\-/g, '')}-${endDate.replace(/\-/g, '')}-${ts}.docx`);
        fs.writeFileSync(altFile, buffer);
        console.log(`${teamName} 原文件被占用，已另存为: ${path.basename(altFile)}`);
        return;
      }
      throw e;
    }
    console.log(`${teamName} 报告已生成: ${(buffer.length / 1024).toFixed(1)}KB -> ${path.basename(outFile)}`);
    reportGenerationStats.push({
      team: teamName,
      mode: generationMode,
      documents: data.documents.length,
      output: path.basename(outFile),
      elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      details: generationDetails
    });
  }

  const teams = config.teams || [];
  const reportConcurrency = Math.max(1, Number(config.llm && (config.llm.teamReportConcurrency || config.llm.reportConcurrency)) || 5);
  let nextTeamIndex = 0;
  async function worker() {
    while (nextTeamIndex < teams.length) {
      const team = teams[nextTeamIndex++];
      try {
        await processTeam(team);
      } catch (e) {
        console.error(`[${team.name}] 报告生成失败: ${e.message}`);
        reportGenerationStats.push({ team: team.name, mode: 'error', error: e.message });
      }
    }
  }
  const workerCount = Math.min(reportConcurrency, teams.length);
  console.log(`团队报告并发数: ${workerCount}`);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const statsFile = writeOutputJson('report-generation-stats.json', {
    type: 'team-reports',
    startDate,
    endDate,
    generatedAt: new Date().toISOString(),
    summary: {
      llm: reportGenerationStats.filter(s => s.mode === 'llm').length,
      rulesFallback: reportGenerationStats.filter(s => s.mode === 'rules-fallback').length,
      skipped: reportGenerationStats.filter(s => s.mode === 'skipped').length,
      error: reportGenerationStats.filter(s => s.mode === 'error').length
    },
    teams: reportGenerationStats
  });
  console.log(`报告生成模式统计: ${statsFile}`);
  const llmCount = reportGenerationStats.filter(s => s.mode === 'llm').length;
  const fallbackCount = reportGenerationStats.filter(s => s.mode === 'rules-fallback').length;
  const skippedCount = reportGenerationStats.filter(s => s.mode === 'skipped').length;
  const errorCount = reportGenerationStats.filter(s => s.mode === 'error').length;
  const elapsedTeams = reportGenerationStats
    .filter(s => typeof s.elapsedSec === 'number')
    .map(s => `${s.team}:${s.elapsedSec}s`)
    .join('；');
  printAiReviewWarning({
    title: '各团队会议记录汇总报告',
    output: 'outputs/*-会议记录汇总分析报告-*.docx',
    statsFile,
    mode: llmCount > 0 ? 'llm' : (fallbackCount > 0 ? 'rules-fallback' : 'skipped'),
    llmUsed: llmCount > 0,
    timingSummary: `LLM ${llmCount} 个，规则回退 ${fallbackCount} 个，跳过 ${skippedCount} 个，失败 ${errorCount} 个${elapsedTeams ? `；${elapsedTeams}` : ''}`
  });

  if (args.includes('--no-kanban') || process.env.SKIP_AUTO_KANBAN === '1') {
    return;
  }

  // 报告全部生成后，自动同步生成看板
  console.log('\n===== 同步生成会议看板 =====');
  try {
    const kanbanScript = path.join(__dirname, 'generate-kanban.js');
    require('child_process').execFileSync(process.execPath, [kanbanScript], {
      cwd: workspaceDir, stdio: 'inherit', timeout: 600000, env: process.env
    });
  } catch (e) {
    console.log(`看板生成失败（不影响已生成的报告）: ${e.message.substring(0, 100)}`);
  }
}

main().catch(console.error);
