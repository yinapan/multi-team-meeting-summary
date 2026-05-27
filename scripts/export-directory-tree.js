const fs = require('fs');
const path = require('path');
const {
  getSkillConfig,
  getTeamSources,
  listFolderAsync,
  RequestPacer,
  writeOutputJson
} = require('./shared');

const OUTPUT_FILE = 'kdocs-directory-tree.json';

function normalizeItem(item) {
  return {
    id: item.id || '',
    name: item.name || '',
    type: item.type || '',
    link: item.link_url || item.link || '',
    size: item.size || 0,
    mtime: item.mtime || null
  };
}

function compareItems(a, b) {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
}

async function buildFolderTree({ driveId, folderId, teamName, sourceLabel, monthName, parentPath, pacer, rows }) {
  const items = (await listFolderAsync(driveId, folderId, teamName, pacer))
    .map(normalizeItem)
    .sort(compareItems);

  const folder = {
    id: folderId,
    name: parentPath.split('/').pop() || monthName || sourceLabel || teamName,
    path: parentPath,
    files: [],
    children: []
  };

  for (const item of items) {
    const itemPath = `${parentPath}/${item.name}`;
    if (item.type === 'folder') {
      rows.push({
        team: teamName,
        source: sourceLabel,
        month: monthName,
        type: 'folder',
        path: itemPath,
        name: item.name,
        id: item.id,
        link: item.link
      });
      folder.children.push(await buildFolderTree({
        driveId,
        folderId: item.id,
        teamName,
        sourceLabel,
        monthName,
        parentPath: itemPath,
        pacer,
        rows
      }));
    } else {
      const file = { ...item, path: itemPath };
      folder.files.push(file);
      rows.push({
        team: teamName,
        source: sourceLabel,
        month: monthName,
        type: 'file',
        path: itemPath,
        name: item.name,
        id: item.id,
        link: item.link,
        size: item.size,
        mtime: item.mtime
      });
    }
  }

  return folder;
}

async function main() {
  const config = getSkillConfig();
  const pacer = new RequestPacer();
  const rows = [];
  const tree = [];

  for (const teamCfg of config.teams || []) {
    const teamNode = {
      id: teamCfg.id || '',
      name: teamCfg.name,
      leader: teamCfg.leader || '',
      sources: []
    };

    for (const source of getTeamSources(teamCfg)) {
      const sourceNode = {
        label: source.label || teamCfg.name,
        drive_id: source.drive_id,
        root_folder_id: source.root_folder_id || '',
        months: []
      };

      for (const [monthName, folderId] of Object.entries(source.months || {})) {
        const rootPath = `${teamCfg.name}/${sourceNode.label}/${monthName}`;
        console.log(`扫描 ${rootPath}`);
        rows.push({
          team: teamCfg.name,
          source: sourceNode.label,
          month: monthName,
          type: 'root',
          path: rootPath,
          name: monthName,
          id: folderId,
          link: ''
        });
        sourceNode.months.push({
          name: monthName,
          folder_id: folderId,
          tree: await buildFolderTree({
            driveId: source.drive_id,
            folderId,
            teamName: teamCfg.name,
            sourceLabel: sourceNode.label,
            monthName,
            parentPath: rootPath,
            pacer,
            rows
          })
        });
      }

      teamNode.sources.push(sourceNode);
    }

    tree.push(teamNode);
  }

  const summary = {
    teams: tree.length,
    roots: rows.filter(r => r.type === 'root').length,
    folders: rows.filter(r => r.type === 'folder').length,
    files: rows.filter(r => r.type === 'file').length
  };

  const output = {
    generatedAt: new Date().toISOString(),
    summary,
    tree,
    rows
  };

  const outPath = writeOutputJson(OUTPUT_FILE, output);
  console.log(`已生成: ${outPath}`);
  console.log(JSON.stringify(summary));
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  buildFolderTree
};
