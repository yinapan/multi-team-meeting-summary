const assert = require('assert');
const {
  getKdocsScanMode,
  shouldHybridRecursiveScan,
  dedupeKdocsFiles,
  getTeamScanEntries
} = require('./shared');

assert.strictEqual(getKdocsScanMode(), 'recursive');

assert.strictEqual(
  shouldHybridRecursiveScan('运营发行中心', 'K2运营发行部'),
  true,
  'known high-risk K2 directory should use recursive supplement'
);

assert.strictEqual(
  shouldHybridRecursiveScan('行政管理部', '行政管理部'),
  true,
  'known discrepancy team should use recursive supplement'
);

const deduped = dedupeKdocsFiles([
  { id: '1', name: 'a.otl' },
  { id: '1', name: 'a-copy.otl' },
  { link: 'https://example.test/b', name: 'b.otl' },
  { link: 'https://example.test/b', name: 'b-copy.otl' }
]);
assert.strictEqual(deduped.length, 2);

const normalized = dedupeKdocsFiles([
  { id: '3', name: 'c.otl', link: 'https://example.test/c' }
]);
assert.strictEqual(normalized[0].link, 'https://example.test/c');

const teamCfg = {
  name: 'TeamA',
  sources: [{
    label: 'ProjectA',
    drive_id: 'drive-a',
    root_folder_id: 'root-a',
    months: {
      '5月': 'folder-may',
      '4月': 'folder-apr'
    }
  }]
};

const rootEntries = getTeamScanEntries(teamCfg);
assert.deepStrictEqual(rootEntries.map(e => ({
  label: e.label,
  folderId: e.folderId,
  monthName: e.monthName,
  scope: e.scope
})), [{
  label: 'ProjectA',
  folderId: 'root-a',
  monthName: '_root',
  scope: 'root'
}]);

const configuredEntries = getTeamScanEntries(teamCfg, { useRoot: false });
assert.deepStrictEqual(configuredEntries.map(e => e.folderId), ['folder-may', 'folder-apr']);

console.log('scan policy tests passed');
