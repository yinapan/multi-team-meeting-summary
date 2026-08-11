const assert = require('assert');
const {
  buildWps365Args,
  getWps365CliPath,
  getWps365CliEnv,
  buildWps365ListArgs,
  buildWps365SearchArgs,
  buildWps365ContentArgs,
  getWps365FileList,
  getWps365ApiError,
  extractWps365Content,
  unwrapWps365SearchItem
} = require('./wps365-client');

assert.deepStrictEqual(
  buildWps365Args(['drive', 'files', 'list']),
  ['--output', 'json', '--no-color', '--quiet', 'drive', 'files', 'list']
);
assert.strictEqual(getWps365CliEnv({ accessToken: 'config-token' }).WPS365_ACCESS_TOKEN, 'config-token');
assert.strictEqual(
  getWps365CliEnv({ accessToken: 'config-token', env: { WPS365_ACCESS_TOKEN: 'env-token' } }).WPS365_ACCESS_TOKEN,
  'env-token'
);
assert.strictEqual(
  getWps365CliPath({}, {
    platform: 'win32',
    homeDir: 'C:\\Users\\test-user',
    localAppData: 'C:\\Users\\test-user\\AppData\\Local',
    pathExists: candidate => candidate === 'C:\\Users\\test-user\\AppData\\Local\\wps365-cli\\bin\\wps365-cli.exe'
  }),
  'C:\\Users\\test-user\\AppData\\Local\\wps365-cli\\bin\\wps365-cli.exe'
);
assert.strictEqual(
  getWps365CliPath({}, {
    platform: 'win32',
    homeDir: 'C:\\Users\\test-user',
    localAppData: 'C:\\Users\\test-user\\AppData\\Local',
    pathEnv: 'C:\\Tools;C:\\Users\\test-user\\AppData\\Local\\Custom WPS',
    pathExists: candidate => candidate === 'C:\\Users\\test-user\\AppData\\Local\\Custom WPS\\wps365-cli.exe'
  }),
  'C:\\Users\\test-user\\AppData\\Local\\Custom WPS\\wps365-cli.exe'
);
assert.deepStrictEqual(
  buildWps365ListArgs({ driveId: 'drive-1', parentId: 'folder-1', pageSize: 50, pageToken: 'next' }),
  ['drive', 'files', 'list', 'drive-1', 'folder-1', '--page-size', '50', '--page-token', 'next']
);
assert.deepStrictEqual(
  buildWps365SearchArgs({
    drive_ids: ['drive-1'],
    parent_ids: ['folder-1'],
    file_exts: ['otl', 'docx'],
    type: 'all',
    file_type: 'file',
    page_size: 100,
    page_token: 'next'
  }),
  [
    'drive', 'files', 'search', '--type', 'all', '--drive-ids', 'drive-1',
    '--parent-ids', 'folder-1', '--file-exts', 'otl,docx', '--file-type', 'file',
    '--page-size', '100', '--page-token', 'next'
  ]
);
assert.deepStrictEqual(
  buildWps365ContentArgs({ driveId: 'drive-1', fileId: 'file-1', format: 'markdown' }),
  ['drive', 'file-content', 'get', 'drive-1', 'file-1', '--format', 'markdown']
);

const listPayload = { code: 0, data: { items: [{ id: 'file-1', type: 'file' }], next_page_token: 'next' } };
assert.deepStrictEqual(getWps365FileList(listPayload), {
  items: [{ id: 'file-1', type: 'file' }],
  nextPageToken: 'next'
});
assert.strictEqual(unwrapWps365SearchItem({ file: { id: 'file-1' } }).id, 'file-1');
assert.strictEqual(extractWps365Content({ code: 0, data: { markdown: '# title' } }), '# title');
assert.strictEqual(extractWps365Content({ code: 0, data: { plain: 'plain text' } }), 'plain text');
assert.deepStrictEqual(getWps365ApiError({ code: 401, msg: 'unauthorized' }), {
  code: 401,
  message: 'unauthorized'
});
assert.strictEqual(getWps365ApiError({ code: 0 }), null);

console.log('WPS 365 CLI contract tests passed.');
