const assert = require('assert');
const { stripInlineSourceRefs } = require('./shared');

assert.strictEqual(
  stripInlineSourceRefs('项目风险需持续跟进（来源：团队-20260428-会议记录）'),
  '项目风险需持续跟进'
);

assert.strictEqual(
  stripInlineSourceRefs('交付节奏存在延期风险（来源: Team-20260428-Weekly）'),
  '交付节奏存在延期风险'
);

assert.strictEqual(
  stripInlineSourceRefs('需推进验收，来源：团队-会议。'),
  '需推进验收。'
);

console.log('comprehensive source stripping tests passed');
