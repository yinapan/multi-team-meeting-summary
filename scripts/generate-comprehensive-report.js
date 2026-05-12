const fs = require('fs');
const path = require('path');
const {
  C, FONT, hCell, cCell, bullet, h1, h2, h3, p, pb,
  makeHeader, makeFooter, makeCoverPage,
  cleanText, isValidConclusion, makeSuggestion, textSimilar, dedupTexts, analyzeDocs,
  generateStrategicAnalysis, callLLM, buildComprehensiveReportPrompt, parseReportMarkdown,
  docStyles, docNumbering, resolveWorkspaceDir, normalizeDate, formatDateChinese, dateInRange,
  isMultiSourceTeam, getMultiSourceTeamNames, groupByLabel,
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, PageNumber
} = require('./shared');

function isMultiSource(td, multiSourceSet) {
  if (!multiSourceSet.has(td.teamName)) return false;
  const labels = new Set(td.data.documents.map(d => d.sourceLabel).filter(Boolean));
  return labels.size > 1;
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

// ========== 规则回退：生成 1.2-5 章节 ==========
function buildFallbackContent(teamDataList, allHighRisks, allMidRisks, opts) {
  const { grandTotalDocs, multiSourceSet } = opts;
  const elements = [];

  // 1.2 主要趋势
  elements.push(h2("1.2 主要趋势"));
  const trendItems = [];
  teamDataList.forEach(td => {
    if (isMultiSource(td, multiSourceSet)) {
      const groups = groupByLabel(td.data.documents, td.teamName);
      for (const [label, docs] of groups) {
        const labelAnalysis = analyzeDocs(docs, `${td.teamName}-${label}`, opts);
        for (const t of (labelAnalysis.trends || []).slice(0, 2)) {
          trendItems.push({ team: `${td.teamName}·${label}`, text: t });
        }
      }
    } else {
      for (const t of (td.analysis.trends || []).slice(0, 3)) {
        trendItems.push({ team: td.teamName, text: t });
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
    dedupTexts(teamDataList.flatMap(td => td.analysis.allConclusions.slice(0, 3))).slice(0, 5).forEach(c => elements.push(bullet(c.substring(0, 150))));
  }

  // 二、风险点分析
  elements.push(pb(), h1("二、风险点分析"));
  elements.push(p("基于本期会议记录的综合分析，识别出以下需要重点关注的风险点："));
  elements.push(h2("2.1 高风险事项"));
  if (allHighRisks.length > 0) {
    allHighRisks.slice(0, 10).forEach(r => {
      const prefix = r.label ? `${r.team}·${r.label}` : r.team;
      elements.push(bullet(`${prefix}${r.text}`, { bold: '【高】' }));
    });
  } else {
    elements.push(p("本期会议记录中未发现高风险事项。", { color: C.gray }));
  }
  elements.push(h2("2.2 中风险事项"));
  if (allMidRisks.length > 0) {
    allMidRisks.slice(0, 10).forEach(r => {
      const prefix = r.label ? `${r.team}·${r.label}` : r.team;
      elements.push(bullet(`${prefix}${r.text}`, { bold: '【中】' }));
    });
  } else {
    elements.push(p("本期会议记录中未发现中风险事项。", { color: C.gray }));
  }
  elements.push(h2("2.3 风险矩阵"));
  const allRisksForMatrix = [
    ...allHighRisks.slice(0, 8).map(r => ({ text: r.text.substring(0, 60), level: '高', scope: r.label ? `${r.team}·${r.label}` : r.team })),
    ...allMidRisks.slice(0, 5).map(r => ({ text: r.text.substring(0, 60), level: '中', scope: r.label ? `${r.team}·${r.label}` : r.team }))
  ];
  if (allRisksForMatrix.length > 0) {
    elements.push(new Table({ columnWidths: [3500, 1800, 3726], rows: [
      new TableRow({ tableHeader: true, children: [hCell("风险项", 3500), hCell("等级", 1800), hCell("影响范围", 3726)] }),
      ...allRisksForMatrix.map(r => new TableRow({ children: [cCell(r.text, 3500), cCell(r.level, 1800, { bold: true, color: r.level === '高' ? C.red : C.orange }), cCell(r.scope, 3726)] }))
    ]}));
  }

  // 三、重点关注节点
  elements.push(pb(), h1("三、重点关注节点"));
  elements.push(p("根据会议记录中的决议事项，以下节点需要重点关注与跟进："));
  elements.push(h2("3.1 近期节点（本月内）"));
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
    elements.push(new Table({ columnWidths: [1600, 2200, 5226], rows: [
      new TableRow({ tableHeader: true, children: [hCell("时间节点", 1600), hCell("责任方", 2200), hCell("关键事项", 5226)] }),
      ...allNear.map(n => {
        const owner = n.label ? `${n.team}·${n.label}` : (n.owner || n.team);
        return new TableRow({ children: [cCell(n.dateStr, 1600), cCell(owner, 2200), cCell(n.text.substring(0, 100), 5226)] });
      })
    ]}));
  } else {
    elements.push(p("本月内暂无明确时间节点。", { color: C.gray }));
  }
  elements.push(h2("3.2 中期节点（未来两个月）"));
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
    elements.push(new Table({ columnWidths: [1600, 2200, 5226], rows: [
      new TableRow({ tableHeader: true, children: [hCell("时间节点", 1600), hCell("责任方", 2200), hCell("关键事项", 5226)] }),
      ...allMidNodes.map(n => {
        const owner = n.label ? `${n.team}·${n.label}` : (n.owner || n.team);
        return new TableRow({ children: [cCell(n.dateStr, 1600), cCell(owner, 2200), cCell(n.text.substring(0, 100), 5226)] });
      })
    ]}));
  } else {
    elements.push(p("未来两个月暂无明确时间节点。", { color: C.gray }));
  }
  elements.push(h2("3.3 持续跟进事项"));
  const nodeTexts = [...allNear, ...allMidNodes].map(n => n.text);
  const followItems = [];
  teamDataList.forEach(td => {
    if (td.labelAnalyses) {
      for (const [label, la] of td.labelAnalyses) {
        const filtered = la.allTodos.filter(t => !nodeTexts.some(nt => textSimilar(t, nt) > 0.6));
        dedupTexts(filtered).slice(0, 3).forEach(t => followItems.push({ team: `${td.teamName}·${label}`, text: t }));
      }
    } else {
      const filtered = td.analysis.allTodos.filter(t => !nodeTexts.some(nt => textSimilar(t, nt) > 0.6));
      dedupTexts(filtered).slice(0, 4).forEach(t => followItems.push({ team: td.teamName, text: t }));
    }
  });
  followItems.slice(0, 10).forEach(it => elements.push(bullet(it.text.substring(0, 100), { bold: `【${it.team}】` })));

  elements.push(...buildFallbackSection4(teamDataList));
  elements.push(...buildFallbackSection5(teamDataList, grandTotalDocs));

  return elements;
}

function buildFallbackSection4(teamDataList) {
  const elements = [];
  elements.push(pb(), h1("四、各团队会议汇总"));
  elements.push(p("本章节按团队进行划分，详细列出各模块的会议统计、核心议题与关键决议。"));
  teamDataList.forEach(td => {
    elements.push(h2(td.teamName));
    if (td.labelGroups && td.labelGroups.size > 1) {
      elements.push(p(`本团队包含 ${td.labelGroups.size} 个子项目：${[...td.labelGroups.keys()].join('、')}，共 ${td.data.documents.length} 份会议记录。`));
      for (const [label, docs] of td.labelGroups) {
        elements.push(h3(`${label}（${docs.length}份）`));
        elements.push(p("核心议题：", { bold: true }));
        dedupTexts(docs.flatMap(d => (d.conclusions || []).slice(0, 3).map(c => cleanText(c)).filter(isValidConclusion))).slice(0, 6).forEach(c => elements.push(bullet(c.substring(0, 150), { bold: `【${label}】` })));
        elements.push(p("关键决议：", { bold: true }));
        dedupTexts(docs.flatMap(d => (d.todos || []).slice(0, 3).map(t => cleanText(t)).filter(isValidConclusion))).slice(0, 6).forEach(t => elements.push(bullet(t.substring(0, 150), { bold: `【${label}】` })));
      }
    } else {
      elements.push(h3("会议统计"));
      elements.push(p(`会议数量：${td.data.documents.length}份${td.analysis.importantCount > 0 ? `（其中重要会议${td.analysis.importantCount}份）` : ''}`, { bold: true }));
      elements.push(h3("核心议题"));
      dedupTexts(td.data.documents.flatMap(d => (d.conclusions || []).slice(0, 3).map(c => cleanText(c)).filter(isValidConclusion))).slice(0, 8).forEach(c => elements.push(bullet(c.substring(0, 150))));
      elements.push(h3("关键决议"));
      dedupTexts(td.data.documents.flatMap(d => (d.todos || []).slice(0, 3).map(t => cleanText(t)).filter(isValidConclusion))).slice(0, 8).forEach(t => elements.push(bullet(t.substring(0, 150))));
    }
  });
  return elements;
}

function buildFallbackSection5(teamDataList, grandTotalDocs) {
  const elements = [];
  elements.push(pb(), h1("五、综合评估与建议"));
  elements.push(p(`基于本期${grandTotalDocs}份会议记录的综合分析，提出以下跨部门、跨项目的战略性评估与行动建议：`));
  const strategic = generateStrategicAnalysis(teamDataList);
  strategic.forEach((item, idx) => {
    elements.push(h2(`5.${idx + 1} ${item.name}`));
    elements.push(p(item.overview));
    const high = item.teamStats.filter(t => t.level === 'high');
    const mid = item.teamStats.filter(t => t.level === 'mid');
    const low = item.teamStats.filter(t => t.level === 'low');
    if (high.length > 0) {
      const desc = high.map(t => `${t.team}（${t.meetingHits}场/${t.pct}%，${t.examples.slice(0, 2).join('；')}）`).join('、');
      elements.push(bullet(`涉及较深：${desc}`, { bold: '推进较好：' }));
    }
    if (mid.length > 0) {
      const desc = mid.map(t => `${t.team}（${t.meetingHits}场/${t.pct}%，${t.examples.slice(0, 2).join('；')}）`).join('、');
      elements.push(bullet(`有涉及但深度有限：${desc}`, { bold: '推进一般：' }));
    }
    if (low.length > 0) {
      const desc = low.map(t => `${t.team}（${t.meetingHits}场/${t.pct}%）`).join('、');
      elements.push(bullet(`仅少量提及：${desc}`, { bold: '待加强：' }));
    }
    if (item.nodeDetail) {
      elements.push(p('各团队近期关键节点：'));
      for (const [team, nodes] of Object.entries(item.nodeDetail)) {
        elements.push(bullet(nodes.join('；'), { bold: `${team}：` }));
      }
    }
    elements.push(p(`建议：${item.suggestion}`, { bold: true }));
  });
  return elements;
}

// ========== 主函数 ==========
async function main() {
  const args = process.argv.slice(2);
  const startDate = normalizeDate(args[0] || "04-13");
  const endDate = normalizeDate(args[1] || "04-26");
  const workspaceDir = resolveWorkspaceDir();
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));

  const multiSourceNames = getMultiSourceTeamNames(config);
  const multiSourceSet = new Set(multiSourceNames);

  const teamDataList = [];
  let grandTotalDocs = 0, grandTotalScanned = 0, grandTotalConclusions = 0, grandTotalTodos = 0;
  let allHighRisks = [], allMidRisks = [];

  for (const team of config.teams) {
    const dataFile = path.join(workspaceDir, `team-summary-${team.name}.json`);
    let data;
    if (fs.existsSync(dataFile)) {
      data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    } else {
      const allFile = path.join(workspaceDir, 'all-team-summaries.json');
      if (!fs.existsSync(allFile)) { console.log(`跳过 ${team.name}：无数据文件`); continue; }
      const allData = JSON.parse(fs.readFileSync(allFile, 'utf-8'));
      const teamEntry = allData.find(t => t.team === team.name);
      if (!teamEntry) { console.log(`跳过 ${team.name}：未找到团队数据`); continue; }
      const documents = [];
      for (const wData of Object.values(teamEntry.weeks)) {
        for (const m of wData.meetings) {
          documents.push({ name: m.title, conclusions: m.conclusions || [], todos: m.todos || [], important: m.important, rawContent: m.rawContent || '', sourceLabel: m.sourceLabel || null });
        }
      }
      data = { team: team.name, documents };
    }
    data.documents = data.documents.filter(d => dateInRange(d.name, startDate, endDate));
    if (data.documents.length === 0) { console.log(`跳过 ${team.name}：日期范围内无文档`); continue; }
    const analysis = analyzeDocs(data.documents, team.name, { startDate, endDate });

    const tdEntry = { teamName: team.name, data, analysis };

    if (multiSourceSet.has(team.name)) {
      const groups = groupByLabel(data.documents, team.name);
      if (groups.size > 1) {
        tdEntry.labelGroups = groups;
        tdEntry.labelAnalyses = new Map();
        for (const [label, docs] of groups) {
          const la = analyzeDocs(docs, `${team.name}-${label}`, { startDate, endDate });
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

  const teamCount = teamDataList.length;
  const inclusionRate = grandTotalScanned > 0 ? Math.round((grandTotalDocs / grandTotalScanned) * 100) : 100;
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  // === 读取团队 LLM 摘要（两阶段模式） ===
  const teamSummaries = {};
  for (const td of teamDataList) {
    const summaryFile = path.join(workspaceDir, `team-llm-summary-${td.teamName}.md`);
    if (fs.existsSync(summaryFile)) {
      teamSummaries[td.teamName] = fs.readFileSync(summaryFile, 'utf-8');
      console.log(`[${td.teamName}] 使用已有 LLM 摘要 (${(teamSummaries[td.teamName].length / 1024).toFixed(1)}KB)`);
    }
  }
  const hasSummaries = Object.keys(teamSummaries).length > 0;

  // === LLM 生成全部分析内容（1.2-5章），回退到规则分析 ===
  let analyticalElements;
  let llmTruncated = false;
  const prompt = buildComprehensiveReportPrompt(teamDataList, {
    startDate, endDate, grandTotalDocs, teamCount,
    teamSummaries: hasSummaries ? teamSummaries : undefined,
    multiSourceTeamNames: multiSourceNames
  });
  console.log(`调用 LLM 生成全部分析（${(prompt.length / 1024).toFixed(1)}KB prompt${hasSummaries ? '，两阶段模式' : ''}）...`);
  const llmResult = await callLLM(prompt, config);
  if (llmResult) {
    console.log(`LLM 返回 ${(llmResult.length / 1024).toFixed(1)}KB，解析中...`);
    const summaryFile = path.join(workspaceDir, `comprehensive-llm-summary-${startDate.replace(/\-/g, '')}-${endDate.replace(/\-/g, '')}.md`);
    fs.writeFileSync(summaryFile, llmResult, 'utf-8');
    console.log(`LLM 原始输出已保存: ${path.basename(summaryFile)}`);
    const hasSection5 = /^#\s+五|^##\s*5[.、]/.test(llmResult) || /综合评估|建议/.test(llmResult.substring(llmResult.length - 2000));
    if (!hasSection5) {
      console.log('⚠️ LLM 输出可能被截断（缺少第五部分），将用规则分析补充缺失章节');
      llmTruncated = true;
    }
    analyticalElements = parseReportMarkdown(llmResult);
  }
  if (!analyticalElements || analyticalElements.length === 0) {
    console.log('LLM 不可用或返回为空，使用规则分析...');
    analyticalElements = buildFallbackContent(teamDataList, allHighRisks, allMidRisks, { grandTotalDocs, startDate, endDate, multiSourceSet });
  } else if (llmTruncated) {
    const hasFourInLlm = llmResult && /^#\s+四|各.*团队.*会议汇总/m.test(llmResult);
    const hasFiveInLlm = llmResult && /^#\s+五|综合评估与建议/m.test(llmResult);
    if (!hasFourInLlm) {
      console.log('补充第四、五部分（规则回退）...');
      analyticalElements.push(...buildFallbackSection4(teamDataList));
      analyticalElements.push(...buildFallbackSection5(teamDataList, grandTotalDocs));
    } else if (!hasFiveInLlm) {
      console.log('补充第五部分（综合评估与建议，规则回退）...');
      analyticalElements.push(...buildFallbackSection5(teamDataList, grandTotalDocs));
    }
  }

  const dateLabel = `${now.getFullYear()}年${formatDateChinese(startDate)} - ${formatDateChinese(endDate)}`;
  const coverSection = makeCoverPage({
    title1: '会议记录', title2: '汇总分析报告',
    subtitle: '（综合版）',
    dateRange: dateLabel,
    stats: [`共收录 ${grandTotalDocs} 份会议记录`, `覆盖 ${teamCount} 个团队`],
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
          h1("一、执行摘要"),
          h2("1.1 核心发现"),
          new Table({ columnWidths: [3000, 6026], rows: [
            new TableRow({ tableHeader: true, children: [hCell("统计项", 3000), hCell("数值", 6026)] }),
            new TableRow({ children: [cCell("会议记录总数", 3000), cCell(`${grandTotalDocs}份`, 6026)] }),
            new TableRow({ children: [cCell("覆盖团队数", 3000), cCell(`${teamCount}个`, 6026)] }),
            new TableRow({ children: [cCell("时间跨度", 3000), cCell(`${now.getFullYear()}.${startDate} - ${endDate}`, 6026)] }),
            new TableRow({ children: [cCell("核心议题数量", 3000), cCell(`${grandTotalConclusions}`, 6026)] }),
            new TableRow({ children: [cCell("关键决议数量", 3000), cCell(`${grandTotalTodos}`, 6026)] })
          ]}),
          new Paragraph({ spacing: { before: 200 }, children: [] }),
          p(`本报告涵盖${teamDataList.map(t => t.teamName).join('、')}共${teamCount}个团队，共收录${grandTotalDocs}份会议记录。所有内容均基于实际会议记录文档提取，团队分类严格按配置映射关系归类。`),

          ...analyticalElements,

          pb(),
          h1("六、附录：会议清单与文档纳入率"),
          h2("团队汇总"),
          new Table({ columnWidths: [2200, 2400, 1200, 1200, 2026], rows: [
            new TableRow({ tableHeader: true, children: [hCell("团队", 2200), hCell("主要会议类型", 2400), hCell("文档数", 1200), hCell("结论数", 1200), hCell("待办数", 2026)] }),
            ...teamDataList.map(td => new TableRow({ children: [
              cCell(td.teamName, 2200),
              cCell([...new Set(td.data.documents.map(d => {
                const n = d.name;
                if (n.includes('AI')) return 'AI组';
                if (n.includes('平台')) return '平台组';
                if (n.includes('质量')) return '质量周会';
                if (n.includes('测试')) return '测试周会';
                if (n.includes('项目')) return '项目优化';
                return '其他';
              }))].join('、'), 2400),
              cCell(`${td.data.documents.length}份`, 1200),
              cCell(`${td.analysis.totalConclusions}`, 1200),
              cCell(`${td.analysis.totalTodos}`, 2026)
            ]}))
          ]}),
          new Paragraph({ spacing: { before: 300 }, children: [] }),
          h2("纳入率统计"),
          new Table({ columnWidths: [3000, 3013, 3013], rows: [
            new TableRow({ tableHeader: true, children: [hCell("统计项", 3000), hCell("数值", 3013), hCell("说明", 3013)] }),
            new TableRow({ children: [cCell("日期范围内文档数", 3000), cCell(`${grandTotalScanned}份`, 3013, { bold: true }), cCell("用户输入日期内所有文件", 3013)] }),
            new TableRow({ children: [cCell("已纳入分析文档数", 3000), cCell(`${grandTotalDocs}份`, 3013, { bold: true }), cCell("成功解析的文档", 3013)] }),
            new TableRow({ children: [cCell("文档纳入率", 3000), cCell(`${inclusionRate}%`, 3013, { bold: true }), cCell(`${grandTotalDocs}/${grandTotalScanned}`, 3013)] })
          ]}),
          new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "— 报告完 —", color: C.gray, size: 20, font: FONT })] })
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  const outFile = path.join(workspaceDir, `综合分析报告-${startDate.replace(/\-/g, '')}-${endDate.replace(/\-/g, '')}.docx`);
  try {
    fs.writeFileSync(outFile, buffer);
  } catch (e) {
    if (e.code === 'EBUSY') {
      const ts = new Date().toISOString().replace(/[T:]/g, '-').substring(0, 16);
      const altFile = path.join(workspaceDir, `综合分析报告-${startDate.replace(/\-/g, '')}-${endDate.replace(/\-/g, '')}-${ts}.docx`);
      fs.writeFileSync(altFile, buffer);
      console.log(`原文件被占用，已另存为: ${path.basename(altFile)}`);
      console.log(`综合报告已生成: ${(buffer.length / 1024).toFixed(1)}KB -> ${path.basename(altFile)}`);
      return;
    }
    throw e;
  }
  console.log(`综合报告已生成: ${(buffer.length / 1024).toFixed(1)}KB -> ${path.basename(outFile)}`);
}

main().catch(console.error);
