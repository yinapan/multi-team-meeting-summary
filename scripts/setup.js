const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
}

function ask(rl, question, defaultVal) {
  const suffix = defaultVal ? ` (${defaultVal})` : '';
  return new Promise(resolve => {
    rl.question(`${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || '');
    });
    rl.once('close', () => resolve(defaultVal || ''));
  });
}

function parseKDocsLink(url) {
  const m = url.match(/kdocs\.cn\/\w+\/(\d+)\/([A-Za-z0-9]+)/);
  if (m) return { drive_id: m[1], folder_id: m[2] };
  const m2 = url.match(/drive_id[=:](\d+).*folder_id[=:]([A-Za-z0-9]+)/);
  if (m2) return { drive_id: m2[1], folder_id: m2[2] };
  return null;
}

async function main() {
  const lines = [];
  const isPiped = !process.stdin.isTTY;

  if (isPiped) {
    await new Promise(resolve => {
      const r = readline.createInterface({ input: process.stdin });
      r.on('line', line => lines.push(line));
      r.on('close', resolve);
    });
  }

  let lineIdx = 0;
  function nextLine() { return lineIdx < lines.length ? lines[lineIdx++] : ''; }

  function prompt(question, defaultVal) {
    const suffix = defaultVal ? ` (${defaultVal})` : '';
    if (isPiped) {
      const val = nextLine().trim() || defaultVal || '';
      console.log(`${question}${suffix}: ${val}`);
      return Promise.resolve(val);
    }
    const rl = createRL();
    return new Promise(resolve => {
      rl.question(`${question}${suffix}: `, answer => {
        rl.close();
        resolve(answer.trim() || defaultVal || '');
      });
    });
  }

  console.log('\n=== 多团队会议记录汇总分析 — 初始化配置 ===\n');

  if (fs.existsSync(CONFIG_FILE)) {
    const overwrite = await prompt('config.json 已存在，是否重新配置？(y/N)', 'N');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('保留现有配置，退出。');
      return;
    }
  }

  const orgName = await prompt('组织名称（用于报告页眉，可留空）');
  const peopleStr = await prompt('重要参会人（逗号分隔，如 张三,李四，可留空）');
  const importantPeople = peopleStr ? peopleStr.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];

  const teams = [];
  let addMore = true;
  let teamIdx = 0;

  while (addMore) {
    console.log(`\n--- 团队 ${teamIdx + 1} ---`);
    const name = await prompt('团队名称');
    if (!name) {
      if (isPiped) break;
      console.log('团队名称不能为空，跳过。');
      continue;
    }
    const leader = await prompt('团队负责人（用于标记重要会议，可留空）');

    const sources = [];
    let addMoreSources = true;
    let srcIdx = 0;

    while (addMoreSources) {
      if (srcIdx > 0) console.log(`  --- 来源 ${srcIdx + 1} ---`);

      const link = await prompt(`${srcIdx === 0 ? 'KDocs 文件夹链接' : '  额外来源的 KDocs 链接'}`);
      const parsed = link ? parseKDocsLink(link) : null;

      let driveId, rootFolderId;
      if (parsed) {
        driveId = parsed.drive_id;
        rootFolderId = parsed.folder_id;
        console.log(`  解析成功: drive_id=${driveId}, folder_id=${rootFolderId}`);
      } else {
        console.log('  无法从链接解析，请手动输入：');
        driveId = await prompt('  drive_id');
        rootFolderId = await prompt('  root_folder_id');
      }

      const months = {};
      console.log('  添加月份文件夹（输入空月份名结束）：');
      while (true) {
        const monthName = await prompt('  月份名（如 3月、4月）');
        if (!monthName) break;
        const folderId = await prompt(`  ${monthName} 的 folder_id`);
        if (folderId) months[monthName] = folderId;
      }

      sources.push({ drive_id: driveId, root_folder_id: rootFolderId, months });
      srcIdx++;

      const moreSrc = await prompt('  该团队是否还有其他文档来源？(y/N)', 'N');
      addMoreSources = moreSrc.toLowerCase() === 'y';
    }

    const teamEntry = { id: `team${teamIdx}`, name, sources };
    if (leader) teamEntry.leader = leader;
    teams.push(teamEntry);
    teamIdx++;

    const cont = await prompt('继续添加团队？(y/N)', 'N');
    addMore = cont.toLowerCase() === 'y';
  }

  if (teams.length === 0) {
    console.log('\n未添加任何团队，退出。');
    return;
  }

  const config = {
    version: '1.0.0',
    org_name: orgName,
    important_people: importantPeople,
    llm: {
      command: 'claude',
      args: ['-p'],
      model: null,
      timeout: 300000
    },
    teams
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`\n配置已保存: ${CONFIG_FILE}`);
  console.log(`  团队数: ${teams.length}`);
  console.log(`  重要参会人: ${importantPeople.length > 0 ? importantPeople.join('、') : '（无）'}`);
  console.log('\n下一步：');
  console.log('  node scripts/batch-read-documents.js 04-01 04-30');
  console.log('  node scripts/generate-team-report.js 04-01 04-30');
  console.log('  node scripts/generate-comprehensive-report.js 04-01 04-30');
}

main().catch(e => { console.error(e); process.exit(1); });
