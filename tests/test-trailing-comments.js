#!/usr/bin/env node
const assert = require('assert');
const { formatYaml } = require('../formatter.js');

console.log('Testing trailing comment spacing (single blank before trailing comment)');

const input = `steps:
- task: Build@1
  displayName: Build
# trailing comment line 1
# trailing comment line 2
`;

const result = formatYaml(input, { stepSpacing: true });

// Expect exactly one blank line between last content and trailing comment block
const lines = result.text.split('\n');
let lastContent = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !lines[i].trim().startsWith('#')) lastContent = i;
}

const firstTrailingComment = lines.findIndex((l, idx) => idx > lastContent && l.trim().startsWith('#'));
const blankCount = firstTrailingComment - lastContent - 1;

try {
    assert.strictEqual(blankCount, 1, `Expected 1 blank line before trailing comments, got ${blankCount}`);
    console.log('✅ PASS');
    process.exit(0);
} catch (err) {
    console.error('❌ FAIL:', err.message);
    console.log('\nFormatter output:\n');
    console.log(result.text);
    process.exit(1);
}
