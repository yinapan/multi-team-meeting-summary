const fs = require('fs');
const path = require('path');
const { extractDateFromFileName, dateInRange, getWeekKey, scanFolderAsync, RequestPacer } = require('./shared');

// Usage: node scan-team-documents.js <drive_id> <folder_id> <start_date> <end_date>

const driveId = process.argv[2];
const folderId = process.argv[3];
const startDate = process.argv[4];
const endDate = process.argv[5];

if (!driveId || !folderId || !startDate || !endDate) {
  console.error('用法: node scan-team-documents.js <drive_id> <folder_id> <start_date> <end_date>');
  console.error('示例: node scan-team-documents.js 3085837674 FP28YVZnmxMphDuB81PX1xYgeNFYjdyGN 04-13 04-26');
  process.exit(1);
}

async function main() {
  const pacer = new RequestPacer();
  const files = await scanFolderAsync(driveId, folderId, startDate, endDate, undefined, pacer);

  const weekMap = {};
  files.forEach(f => {
    const week = getWeekKey(f.name);
    if (!weekMap[week]) weekMap[week] = [];
    weekMap[week].push(f);
  });

  console.log(JSON.stringify({
    total: files.length,
    weeks: Object.keys(weekMap).sort().map(w => ({
      name: w,
      count: weekMap[w].length,
      files: weekMap[w]
    }))
  }, null, 2));
}

main().catch(console.error);
