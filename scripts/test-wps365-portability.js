const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wps365-portability-'));
const sourcePath = path.join(tempDir, 'config.json');
const targetPath = path.join(tempDir, 'config.portable.json');

try {
  fs.writeFileSync(sourcePath, JSON.stringify({
    wps365: {
      accessToken: 'short-lived-token',
      token: 'legacy-token',
      contentFormat: 'markdown',
      env: { WPS365_ACCESS_TOKEN: 'nested-token', KEEP_ME: 'yes' }
    },
    kdocs: { token: 'old-token', cacheTtlMs: 1 },
    teams: [{ name: 'team', sources: [{ drive_id: 'drive', root_folder_id: 'folder' }] }]
  }));

  execFileSync(process.execPath, [
    path.join(__dirname, 'export-portable-config.js'),
    sourcePath,
    targetPath
  ]);

  const portable = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  assert.strictEqual(portable.wps365.accessToken, undefined);
  assert.strictEqual(portable.wps365.token, undefined);
  assert.strictEqual(portable.wps365.env.WPS365_ACCESS_TOKEN, undefined);
  assert.strictEqual(portable.wps365.env.KEEP_ME, 'yes');
  assert.strictEqual(portable.kdocs.token, undefined);
  assert.strictEqual(portable.kdocs.cacheTtlMs, 1);
  assert.strictEqual(portable.teams[0].sources[0].drive_id, 'drive');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('WPS 365 portability tests passed.');
