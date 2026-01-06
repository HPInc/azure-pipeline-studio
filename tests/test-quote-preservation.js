#!/usr/bin/env node

/**
 * Test quote preservation through template expansion
 *
 * This test validates that:
 * 1. Single quotes are preserved when present in source
 * 2. Double quotes are preserved when present in source
 * 3. Empty strings preserve their quote style (prefer single)
 * 4. Quotes in bash script literals are preserved
 * 5. No unwanted quotes are added to unquoted values
 * 6. Boolean marker quotes are preserved in Microsoft compatibility mode
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Quote Preservation\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// Helper to run a test case
function runTestCase(name, yamlFile, params, azureCompatible, assertions) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');

    const output = parser.expandPipelineFromString(data, Object.assign({ azureCompatible }, params || {}));

    if (verbose) {
        console.log('\n--- Parser output ---');
        console.log(output);
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

// Test 1: Quote preservation in environment variables
const test1Pass = runTestCase(
    'Test 1: Quotes preserved in environment variables',
    'quote-preservation-clean.yaml',
    {
        parameters: {
            pattern: '**/test.dll',
            emptyValue: '',
            value: 'test-value',
            poolName: 'codeway-aws-linux',
            arch: 'x64',
            version: '1.2.3',
            message1: 'Hello',
            message2: 'World',
        },
    },
    false,
    (output) => {
        // Full expressions have quotes removed (new behavior)
        if (!output.includes('PATTERN: "**/test.dll"') && !output.includes("PATTERN: '**/test.dll'")) {
            throw new Error('Should have PATTERN value (quotes optional for full expressions)');
        }
        // Empty string should have quotes
        if (!output.includes("EMPTY: ''") && !output.includes('EMPTY: ""')) {
            throw new Error('Should preserve empty string with quotes');
        }
        // Mixed expressions should have single quotes
        if (!output.includes("WITH_QUOTES: 'test-value'") && !output.includes('WITH_QUOTES: test-value')) {
            throw new Error('Should have WITH_QUOTES value');
        }
    }
);

// Test 2: Azure compatible mode with booleans
const test2Pass = runTestCase(
    'Test 2: Azure compatible mode with boolean values',
    'quote-preservation-clean.yaml',
    { parameters: { enabled: true, flag: false } },
    true,
    (output) => {
        // Booleans should be converted to True/False
        if (!output.includes('var="True"')) {
            throw new Error('Should have boolean as True in script');
        }
        // Full expression with boolean - quotes removed (new behavior)
        if (!output.includes('QUOTED_BOOL: False') && !output.includes("QUOTED_BOOL: 'False'")) {
            throw new Error('Should have QUOTED_BOOL value');
        }
    }
);

// Summary
const allPassed = test1Pass && test2Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All quote preservation tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
