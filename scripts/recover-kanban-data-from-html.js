const fs = require('fs');
const path = require('path');

const { outputPath, writeOutputJson } = require('./shared');

const inputHtml = process.argv[2] || outputPath('会议看板审核版本.html');
const outputJson = process.argv[3] || '会议看板-data.json';

if (!fs.existsSync(inputHtml)) {
  console.error(`找不到审核版 HTML: ${inputHtml}`);
  process.exit(1);
}

const html = fs.readFileSync(inputHtml, 'utf-8');
const dataMatch = html.match(/const data = (.*?);\s*const weekKeys/s);
if (!dataMatch) {
  console.error(`无法从 HTML 中解析看板数据: ${inputHtml}`);
  process.exit(1);
}

const teams = JSON.parse(dataMatch[1]);
const data = {
  teams: teams.map(team => ({
    name: team.name,
    weeks: team.weeks || {}
  })),
  lastUpdate: new Date().toISOString().slice(0, 10)
};

const written = path.isAbsolute(outputJson)
  ? (fs.writeFileSync(outputJson, JSON.stringify(data, null, 2), 'utf-8'), outputJson)
  : writeOutputJson(outputJson, data);

let total = 0;
for (const team of data.teams) {
  for (const meetings of Object.values(team.weeks || {})) total += meetings.length;
}

console.log(`已恢复看板数据: ${written}`);
console.log(`  团队数: ${data.teams.length}, 会议数: ${total}`);
