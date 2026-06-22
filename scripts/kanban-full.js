const path = require('path');
const { execFileSync } = require('child_process');

function main() {
  const extraArgs = process.argv.slice(2);
  const startedAt = Date.now();
  execFileSync(process.execPath, [path.join(__dirname, 'generate-kanban.js'), '--full', ...extraArgs], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    timeout: 900000,
    env: process.env
  });
  const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  console.log(`全量会议记录看板生成完成，耗时 ${elapsedSec}s。`);
}

if (require.main === module) {
  main();
}
