const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KDOCS_CLI = process.env.LOCALAPPDATA + '\\kdocs-cli\\kdocs-cli.exe';

function getFileInfo(fileId) {
  try {
    const raw = execFileSync(KDOCS_CLI, ['drive', 'get-file-info', '--compact'], {
      input: JSON.stringify({ file_id: fileId }),
      encoding: 'utf-8',
      timeout: 15000,
      windowsHide: true
    });
    const parsed = JSON.parse(raw);
    if (parsed && parsed.data && parsed.data.data) return parsed.data.data;
    return null;
  } catch (e) {
    return null;
  }
}

function listFolders(driveId, parentId) {
  try {
    const raw = execFileSync(KDOCS_CLI, ['drive', 'list-files', '--compact'], {
      input: JSON.stringify({ drive_id: driveId, parent_id: parentId, page_size: 100, filter_type: 'folder' }),
      encoding: 'utf-8',
      timeout: 15000,
      windowsHide: true
    });
    const parsed = JSON.parse(raw);
    if (parsed && parsed.data && parsed.data.data && parsed.data.data.items) return parsed.data.data.items;
    return [];
  } catch (e) {
    return [];
  }
}

async function main() {
  const configFile = path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

  for (const team of config.teams) {
    if (!team.sources) continue;

    for (const source of team.sources) {
      // Skip already fully resolved
      if (source.drive_id && source.months && Object.keys(source.months).length > 0 && !source.months._root) {
        console.log(`[SKIP] ${team.name} / ${source.label || source.link_id} - already resolved`);
        continue;
      }

      const linkId = source.link_id;
      if (!linkId) continue;

      console.log(`\n[RESOLVE] ${team.name} / ${source.label || linkId}`);

      // Get file info to find drive_id
      const info = getFileInfo(linkId);
      if (!info) {
        console.log(`  ❌ get-file-info failed for ${linkId}`);
        continue;
      }

      const driveId = info.drive_id;
      const realId = info.id; // actual file_id (may differ from link_id)
      console.log(`  drive_id = ${driveId}, real_id = ${realId}, name = ${info.name}, parent_id = ${info.parent_id}`);

      source.drive_id = driveId;
      source.root_folder_id = realId;

      // List subfolders (months)
      const subFolders = listFolders(driveId, realId);
      if (subFolders.length > 0) {
        console.log(`  Found ${subFolders.length} subfolders:`);
        const months = {};
        for (const sf of subFolders) {
          const name = sf.name || sf.title || sf.id;
          console.log(`    ${name} → ${sf.id}`);
          months[name] = sf.id;
        }
        source.months = months;
      } else {
        // No subfolders - flat structure, use root as single entry
        console.log(`  No subfolders, using root as _root`);
        source.months = { '_root': realId };
      }
    }
  }

  // Write updated config
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`\n✅ Config updated: ${configFile}`);
}

main().catch(console.error);
