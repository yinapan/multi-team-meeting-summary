const fs = require('fs');
const path = require('path');
const { resolveWorkspaceDir, getWeekKey, normalizeDate, teamDocsCacheDir, ensureCacheDir, readCache, writeCache, getTeamSources, scanFolderWithStatsAsync, RequestPacer, extractInfo } = require('./shared');

const CONCURRENCY = parseInt(process.env.KDOCS_CONCURRENCY, 10) || 5;
const KDOCS_CLI = process.env.KDOCS_CLI_PATH || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'kdocs-cli', 'kdocs-cli.exe') : 'kdocs-cli');

function readDocAsync(driveId, fileId, mtime, teamName) {
  const cacheFile = path.join(teamDocsCacheDir(teamName), `${fileId}.json`);
  const cached = readCache(cacheFile);
  if (cached && cached.mtime === mtime) {
    return Promise.resolve(cached.content);
  }

  return new Promise((resolve) => {
    const inputJson = JSON.stringify({ drive_id: driveId, file_id: fileId, format: "markdown", include_elements: "para" });
    const child = require('child_process').spawn(KDOCS_CLI, ['drive', 'read-file-content', '--output', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); }, 30000);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout) {
        if (stderr) process.stderr.write(`[readDoc] 失败 file=${fileId}: ${stderr.substring(0, 100)}\n`);
        resolve('');
        return;
      }
      try {
        const result = JSON.parse(stdout);
        const content = (result && result.data && result.data.data && result.data.data.markdown) || '';
        if (content) {
          writeCache(cacheFile, { content, mtime, fetched_at: Date.now() });
        }
        resolve(content);
      } catch (e) {
        process.stderr.write(`[readDoc] JSON解析失败 file=${fileId}: ${e.message.substring(0, 80)}\n`);
        resolve('');
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      process.stderr.write(`[readDoc] 启动失败 file=${fileId}: ${e.message.substring(0, 100)}\n`);
      resolve('');
    });
    child.stdin.write(inputJson);
    child.stdin.end();
  });
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

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || !args[1]) {
    console.error('用法: node batch-read-documents.js <start_date> <end_date>');
    console.error('示例: node batch-read-documents.js 03-10 04-30');
    process.exit(1);
  }
  const startDate = normalizeDate(args[0]);
  const endDate = normalizeDate(args[1]);

  const workspaceDir = resolveWorkspaceDir();
  const configFile = path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

  const importantPeople = config.important_people || [];
  const allTeamsData = [];
  const pacer = new RequestPacer();

  for (let ti = 0; ti < config.teams.length; ti++) {
    const teamCfg = config.teams[ti];
    console.log(`\n===== ${teamCfg.name} =====`);
    const allFiles = [];
    let teamTotalScanned = 0;

    const sources = getTeamSources(teamCfg);
    const monthEntries = sources.flatMap(source =>
      Object.entries(source.months || {}).map(([monthName, folderId]) => ({ source, monthName, folderId, label: source.label || teamCfg.name }))
    );

    const scanResults = await Promise.all(
      monthEntries.map(({ source, folderId }) =>
        scanFolderWithStatsAsync(source.drive_id, folderId, startDate, endDate, teamCfg.name, pacer)
      )
    );

    for (let i = 0; i < monthEntries.length; i++) {
      const { label, monthName, folderId } = monthEntries[i];
      const { files, totalScanned } = scanResults[i];
      console.log(`扫描 ${label ? label + ' ' : ''}${monthName}: ${folderId}`);
      files.forEach(f => f.sourceLabel = label);
      allFiles.push(...files);
      teamTotalScanned += totalScanned;
      console.log(`  -> ${files.length}/${totalScanned} 个文件匹配`);
    }

    if (allFiles.length === 0) {
      console.log('  无匹配文件，跳过');
      allTeamsData.push({ team: teamCfg.name, documents: [], totalScanned: teamTotalScanned });
      continue;
    }

    console.log(`并发读取 ${allFiles.length} 篇文档 (并发数: ${CONCURRENCY})...`);
    ensureCacheDir(teamCfg.name);
    let cacheHit = 0, apiFetch = 0;
    const startTime = Date.now();

    const tasks = allFiles.map((f, i) => () => {
      const cacheFile = path.join(teamDocsCacheDir(teamCfg.name), `${f.id}.json`);
      const cached = readCache(cacheFile);
      const isCached = cached && cached.mtime === f.mtime;
      if (isCached) cacheHit++; else apiFetch++;

      return readDocAsync(f.drive_id, f.id, f.mtime, teamCfg.name).then(md => {
        const teamPeople = teamCfg.leader ? [...importantPeople, teamCfg.leader] : importantPeople;
        const info = extractInfo(md, f.name, teamPeople);
        info.url = f.link;
        info.sourceLabel = f.sourceLabel || null;
        const num = i + 1;
        if (num % 5 === 0 || num === allFiles.length) {
          process.stdout.write(`  进度: ${num}/${allFiles.length}\r`);
        }
        return info;
      });
    });

    const documents = await runPool(tasks, CONCURRENCY);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  完成: ${documents.length} 篇, 耗时 ${elapsed}s [cache] 命中 ${cacheHit} 篇, API 拉取 ${apiFetch} 篇`);

    allTeamsData.push({ team: teamCfg.name, documents, totalScanned: teamTotalScanned });
  }

  // 按周分组保存为 all-team-summaries 格式
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

  const outFile = path.join(workspaceDir, 'all-team-summaries.json');
  fs.writeFileSync(outFile, JSON.stringify(teamSummaries, null, 2), 'utf-8');
  console.log(`\n已保存: ${outFile}`);

  // 同时保存每个团队的独立数据文件（供报告生成脚本使用）
  for (const td of allTeamsData) {
    const teamFile = path.join(workspaceDir, `team-summary-${td.team}.json`);
    fs.writeFileSync(teamFile, JSON.stringify(td, null, 2), 'utf-8');
    console.log(`  -> ${teamFile}`);
  }

  const totalDocs = allTeamsData.reduce((sum, t) => sum + t.documents.length, 0);
  console.log(`\n汇总: ${config.teams.length} 个团队, ${totalDocs} 篇文档`);
}

main().catch(console.error);
