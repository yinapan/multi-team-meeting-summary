/**
 * 从本地缓存重建 team-summary JSON 文件，无需调用 KDocs API。
 * 用法: node scripts/reconstruct-from-cache.js 04-20 04-30
 */
const fs = require('fs');
const path = require('path');

const cacheDir = path.join(__dirname, '..', 'cache');
const workspaceDir = resolveWorkspaceDir();

const {
  extractDateFromFileName, dateInRange, normalizeDate,
  getWeekKey, readCache, getTeamSources, extractInfo, resolveWorkspaceDir
} = require('./shared');

function main() {
  const args = process.argv.slice(2);
  if (!args[0] || !args[1]) {
    console.error('用法: node scripts/reconstruct-from-cache.js <start_date> <end_date>');
    process.exit(1);
  }
  const startDate = normalizeDate(args[0]);
  const endDate = normalizeDate(args[1]);

  const configFile = path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  const importantPeople = config.important_people || [];

  const allTeamsData = [];

  for (const teamCfg of config.teams) {
    const teamName = teamCfg.name;
    const teamCacheDir = path.join(cacheDir, teamName);
    const foldersDir = path.join(teamCacheDir, 'folders');
    const docsDir = path.join(teamCacheDir, 'docs');

    if (!fs.existsSync(foldersDir)) {
      console.log(`${teamName}: 无文件夹缓存，跳过`);
      allTeamsData.push({ team: teamName, documents: [], totalScanned: 0 });
      continue;
    }

    // 读取所有 folder cache，收集文件元数据
    // 文件夹缓存文件名格式: {drive_id}_{folder_id}.json
    const allFiles = [];
    const folderFiles = fs.readdirSync(foldersDir);
    for (const ff of folderFiles) {
      const folderData = readCache(path.join(foldersDir, ff));
      if (!folderData || !folderData.items) continue;
      // 从文件名提取 folder_id
      const ffParts = ff.replace('.json', '').split('_');
      const folderId = ffParts.length >= 2 ? ffParts.slice(1).join('_') : ffParts[0];
      for (const item of folderData.items) {
        if (item.type === 'file' && /\.(otl|docx)$/i.test(item.name)) {
          if (dateInRange(item.name, startDate, endDate)) {
            allFiles.push({
              name: item.name,
              id: item.id,
              link: item.link_url,
              drive_id: item.drive_id,
              folder_id: folderId,
              mtime: item.mtime
            });
          }
        }
      }
    }

    if (allFiles.length === 0) {
      console.log(`${teamName}: ${folderFiles.length} 个文件夹缓存, 0 个文件匹配日期范围`);
      allTeamsData.push({ team: teamName, documents: [], totalScanned: 0 });
      continue;
    }

    console.log(`${teamName}: ${allFiles.length} 个文件匹配日期范围, 从缓存读取...`);

    // 确定 source label 映射：folder_id → label
    const folderLabels = new Map();
    if (teamCfg.sources && teamCfg.sources.length > 1) {
      // 尝试从现有 per-label team-summary 文件中推断 folder_id → label 映射
      for (const src of teamCfg.sources) {
        if (!src.label) continue;
        const labelFile = path.join(workspaceDir, `team-summary-${teamName}-${src.label}.json`);
        const labelData = readCache(labelFile);
        if (!labelData || !labelData.documents) continue;
        // 收集该 label 下所有文档的 URL
        const labelUrls = new Set(labelData.documents.map(d => d.url).filter(Boolean));
        // 对每个 folder_id，检查其文档是否匹配该 label
        const folderFiles2 = fs.readdirSync(foldersDir);
        for (const ff of folderFiles2) {
          const ffParts = ff.replace('.json', '').split('_');
          const fid = ffParts.length >= 2 ? ffParts.slice(1).join('_') : ffParts[0];
          const fd = readCache(path.join(foldersDir, ff));
          if (!fd || !fd.items) continue;
          const matchCount = fd.items.filter(item => item.link_url && labelUrls.has(item.link_url)).length;
          if (matchCount > 0) {
            folderLabels.set(fid, src.label);
          }
        }
      }
    }

    // 读取每个文档内容
    let cacheHits = 0;
    let cacheMiss = 0;
    const documents = [];
    const teamPeople = teamCfg.leader ? [...importantPeople, teamCfg.leader] : importantPeople;

    for (const f of allFiles) {
      const docCacheFile = path.join(docsDir, `${f.id}.json`);
      const cached = readCache(docCacheFile);
      if (!cached || !cached.content) {
        cacheMiss++;
        continue;
      }
      cacheHits++;

      const docLabel = folderLabels.get(f.folder_id) || null;
      const info = extractInfo(cached.content, f.name, teamPeople);
      info.url = f.link;
      info.sourceLabel = docLabel;
      documents.push(info);
    }

    console.log(`  → ${documents.length} 篇 (缓存命中 ${cacheHits}, 缺失 ${cacheMiss})`);
    allTeamsData.push({ team: teamName, documents, totalScanned: allFiles.length });
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

  // 保存每个团队的独立数据文件
  for (const td of allTeamsData) {
    const teamFile = path.join(workspaceDir, `team-summary-${td.team}.json`);
    fs.writeFileSync(teamFile, JSON.stringify(td, null, 2), 'utf-8');
    console.log(`  → ${teamFile} (${td.documents.length} 篇)`);

    // 多 source 团队：按 label 分组保存
    const docLabels = new Map();
    for (const doc of td.documents) {
      if (doc.sourceLabel) {
        if (!docLabels.has(doc.sourceLabel)) docLabels.set(doc.sourceLabel, []);
        docLabels.get(doc.sourceLabel).push(doc);
      }
    }
    if (docLabels.size > 1) {
      for (const [label, labelDocs] of docLabels) {
        const labelData = { team: td.team, label, documents: labelDocs, totalScanned: labelDocs.length };
        const labelFile = path.join(workspaceDir, `team-summary-${td.team}-${label}.json`);
        fs.writeFileSync(labelFile, JSON.stringify(labelData, null, 2), 'utf-8');
        console.log(`  → ${labelFile} (${labelDocs.length} 篇)`);
      }
    }
  }

  const totalDocs = allTeamsData.reduce((sum, t) => sum + t.documents.length, 0);
  console.log(`\n汇总: ${config.teams.length} 个团队, ${totalDocs} 篇文档`);
}

main();
