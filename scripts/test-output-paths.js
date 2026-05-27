const assert = require('assert');
const path = require('path');
const fs = require('fs');
const {
  resolveWorkspaceDir,
  ensureOutputDir,
  outputPath,
  findInputFile,
  writeOutputJson
} = require('./shared');

const workspaceDir = resolveWorkspaceDir();
const outputsDir = path.join(workspaceDir, 'outputs');
const tempOutput = path.join(outputsDir, '__test-output-paths.json');
const legacyInput = path.join(workspaceDir, '__test-output-paths-legacy.json');
const modernInput = path.join(outputsDir, '__test-output-paths-modern.json');

try {
  assert.strictEqual(outputPath('__test-output-paths.json'), tempOutput);
  assert.strictEqual(ensureOutputDir(), outputsDir);
  assert.ok(fs.existsSync(outputsDir), 'ensureOutputDir creates outputs directory');

  writeOutputJson('__test-output-paths.json', { ok: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(tempOutput, 'utf-8')), { ok: true });

  fs.writeFileSync(legacyInput, JSON.stringify({ source: 'legacy' }), 'utf-8');
  assert.strictEqual(findInputFile('__test-output-paths-legacy.json'), legacyInput);

  fs.writeFileSync(modernInput, JSON.stringify({ source: 'outputs' }), 'utf-8');
  fs.writeFileSync(path.join(workspaceDir, '__test-output-paths-modern.json'), JSON.stringify({ source: 'legacy' }), 'utf-8');
  assert.strictEqual(findInputFile('__test-output-paths-modern.json'), modernInput);

  console.log('output path tests passed');
} finally {
  for (const file of [
    tempOutput,
    legacyInput,
    modernInput,
    path.join(workspaceDir, '__test-output-paths-modern.json')
  ]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}
