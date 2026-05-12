const fs = require('fs');
const path = require('path');
const {
  resolveWorkspaceDir, scanFolderAllAsync, normalizeForMatch, normalizeTitle, charSimilarity, getTeamSources, RequestPacer
} = require('./shared');

async function main() {
  const workspaceDir = resolveWorkspaceDir();
  const configFile = path.join(__dirname, '..', 'config.json');
  const dataFile = path.join(workspaceDir, 'all-team-summaries.json');

  if (!fs.existsSync(dataFile)) {
    console.error(`数据文件不存在: ${dataFile}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  const teams = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));

  const pacer = new RequestPacer();
  const allFiles = [];

  const scanTasks = config.teams.flatMap(teamCfg =>
    getTeamSources(teamCfg).flatMap(source =>
      Object.entries(source.months || {}).map(([monthName, folderId]) => ({ teamCfg, source, monthName, folderId }))
    )
  );

  console.log(`并行扫描 ${scanTasks.length} 个文件夹...`);
  const results = await Promise.all(
    scanTasks.map(({ source, folderId, teamCfg }) =>
      scanFolderAllAsync(source.drive_id, folderId, teamCfg.name, pacer)
    )
  );

  for (let i = 0; i < scanTasks.length; i++) {
    const { teamCfg, monthName } = scanTasks[i];
    const files = results[i];
    allFiles.push(...files);
    console.log(`  ${teamCfg.name}/${monthName}: ${files.length} 个文件`);
  }

  const urlMap = new Map();
  for (const f of allFiles) {
    const key = normalizeForMatch(f.name);
    if (f.link) urlMap.set(key, f.link);
  }
  console.log(`\n共收集 ${urlMap.size} 个文档链接`);

  let matched = 0, total = 0;
  for (const team of teams) {
    for (const [weekKey, weekData] of Object.entries(team.weeks || {})) {
      for (const meeting of (weekData.meetings || [])) {
        total++;
        const key = normalizeForMatch(meeting.title);

        if (urlMap.has(key)) {
          meeting.url = urlMap.get(key);
          matched++;
        } else {
          let bestScore = 0, bestUrl = '';
          for (const [fileKey, fileUrl] of urlMap) {
            if (key.includes(fileKey) || fileKey.includes(key)) {
              bestUrl = fileUrl;
              bestScore = 1;
              break;
            }
            const sim = charSimilarity(key, fileKey);
            if (sim > bestScore) {
              bestScore = sim;
              bestUrl = fileUrl;
            }
          }
          if (bestScore >= 0.6 && bestUrl) {
            meeting.url = bestUrl;
            matched++;
          }
        }

        meeting.title = normalizeTitle(meeting.title);
      }
    }
  }

  console.log(`匹配结果: ${matched}/${total} 条会议记录已添加链接`);

  fs.writeFileSync(dataFile, JSON.stringify(teams, null, 2), 'utf-8');
  console.log(`已更新: ${dataFile}`);
}

main().catch(console.error);
