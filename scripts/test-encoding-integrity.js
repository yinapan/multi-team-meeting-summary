const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.md', '.txt', '.yml', '.yaml', '.html', '.css']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'cache', 'outputs']);
const SUSPECT_PATTERNS = [
  /\uFFFD/,
  /\?{3,}/,
  new RegExp([
    '\u934f\u5726', '\u93c2', '\u6d7c', '\u7ed7', '\u9225', '\u9286',
    '\u9428', '\u6d93', '\u93c3', '\u95c2', '\u9365', '\u5be4',
    '\u7481', '\u93b6', '\u6748', '\u7eef', '\u7ee0', '\u59f9',
    '\u7f01', '\u93b5', '\u9422'
  ].join('|'))
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

const offenders = [];
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of SUSPECT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      offenders.push(`${path.relative(ROOT, file)}: ${match[0]}`);
      break;
    }
  }
}

assert.deepStrictEqual(offenders, []);
console.log('encoding integrity tests passed');
