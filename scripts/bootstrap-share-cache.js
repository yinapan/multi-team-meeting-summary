/**
 * 预填充 share-link 缓存：逐个解析所有团队的 link_id，带 60s 节流。
 * 运行一次后，后续的 batch-read-documents 将直接从缓存读取，不再调用 get-share-info。
 * 用法: node scripts/bootstrap-share-cache.js
 */
const fs = require('fs');
const path = require('path');
const { resolveShareLinkThrottled, getTeamSources } = require('./shared');

function main() {
  const configFile = path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

  const allLinkIds = [];
  const seen = new Set();
  for (const teamCfg of config.teams) {
    for (const src of getTeamSources(teamCfg)) {
      if (src.link_id && !seen.has(src.link_id)) {
        seen.add(src.link_id);
        allLinkIds.push({ link_id: src.link_id, team: teamCfg.name, label: src.label || null });
      }
    }
  }

  console.log(`共 ${allLinkIds.length} 个唯一 link_id 需要解析\n`);

  let success = 0, fail = 0;
  for (let i = 0; i < allLinkIds.length; i++) {
    const { link_id, team, label } = allLinkIds[i];
    const labelStr = label ? ` (${label})` : '';
    console.log(`[${i + 1}/${allLinkIds.length}] ${team}${labelStr}: ${link_id}`);
    const result = resolveShareLinkThrottled(link_id);
    if (result) {
      console.log(`  ✓ drive_id=${result.drive_id} folder_id=${result.folder_id}`);
      success++;
    } else {
      console.log(`  ✗ 失败，跳过`);
      fail++;
    }
  }

  console.log(`\n完成: ${success} 成功, ${fail} 失败`);
}

main();
