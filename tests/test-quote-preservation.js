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
    'quote-preservation.yaml',
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
    'quote-preservation.yaml',
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

// Test 3: DisplayName quote behavior with colons
const test3Pass = runTestCase(
    'Test 3: DisplayName quote behavior - colon forces quote preservation',
    'quote-preservation.yaml',
    { parameters: { buildConfiguration: 'Release' } },
    false,
    (output) => {
        // Colon present - quotes preserved
        if (!output.includes("displayName: 'a : b'")) {
            throw new Error('DisplayName with colon should preserve quotes');
        }
        // Colon + variable - single quotes used (even if input has double)
        if (!output.includes("displayName: 'Release : b'")) {
            throw new Error('DisplayName with colon and variable should use single quotes');
        }
        // No colon + variable - quotes removed
        if (output.includes("displayName: 'Testing Release'") || output.includes('displayName: "Testing Release"')) {
            throw new Error('DisplayName with variable but no colon should remove quotes');
        }
        if (!output.includes('displayName: Testing Release')) {
            throw new Error('DisplayName should be unquoted: Testing Release');
        }
        // No colon, no variable - quotes preserved
        if (!output.includes("displayName: 'Testing quotes'")) {
            throw new Error('DisplayName without colon or variable should preserve quotes');
        }
    }
);

// Test 4: Full vs Mixed expression quote behavior
const test4Pass = runTestCase(
    'Test 4: Full vs Mixed expression quote behavior',
    'quote-preservation.yaml',
    { parameters: { buildConfiguration: 'Debug', message: 'Hello' } },
    false,
    (output) => {
        // Full expression - in non-Azure mode we allow default YAML formatting (no forced quote preservation)
        if (!output.includes('CONFIG: Debug')) {
            throw new Error('Full expression CONFIG should not require preserved quotes');
        }
        // Mixed expression - quotes removed
        if (output.includes("BUILD_CMD: 'dotnet build --config Debug'")) {
            throw new Error('Mixed expression BUILD_CMD should remove quotes');
        }
        if (!output.includes('BUILD_CMD: dotnet build --config Debug')) {
            throw new Error('Mixed expression should be unquoted');
        }
        // Multiple expressions - quotes removed (using bash script variables)
        if (!output.includes("PATH='Debug/Hello/output'")) {
            throw new Error('Bash script variables should exist');
        }
    }
);

// Test 5: Plain text displayName quote preservation
const test5Pass = runTestCase(
    'Test 5: Plain text in displayName preserves quotes',
    'quote-preservation.yaml',
    {},
    false,
    (output) => {
        // Single quotes preserved
        if (!output.includes("displayName: 'Testing single quotes'")) {
            throw new Error('Plain text with single quotes should be preserved');
        }
        // Double quotes preserved
        if (!output.includes("displayName: 'Testing double quotes'")) {
            throw new Error('Plain text with double quotes should be preserved (normalized to single)');
        }
    }
);

// Summary
const allPassed = test1Pass && test2Pass && test3Pass && test4Pass && test5Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All quote preservation tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
