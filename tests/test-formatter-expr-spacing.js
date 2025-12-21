const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { replaceTemplateExpressionsWithPlaceholders, restoreTemplateExpressions } = require('../formatter');

function runRoundtrip(input) {
    const { content, placeholderMap } = replaceTemplateExpressionsWithPlaceholders(input);
    const restored = restoreTemplateExpressions(content, placeholderMap);
    return restored;
}

// Test cases
const tests = [
    {
        name: 'single-line without spaces',
        input: 'foo: ${{bar}}',
        expected: 'foo: ${{ bar }}',
    },
    {
        name: 'single-line already spaced',
        input: 'foo: ${{ bar }}',
        expected: 'foo: ${{ bar }}',
    },
    {
        name: 'space before colon removed',
        input: 'foo: ${{ bar }} : baz',
        expected: 'foo: ${{ bar }}: baz',
    },
    {
        name: 'multi-line expression',
        input: 'script: |\n  echo ${{\n    parameters.x\n  }}',
        expected: 'script: |\n  echo ${{\n    parameters.x\n  }}',
    },
    {
        name: 'nested without spaces',
        input: 'pool: ${{variables.pool}}',
        expected: 'pool: ${{ variables.pool }}',
    },
    {
        name: 'multiple expressions',
        input: 'first: ${{a}}\nsecond: ${{b}}',
        expected: 'first: ${{ a }}\nsecond: ${{ b }}',
    },
    {
        name: 'dash list item expression',
        input: '- ${{insert}} :',
        expected: '- ${{ insert }}:',
    },
    {
        name: 'expression with tabs inside (preserve inner)',
        input: 'cmd: ${{\n\tparameters.x\n}}',
        expected: 'cmd: ${{\n\tparameters.x\n}}',
    },
];

for (const t of tests) {
    const out = runRoundtrip(t.input);
    try {
        assert.strictEqual(out, t.expected);
        console.log(`PASS: ${t.name}`);
    } catch (err) {
        console.error(`FAIL: ${t.name}`);
        console.error('  input   :', JSON.stringify(t.input));
        console.error('  expected:', JSON.stringify(t.expected));
        console.error('  actual  :', JSON.stringify(out));
        process.exitCode = 1;
    }
}

if (!process.exitCode) console.log('All tests passed.');
