const fs = require('fs');
const path = require('path');
const { resolveWorkspaceDir, getWeekKey, normalizeDate, dateInRange, teamDocsCacheDir, ensureCacheDir, readCache, writeCache, getTeamScanEntries, scanFilesByMode, dedupeKdocsFiles, RequestPacer, extractInfo, getKdocsConfig, getKdocsScanMode, getKdocsCliPath, getKdocsCliEnv, getKdocsCliArgs, outputPath, writeOutputJson, writeMeetingBaseline } = require('./shared');

const CONCURRENCY = Number(getKdocsConfig().documentConcurrency) || 5;

async function readDocOnceAsync(driveId, fileId, mtime, teamName, pacer) {
  const cacheFile = path.join(teamDocsCacheDir(teamName), `${fileId}.json`);
  const cached = readCache(cacheFile);
  if (cached && cached.mtime === mtime) {
    return cached.content;
  }

  if (pacer) await pacer.acquire();
  return new Promise((resolve) => {
    let released = false;
    const release = () => {
      if (!released && pacer) {
        released = true;
        pacer.release();
      }
    };
    const inputJson = JSON.stringify({ drive_id: driveId, file_id: fileId, format: "markdown", include_elements: "para" });
    if (pacer && typeof pacer.noteRequest === 'function') pacer.noteRequest('read');
    const child = require('child_process').spawn(getKdocsCliPath(), getKdocsCliArgs(['drive', 'read-file-content', '--output', 'json']), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: getKdocsCliEnv()
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); }, 30000);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      release();
      if (code !== 0 || !stdout) {
        if (stderr) process.stderr.write(`[readDoc] 失败 file=${fileId}: ${stderr.substring(0, 100)}\n`);
        if (cached && cached.content) {
          if (pacer && typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
          process.stderr.write(`[readDoc] stale cache fallback file=${fileId}\n`);
          resolve(cached.content);
          return;
        }
        resolve('');
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (result && result.code && result.code !== 0) {
          if ([429001, 429002, 429003].includes(result.code) && pacer && typeof pacer.noteRateLimit === 'function') {
            pacer.noteRateLimit();
          }
          process.stderr.write(`[readDoc] API error file=${fileId} code=${result.code}\n`);
          if (cached && cached.content) {
            if (pacer && typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
            process.stderr.write(`[readDoc] stale cache fallback file=${fileId}\n`);
            resolve(cached.content);
            return;
          }
          resolve('');
          return;
        }
        const content = (result && result.data && result.data.data && result.data.data.markdown) || '';
        if (content) {
          if (pacer && typeof pacer.noteSuccess === 'function') pacer.noteSuccess();
          writeCache(cacheFile, { content, mtime, fetched_at: Date.now() });
        }
        resolve(content);
      } catch (e) {
        process.stderr.write(`[readDoc] JSON解析失败 file=${fileId}: ${e.message.substring(0, 80)}\n`);
        if (cached && cached.content) {
          if (pacer && typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
          process.stderr.write(`[readDoc] stale cache fallback file=${fileId}\n`);
          resolve(cached.content);
          return;
        }
        resolve('');
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      release();
      process.stderr.write(`[readDoc] 启动失败 file=${fileId}: ${e.message.substring(0, 100)}\n`);
      if (cached && cached.content) {
        if (pacer && typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
        process.stderr.write(`[readDoc] stale cache fallback file=${fileId}\n`);
        resolve(cached.content);
        return;
      }
      resolve('');
    });
    child.stdin.write(inputJson);
    child.stdin.end();
  });
}

async function readDocAsync(driveId, fileId, mtime, teamName, pacer) {
  const maxAttempts = Number(getKdocsConfig().documentReadRetries) || 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const content = await readDocOnceAsync(driveId, fileId, mtime, teamName, pacer);
    if (content || attempt === maxAttempts - 1) return content;
    if (pacer && typeof pacer.noteRetry === 'function') pacer.noteRetry();
    const delay = Math.min(3000 * Math.pow(2, attempt), 15000) + Math.floor(Math.random() * 500);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return '';
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function writeRunDiagnostics(workspaceDir, pacer, failedDocuments, startedAt, warmCacheOnly) {
  const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  const stats = {
    mode: warmCacheOnly ? 'warm-cache' : 'normal',
    elapsedSec,
    failedDocuments: failedDocuments.length,
    ...(pacer && typeof pacer.getStats === 'function' ? pacer.getStats() : {})
  };

  const statsFile = writeOutputJson('batch-read-stats.json', stats);

  const failedFile = writeOutputJson('failed-documents.json', failedDocuments);

  console.log(`stats: ${statsFile}`);
  console.log(`failed-documents: ${failedFile} (${failedDocuments.length})`);
  console.log(`API requests: total=${stats.requests || 0}, search=${stats.searchRequests || 0}, list=${stats.listRequests || 0}, read=${stats.readRequests || 0}`);
  console.log(`limits/retries/cache: 429=${stats.rateLimits || 0}, retries=${stats.retries || 0}, staleCache=${stats.staleCacheFallbacks || 0}, cacheHit=${stats.cacheHits || 0}, apiFetch=${stats.apiFetches || 0}`);
  console.log(`current interval: ${stats.currentIntervalMs || 0}ms`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || !args[1]) {
    console.error('用法: node batch-read-documents.js <start_date> <end_date>');
    console.error('示例: node batch-read-documents.js 03-10 04-30');
    process.exit(1);
  }
  const warmCacheOnly = args.includes('--warm-cache');
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

  for (let ti = 0; ti < config.teams.length; ti++) {
    const teamCfg = config.teams[ti];
    console.log(`\n===== ${teamCfg.name} =====`);
    const allFiles = [];
    let teamTotalScanned = 0;

    const monthEntries = getTeamScanEntries(teamCfg);

    const scanMode = getKdocsScanMode();

    try {
      for (const entry of monthEntries) {
        const { files, stats } = await scanFilesByMode(entry, {
          teamName: teamCfg.name,
          startDate,
          endDate,
          pacer,
          mode: scanMode,
          includeAll: true
        });
        files.forEach(f => f.sourceLabel = entry.label);
        allFiles.push(...files);
        teamTotalScanned += stats.totalScanned || files.length;
        const supplement = stats.recursiveSupplementCount ? `，递归补 ${stats.recursiveSupplementCount}` : '';
        console.log(`扫描 ${entry.label ? entry.label + ' ' : ''}${entry.monthName}: ${files.length}/${stats.totalScanned || files.length} 个文件匹配 [${stats.mode}; search ${stats.searchCount}; recursive ${stats.recursiveCount}${supplement}]`);
      }
    } catch (e) {
      process.stderr.write(`[batch-read] ${scanMode} 扫描失败 ${teamCfg.name}: ${e.message}\n`);
      allFiles.length = 0;
      teamTotalScanned = 0;
      for (const entry of monthEntries) {
        const { files, stats } = await scanFilesByMode(entry, {
          teamName: teamCfg.name,
          startDate,
          endDate,
          pacer,
          mode: 'recursive',
          includeAll: true
        });
        files.forEach(f => f.sourceLabel = entry.label);
        allFiles.push(...files);
        teamTotalScanned += stats.totalScanned || files.length;
        console.log(`  fallback ${entry.label ? entry.label + ' ' : ''}${entry.monthName}: ${files.length}/${stats.totalScanned || files.length} 个文件匹配`);
      }
    }

    const uniqueFiles = dedupeKdocsFiles(allFiles);
    allFiles.length = 0;
    allFiles.push(...uniqueFiles);

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

    const tasks = allFiles.map((f, i) => () => {
      const cacheFile = path.join(teamDocsCacheDir(teamCfg.name), `${f.id}.json`);
      const cached = readCache(cacheFile);
      const isCached = cached && cached.mtime === f.mtime;
      if (isCached) {
        cacheHit++;
        if (pacer && typeof pacer.noteCacheHit === 'function') pacer.noteCacheHit();
      } else {
        apiFetch++;
        if (pacer && typeof pacer.noteApiFetch === 'function') pacer.noteApiFetch();
      }

      return readDocAsync(f.drive_id, f.id, f.mtime, teamCfg.name, pacer).then(md => {
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
        if (!dateInRange(f.name, startDate, endDate, md)) return null;
        if (warmCacheOnly) return null;
        const teamPeople = teamCfg.leader ? [...importantPeople, teamCfg.leader] : importantPeople;
        const info = extractInfo(md, f.name, teamPeople);
        info.id = f.id;
        info.drive_id = f.drive_id;
        info.url = f.link;
        info.sourceLabel = f.sourceLabel || null;
        const num = i + 1;
        if (num % 5 === 0 || num === allFiles.length) {
          process.stdout.write(`  进度: ${num}/${allFiles.length}\r`);
        }
        return info;
      });
    });

    const rawResults = await runPool(tasks, CONCURRENCY);
    const documents = rawResults.filter(Boolean);
    const analyzedIds = new Set(documents.map(doc => doc.id).filter(Boolean));
    const failedKeys = new Set(failedDocuments.filter(doc => doc.team === teamCfg.name).map(doc => doc.id).filter(Boolean));
    const meetingListItems = allFiles
      .filter(f => !failedKeys.has(f.id) && dateInRange(f.name, startDate, endDate, f._readContent || ''))
      .map(f => ({ name: f.name, id: f.id, url: f.link || '', sourceLabel: f.sourceLabel || null }));
    const excludedMeetings = allFiles
      .filter(f => !meetingListItems.some(item => item.id === f.id) && !failedKeys.has(f.id))
      .map(f => ({ name: f.name, id: f.id, url: f.link || '', reason: 'out_of_date_range_after_content_check' }));
    const diagnosticExcludedMeetings = excludedMeetings.slice(0, 50);
    const unreadableMeetings = allFiles
      .filter(f => failedKeys.has(f.id))
      .map(f => ({ name: f.name, id: f.id, url: f.link || '', reason: 'read_failed' }));
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  完成: ${documents.length} 篇, 耗时 ${elapsed}s [cache] 命中 ${cacheHit} 篇, API 拉取 ${apiFetch} 篇`);

    allTeamsData.push({
      team: teamCfg.name,
      documents,
      totalScanned: meetingListItems.length,
      scanCandidateCount: candidateCount,
      meetingListCount: meetingListItems.length,
      meetingListItems,
      unreadableMeetings,
      excludedMeetings: diagnosticExcludedMeetings,
      excludedMeetingCount: excludedMeetings.length
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
      const weekKey = getWeekKey(doc.name);
      if (!weeks[weekKey]) weeks[weekKey] = { meetings: [], allConclusions: [], allTodos: [] };
      weeks[weekKey].meetings.push({
        title: doc.name.replace(/\.(otl|docx)$/i, ''),
        url: doc.url || '',
        participants: doc.participants,
        meetingTime: doc.meetingTime,
        conclusions: doc.conclusions,
        todos: doc.todos,
        important: doc.important,
        rawContent: doc.rawContent || '',
        sourceLabel: doc.sourceLabel || null
      });
      weeks[weekKey].allConclusions.push(...doc.conclusions);
      weeks[weekKey].allTodos.push(...doc.todos);
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
    source: 'batch-read-documents'
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

module.exports = {
  readDocAsync,
  runPool
};
