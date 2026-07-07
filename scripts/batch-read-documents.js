const fs = require('fs');
const path = require('path');
const { resolveWorkspaceDir, getWeekKey, normalizeDate, dateInRange, extractMeetingDate, teamDocsCacheDir, treeDocCacheFile, ensureCacheDir, readCache, scanAllTeams, RequestPacer, extractInfo, getKdocsConfig, outputPath, writeOutputJson, writeMeetingBaseline, readDocAsync, runPool, filterAnalyzableMeetings, isConfidentialMeetingTitle, isImportantMeetingTitle, sortImportantMeetingsFirst } = require('./shared');

const CONCURRENCY = Number(getKdocsConfig().documentConcurrency) || 5;

function writeRunDiagnostics(workspaceDir, pacer, failedDocuments, startedAt, warmCacheOnly) {
  const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  const stats = {
    mode: warmCacheOnly ? 'warm-cache' : 'normal',
    elapsedSec,
    failedDocuments: failedDocuments.length,
    ...(pacer && typeof pacer.getStats === 'function' ? pacer.getStats() : {})
  };
  if (stats.cacheRebuildUsed) stats.mode = 'cache-rebuild';

  const statsFile = writeOutputJson('batch-read-stats.json', stats);

  const failedFile = writeOutputJson('failed-documents.json', failedDocuments);

  console.log(`stats: ${statsFile}`);
  console.log(`failed-documents: ${failedFile} (${failedDocuments.length})`);
  console.log(`API requests: total=${stats.requests || 0}, search=${stats.searchRequests || 0}, list=${stats.listRequests || 0}, read=${stats.readRequests || 0}`);
  console.log(`limits/retries/cache: 429=${stats.rateLimits || 0}, retries=${stats.retries || 0}, staleCache=${stats.staleCacheFallbacks || 0}, cacheHit=${stats.cacheHits || 0}, apiFetch=${stats.apiFetches || 0}`);
  if (stats.cacheRebuildUsed) {
    console.log('⚠️ 检测到 KDocs 限流，已使用缓存数据继续生成。限流解除后请重新跑数据以刷新最新内容。');
  }
  console.log(`current interval: ${stats.currentIntervalMs || 0}ms`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || !args[1]) {
    console.error('用法: node batch-read-documents.js <start_date> <end_date> [--warm-cache] [--resume]');
    console.error('示例: node batch-read-documents.js 03-10 04-30');
    console.error('      node batch-read-documents.js 03-10 04-30 --resume   断点续传');
    process.exit(1);
  }
  const warmCacheOnly = args.includes('--warm-cache');
  const resume = args.includes('--resume');
  const applyReportAnalysisFilter = args.includes('--report-analysis-filter') || process.env.APPLY_REPORT_ANALYSIS_FILTER === '1';
  const startDate = normalizeDate(args[0]);
  const endDate = normalizeDate(args[1]);
  const overallStartTime = Date.now();

  const workspaceDir = resolveWorkspaceDir();
  const configFile = path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

  const importantPeople = config.important_people || [];
  const allTeamsData = [];
  const failedDocuments = [];
  const pacer = new RequestPacer();

  const scannedTeams = await scanAllTeams(config, startDate, endDate, pacer, { includeAll: true, resume });

  for (const scanned of scannedTeams) {
    const teamCfg = config.teams.find(t => t.name === scanned.team);
    if (!teamCfg) continue;
    console.log(`\n===== ${teamCfg.name} =====`);
    const scannedFiles = scanned.files || [];
    const confidentialFiles = applyReportAnalysisFilter ? scannedFiles.filter(f => isConfidentialMeetingTitle(f.name)) : [];
    const allFiles = applyReportAnalysisFilter ? filterAnalyzableMeetings(scannedFiles) : scannedFiles;
    if (applyReportAnalysisFilter && confidentialFiles.length > 0) {
      console.log(`  已跳过 ${confidentialFiles.length} 篇标题含【保密】的会议记录，不读取正文且不纳入统计`);
    }

    const candidateCount = allFiles.length;
    if (candidateCount === 0) {
      console.log('  无匹配文件，跳过');
      allTeamsData.push({ team: teamCfg.name, documents: [], totalScanned: 0, meetingListCount: 0, unreadableMeetings: [], excludedMeetings: [] });
      continue;
    }

    console.log(`并发读取 ${candidateCount} 篇候选文档 (并发数: ${CONCURRENCY})...`);
    if (warmCacheOnly) console.log('  warm-cache mode: preloading caches without overwriting summary outputs');
    ensureCacheDir(teamCfg.name);
    let cacheHit = 0, apiFetch = 0;
    const startTime = Date.now();

    // 预过滤：文件名日期明确超出范围且 folderName 也无匹配日期 → 跳过 API 读取
    const preFilteredOut = [];
    const preFilteredFiles = allFiles.filter(f => {
      if (dateInRange(f.name, startDate, endDate, '', null, null, f.folderName)) return true;
      preFilteredOut.push(f);
      return false;
    });
    if (preFilteredOut.length > 0) {
      console.log(`  预过滤: ${allFiles.length} → ${preFilteredFiles.length} 篇 (跳过 ${preFilteredOut.length} 篇明显超出范围的文档，节省 API 调用)`);
    }

    const tasks = preFilteredFiles.map((f, i) => () => {
      // 树形缓存优先，扁平兜底
      const cacheFile = (f.folderPath || f.folderName)
        ? treeDocCacheFile(teamCfg.name, f.folderPath || f.folderName, f.id)
        : path.join(teamDocsCacheDir(teamCfg.name), `${f.id}.json`);
      const flatFile = path.join(teamDocsCacheDir(teamCfg.name), `${f.id}.json`);
      let cached = readCache(cacheFile);
      if (!cached) cached = readCache(flatFile);
      const isCached = cached && cached.mtime === f.mtime;
      if (isCached) {
        cacheHit++;
        if (pacer && typeof pacer.noteCacheHit === 'function') pacer.noteCacheHit();
      } else {
        apiFetch++;
        if (pacer && typeof pacer.noteApiFetch === 'function') pacer.noteApiFetch();
      }

      return readDocAsync(f.drive_id, f.id, f.mtime, teamCfg.name, pacer, f.link || '', f.ctime, f.folderName, f.folderPath || f.folderName).then(md => {
        f._readContent = md || '';
        if (!md) {
          failedDocuments.push({
            team: teamCfg.name,
            sourceLabel: f.sourceLabel || null,
            name: f.name,
            id: f.id,
            drive_id: f.drive_id,
            url: f.link || '',
            mtime: f.mtime || null
          });
          return null;
        }
        if (!dateInRange(f.name, startDate, endDate, md, f.mtime, f.ctime, f.folderName)) return null;
        if (warmCacheOnly) return null;
        const teamPeople = teamCfg.leader ? [...importantPeople, teamCfg.leader] : importantPeople;
        const info = extractInfo(md, f.name, teamPeople);
        if (applyReportAnalysisFilter) {
          info.important = info.important || isImportantMeetingTitle(f.name);
        }
        info.meetingDate = extractMeetingDate(f.name, md, null, f.ctime, f.folderName) || null;
        info.id = f.id;
        info.drive_id = f.drive_id;
        info.url = f.link;
        info.sourceLabel = f.sourceLabel || null;
        info.mtime = f.mtime || null;
        info.ctime = f.ctime || null;
        info.folderName = f.folderName || null;
        const num = i + 1;
        if (num % 5 === 0 || num === preFilteredFiles.length) {
          process.stdout.write(`  进度: ${num}/${preFilteredFiles.length}\r`);
        }
        return info;
      });
    });

    const rawResults = await runPool(tasks, CONCURRENCY);
    const documents = applyReportAnalysisFilter
      ? sortImportantMeetingsFirst(rawResults.filter(Boolean))
      : rawResults.filter(Boolean);

    // 不可读文件也作为占位文档纳入，确保看板和报告不丢失记录
    for (const f of allFiles) {
      if (!failedDocuments.some(fd => fd.id === f.id && fd.team === teamCfg.name)) continue;
      if (documents.find(d => d.id === f.id)) continue;
      if (!dateInRange(f.name, startDate, endDate, '', f.mtime, f.ctime, f.folderName)) continue;
      documents.push({
        name: f.name,
        id: f.id,
        drive_id: f.drive_id,
        url: f.link || '',
        sourceLabel: f.sourceLabel || null,
        mtime: f.mtime || null,
        ctime: f.ctime || null,
        folderName: f.folderName || null,
        meetingDate: extractMeetingDate(f.name, '', f.mtime, f.ctime, f.folderName) || null,
        participants: [],
        meetingTime: null,
        conclusions: [],
        todos: [],
        important: applyReportAnalysisFilter ? isImportantMeetingTitle(f.name) : null,
        rawContent: '',
        unreadable: true
      });
    }
    const analyzedIds = new Set(documents.map(doc => doc.id).filter(Boolean));
    const failedKeys = new Set(failedDocuments.filter(doc => doc.team === teamCfg.name).map(doc => doc.id).filter(Boolean));
    const meetingListItems = allFiles
      .filter(f => dateInRange(f.name, startDate, endDate, f._readContent || '', f.mtime, f.ctime, f.folderName))
      .map(f => ({ name: f.name, id: f.id, url: f.link || '', sourceLabel: f.sourceLabel || null }));
    const unreadableMeetingItems = allFiles
      .filter(f => failedKeys.has(f.id) && dateInRange(f.name, startDate, endDate, '', null, f.ctime, f.folderName))
      .map(f => ({ name: f.name, id: f.id, url: f.link || '', sourceLabel: f.sourceLabel || null, unreadable: true, folderName: f.folderName || null, ctime: f.ctime || null }));
    const excludedMeetings = allFiles
      .filter(f => !meetingListItems.some(item => item.id === f.id) && !failedKeys.has(f.id))
      .map(f => ({ name: f.name, id: f.id, url: f.link || '', reason: preFilteredOut.some(p => p.id === f.id) ? 'pre_filtered_out_of_date_range' : 'out_of_date_range_after_content_check' }));
    const diagnosticExcludedMeetings = excludedMeetings.slice(0, 50);
    const unreadableMeetings = allFiles
      .filter(f => failedKeys.has(f.id))
      .map(f => ({ name: f.name, id: f.id, url: f.link || '', reason: 'read_failed' }));
    const unreadableIds = new Set(unreadableMeetingItems.map(m => m.id).filter(Boolean));
    const allMeetingItems = [...meetingListItems.filter(m => !unreadableIds.has(m.id)), ...unreadableMeetingItems];
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  完成: ${documents.length} 篇, 耗时 ${elapsed}s [cache] 命中 ${cacheHit} 篇, API 拉取 ${apiFetch} 篇`);

    allTeamsData.push({
      team: teamCfg.name,
      documents,
      totalScanned: allMeetingItems.length,
      scanCandidateCount: candidateCount,
      meetingListCount: allMeetingItems.length,
      meetingListItems: allMeetingItems,
      unreadableMeetings,
      excludedMeetings: diagnosticExcludedMeetings,
      excludedMeetingCount: excludedMeetings.length,
      confidentialMeetingCount: confidentialFiles.length
    });
  }

  // 按周分组保存为 all-team-summaries 格式
  if (warmCacheOnly) {
    writeRunDiagnostics(workspaceDir, pacer, failedDocuments, overallStartTime, warmCacheOnly);
    console.log('warm-cache complete; summary outputs were not overwritten.');
    return;
  }

  const teamSummaries = allTeamsData.map(td => {
    const weeks = {};
    for (const doc of td.documents) {
      const weekKey = getWeekKey(doc.name, '', doc.meetingDate);
      if (!weeks[weekKey]) weeks[weekKey] = { meetings: [], allConclusions: [], allTodos: [] };
      weeks[weekKey].meetings.push({
        title: doc.name.replace(/\.(\w+)$/i, ''),
        url: doc.url || '',
        participants: doc.participants,
        meetingTime: doc.meetingTime,
        conclusions: doc.conclusions,
        todos: doc.todos,
        important: doc.important,
        rawContent: doc.rawContent || '',
        sourceLabel: doc.sourceLabel || null,
        meetingDate: doc.meetingDate || null
      });
      weeks[weekKey].allConclusions.push(...doc.conclusions);
      weeks[weekKey].allTodos.push(...doc.todos);
    }
    for (const m of (td.unreadableMeetings || [])) {
      const doc = td.documents.find(d => d.id === m.id);
      if (doc) continue;
      const weekKey = getWeekKey(m.name, '', null, null, m.ctime || null, m.folderName || null);
      if (weekKey === 'unknown') continue;
      if (!weeks[weekKey]) weeks[weekKey] = { meetings: [], allConclusions: [], allTodos: [] };
      weeks[weekKey].meetings.push({
        title: m.name.replace(/\.(\w+)$/i, ''),
        url: m.url || '',
        participants: [],
        meetingTime: null,
        conclusions: [],
        todos: [],
        important: null,
        rawContent: '',
        sourceLabel: m.sourceLabel || null,
        meetingDate: extractMeetingDate(m.name, '', null, m.ctime || null, m.folderName || null) || null
      });
    }
    return { team: td.team, weeks };
  });

  const outFile = writeOutputJson('all-team-summaries.json', teamSummaries);
  console.log(`\n已保存: ${outFile}`);

  // 同时保存每个团队的独立数据文件（供报告生成脚本使用）
  for (const td of allTeamsData) {
    const teamFile = writeOutputJson(`team-summary-${td.team}.json`, td);
    console.log(`  -> ${teamFile}`);
  }

  const { baseline, file: baselineFile } = writeMeetingBaseline(allTeamsData, {
    startDate,
    endDate,
    source: 'batch-read-documents',
    applyMeetingTitleFilters: applyReportAnalysisFilter
  });
  console.log(`baseline: ${baselineFile}`);
  console.log(`counts: meetingList=${baseline.counts.meetingListCount}, successfulRead=${baseline.counts.successfulReadCount}, analyzed=${baseline.counts.analyzedDocumentCount}`);

  const totalDocs = allTeamsData.reduce((sum, t) => sum + t.documents.length, 0);
  const overallElapsed = ((Date.now() - overallStartTime) / 1000).toFixed(1);
  writeRunDiagnostics(workspaceDir, pacer, failedDocuments, overallStartTime, warmCacheOnly);
  console.log(`总耗时: ${overallElapsed}s`);
  console.log(`\n汇总: ${config.teams.length} 个团队, ${totalDocs} 篇文档`);
}

if (require.main === module) {
  main().catch(console.error);
}
