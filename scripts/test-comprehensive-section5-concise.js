const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'generate-comprehensive-report.js'), 'utf-8');
const match = source.match(/function buildFallbackSection5[\s\S]*?\n}\n\n\/\/ ========== 主函数/);
assert(match, 'buildFallbackSection5 should exist');

const section5Source = match[0];

assert(section5Source.includes('5.1 高度概况'), 'fallback section 5 should use a concise high-level overview');
assert(section5Source.includes('5.2 建议'), 'fallback section 5 should keep recommendations as section 5.2');
assert(!section5Source.includes('strategic.forEach'), 'fallback section 5 should not expand by strategic theme');
assert(!section5Source.includes('推进较好'), 'fallback section 5 should not include detailed progress grading');

console.log('test-comprehensive-section5-concise: ok');
