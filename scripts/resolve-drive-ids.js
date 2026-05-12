// Resolve drive_id for each team's link_id by querying the folder metadata
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KDOCS_CLI = process.env.LOCALAPPDATA + '\\kdocs-cli\\kdocs-cli.exe';

function callKDocs(args, input) {
  try {
    const result = execFileSync(KDOCS_CLI, args, {
      input: input,
      encoding: 'utf-8',
      timeout: 15000,
      windowsHide: true
    });
    return JSON.parse(result);
  } catch (e) {
    return null;
  }
}

// Try to list files in a folder using different drive_ids
function findDriveId(folderId) {
  // Try common drive IDs from existing config
  const knownDrives = ['3085837674', '3085441344', '3065409101'];
  
  for (const driveId of knownDrives) {
    const result = callKDocs(['drive', 'list-files', '--output', 'json'], 
      JSON.stringify({ drive_id: driveId, parent_id: folderId, page_size: 5 }));
    if (result && result.code === 0 && result.data && result.data.data && result.data.data.items) {
      return { drive_id: driveId, items: result.data.data.items };
    }
  }
  
  // If known drives don't work, try listing with parent_id=0 on each known drive 
  // and see if our folder_id appears
  for (const driveId of knownDrives) {
    const result = callKDocs(['drive', 'list-files', '--output', 'json'],
      JSON.stringify({ drive_id: driveId, parent_id: '0', page_size: 100, filter_type: 'folder' }));
    if (result && result.code === 0 && result.data && result.data.data && result.data.data.items) {
      const match = result.data.data.items.find(i => i.id === folderId);
      if (match) {
        return { drive_id: driveId, items: [match] };
      }
    }
  }
  
  return null;
}

// Get subfolder structure (months)
function getSubFolders(driveId, parentId) {
  const result = callKDocs(['drive', 'list-files', '--output', 'json'],
    JSON.stringify({ drive_id: driveId, parent_id: parentId, page_size: 100, filter_type: 'folder' }));
  if (result && result.code === 0 && result.data && result.data.data && result.data.data.items) {
    return result.data.data.items;
  }
  return [];
}

async function main() {
  const configFile = path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  
  for (const team of config.teams) {
    if (!team.sources) continue;
    
    for (const source of team.sources) {
      // Skip already-resolved sources
      if (source.drive_id && source.months && Object.keys(source.months).length > 0) {
        console.log(`[SKIP] ${team.name} / ${source.label || source.link_id} - already resolved`);
        continue;
      }
      
      const linkId = source.link_id;
      if (!linkId) {
        console.log(`[SKIP] ${team.name} - no link_id`);
        continue;
      }
      
      console.log(`\n[RESOLVE] ${team.name} / ${source.label || linkId}`);
      
      // Try to find drive_id
      const found = findDriveId(linkId);
      if (!found) {
        console.log(`  ❌ Could not find drive_id for folder ${linkId}`);
        continue;
      }
      
      console.log(`  ✅ drive_id = ${found.drive_id}`);
      source.drive_id = found.drive_id;
      
      // Check if the folder itself is the root (contains subfolders for months)
      const subFolders = getSubFolders(found.drive_id, linkId);
      if (subFolders.length > 0) {
        console.log(`  Found ${subFolders.length} subfolders:`);
        const months = {};
        for (const sf of subFolders) {
          const name = sf.name || sf.title || sf.id;
          console.log(`    ${name} → ${sf.id}`);
          // Only add if name looks like a month folder
          if (/^\d{1,2}月?$/.test(name) || /^(3月|4月|5月|6月)$/.test(name)) {
            months[name] = sf.id;
          }
        }
        if (Object.keys(months).length > 0) {
          source.months = months;
          source.root_folder_id = linkId;
        } else {
          // If no month-like folders, treat the folder itself as a flat document container
          source.root_folder_id = linkId;
          source.months = { '_root': linkId };
        }
      } else {
        // No subfolders, folder itself contains documents
        source.root_folder_id = linkId;
        source.months = { '_root': linkId };
      }
      
      console.log(`  months = ${JSON.stringify(source.months)}`);
    }
  }
  
  // Write updated config
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`\n✅ Config updated: ${configFile}`);
}

main().catch(console.error);
