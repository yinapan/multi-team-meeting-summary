const assert = require('assert');

const {
  RequestPacer,
  selectMonthEntriesForRange,
} = require('./shared');

async function testPacerCoolsDownAfterRateLimit() {
  const pacer = new RequestPacer({
    maxConcurrent: 1,
    minIntervalMs: 1,
    rateLimitCooldownMs: 25,
    adaptiveMaxIntervalMs: 20,
    adaptiveStepMs: 5,
  });

  const started = [];

  await pacer.acquire();
  started.push(Date.now());
  pacer.noteRateLimit();
  pacer.release();

  await pacer.acquire();
  started.push(Date.now());
  pacer.release();

  assert(
    started[1] - started[0] >= 20,
    `expected cooldown delay, got ${started[1] - started[0]}ms`
  );
}

function testPacerAdaptsAndRecovers() {
  const pacer = new RequestPacer({
    minIntervalMs: 10,
    adaptiveMaxIntervalMs: 30,
    adaptiveStepMs: 10,
    recoverySuccesses: 2,
  });

  assert.strictEqual(pacer.getCurrentIntervalMs(), 10);
  pacer.noteRateLimit(1);
  assert.strictEqual(pacer.getCurrentIntervalMs(), 20);
  pacer.noteRateLimit(1);
  assert.strictEqual(pacer.getCurrentIntervalMs(), 30);
  pacer.noteSuccess();
  assert.strictEqual(pacer.getCurrentIntervalMs(), 30);
  pacer.noteSuccess();
  assert.strictEqual(pacer.getCurrentIntervalMs(), 20);
}

function testSelectMonthEntriesForRangeSkipsUnrelatedMonths() {
  const sources = [
    {
      drive_id: 'drive-a',
      label: 'team-a',
      months: {
        '2月': 'folder-feb',
        '3月': 'folder-mar',
        '4月': 'folder-apr',
        '5月': 'folder-may',
        '6月': 'folder-jun',
        '_root': 'folder-root',
        '2026年': 'folder-year',
      },
    },
  ];

  const selected = selectMonthEntriesForRange(sources, '03-30', '05-30', 'fallback');
  const monthNames = selected.map(entry => entry.monthName);

  assert.deepStrictEqual(monthNames, ['3月', '4月', '5月', '_root', '2026年']);
  assert(selected.every(entry => entry.source.drive_id === 'drive-a'));
  assert(selected.every(entry => entry.label === 'team-a'));
}

async function main() {
  testSelectMonthEntriesForRangeSkipsUnrelatedMonths();
  testPacerAdaptsAndRecovers();
  await testPacerCoolsDownAfterRateLimit();
  console.log('rate-limit controls tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
