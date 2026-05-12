// check-participants.js - Batch check meeting participants
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const driveId = process.argv[2];
const KDOCS_CLI = process.env.KDOCS_CLI_PATH || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'kdocs-cli', 'kdocs-cli.exe') : 'kdocs-cli');
const fileIds = process.argv.slice(3);

if (!driveId || fileIds.length === 0) {
  console.error('用法: node check-participants.js <drive_id> <file_id1> [file_id2] ...');
  process.exit(1);
}

for (const fid of fileIds) {
  const inputJson = JSON.stringify({ drive_id: driveId, file_id: fid, format: 'markdown', include_elements: 'para' });

  try {
    const raw = execFileSync(KDOCS_CLI, ['drive', 'read-file-content', '--output', 'json'], {
      input: inputJson,
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });

    const obj = JSON.parse(raw);
    const md = (obj && obj.data && obj.data.data && obj.data.data.markdown) || '';

    const m = md.match(/(?:参会人|参与人|参会.)(.?)\s*([^\n]+)/);
    const participants = m ? m[2].trim() : 'NOT_FOUND';

    const configFile = path.join(__dirname, '..', 'config.json');
    const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf-8')) : {};
    const importantPeople = config.important_people || [];
    const important = importantPeople.some(name => md.includes(name));
    const status = important ? 'IMPORTANT' : 'normal';

    console.log(`${fid} | ${participants} | ${status}`);
  } catch (e) {
    console.log(`${fid} | ERROR: ${e.message.substring(0, 100)}`);
  }
}
