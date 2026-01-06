#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Trailing Newlines in Microsoft Compatibility Mode\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// Helper to run a test case
function runTestCase(name, yamlFile, params, azureCompatible, assertions) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');

    const output = parser.expandPipelineFromString(data, Object.assign({ azureCompatible }, params || {}));

    if (verbose) {
        console.log('\n--- Parser output (last 100 chars) ---');
        console.log(JSON.stringify(output.slice(-100)));
        console.log('--- end output ---\n');
    }

    let passed = true;
    try {
        assertions(output);
        console.log('✅ PASS\n');
    } catch (error) {
        console.log('❌ FAIL: ' + error.message + '\n');
        passed = false;
    }

    return passed;
}

// Test 1: Microsoft compatibility mode should add 2 blank lines at EOF
const test1Pass = runTestCase(
    'Test 1: Microsoft compatibility mode adds 2 blank lines at EOF',
    'trailing-newlines.yaml',
    {},
    true,
    (output) => {
        const trailingNewlines = output.match(/\n+$/);
        const newlineCount = trailingNewlines ? trailingNewlines[0].length : 0;
        if (newlineCount !== 3) {
            throw new Error(`Expected 3 trailing newlines (2 blank lines), got ${newlineCount}`);
        }
    }
);

// Test 2: Normal mode should have single newline at EOF
const test2Pass = runTestCase(
    'Test 2: Normal mode has single newline at EOF',
    'trailing-newlines.yaml',
    {},
    false,
    (output) => {
        const trailingNewlines = output.match(/\n+$/);
        const newlineCount = trailingNewlines ? trailingNewlines[0].length : 0;
        if (newlineCount !== 1) {
            throw new Error(`Expected 1 trailing newline, got ${newlineCount}`);
        }
    }
);

// Test 3: Microsoft compatibility with parameters
const test3Pass = runTestCase(
    'Test 3: Microsoft compatibility with parameters preserves trailing newlines',
    'trailing-newlines-params.yaml',
    { parameters: { stageName: 'Deploy' } },
    true,
    (output) => {
        const trailingNewlines = output.match(/\n+$/);
        const newlineCount = trailingNewlines ? trailingNewlines[0].length : 0;
        if (newlineCount !== 3) {
            throw new Error(`Expected 3 trailing newlines, got ${newlineCount}`);
        }
    }
);

// Summary
const allPassed = test1Pass && test2Pass && test3Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All trailing newline tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
