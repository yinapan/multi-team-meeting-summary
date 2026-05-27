const assert = require('assert');
const {
  getKdocsScanMode,
  shouldHybridRecursiveScan,
  dedupeKdocsFiles
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

console.log('scan policy tests passed');
