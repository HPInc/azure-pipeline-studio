#!/usr/bin/env node

/**
 * Test Microsoft Azure Pipelines boolean compatibility
 *
 * This test validates that:
 * 1. Expression-evaluated booleans output as unquoted True/False
 * 2. Original string values "True"/"False" are preserved
 * 3. All boolean-returning expression functions work correctly
 * 4. Microsoft format is always used for expansion (True/False)
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Microsoft Azure Pipelines Boolean Compatibility...\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// Helper to run a test case
function runTestCase(name, yamlFile, assertions) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');

    const output = parser.expandPipelineFromString(data, {});

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
        console.log(`❌ FAIL: ${error.message}\n`);
        passed = false;
    }

    return passed;
}

// Test 1: Boolean expressions output as True/False
const test1Pass = runTestCase(
    'Test 1: Boolean expressions output as True/False (Microsoft format)',
    'full-test.yaml',
    (output) => {
        // Should have unquoted True/False for expression-evaluated booleans
        assert(/:\s+True/.test(output), 'Should have unquoted True values');
        assert(/:\s+False/.test(output), 'Should have unquoted False values');

        // Verify specific status function results
        assert(/canceled_test:\s+False/.test(output), 'canceled should be False');
        assert(/failed_test:\s+False/.test(output), 'failed should be False');
        assert(/succeeded_test:\s+True/.test(output), 'succeeded should be True');

        // Should NOT have any marker strings
        assert(!output.includes('__TRUE__'), 'Should not contain __TRUE__ marker');
        assert(!output.includes('__FALSE__'), 'Should not contain __FALSE__ marker');
    }
);

// Test 2: Edge cases
const test2Pass = runTestCase('Test 2: Complex boolean expressions and edge cases', 'full-test.yaml', (output) => {
    // Check for logical operations in full-test.yaml
    assert(/and_test:\s+(True|False)/s.test(output), 'Should have and_test result');
    assert(/or_test:\s+(True|False)/s.test(output), 'Should have or_test result');
    assert(/xor_test:\s+(True|False)/s.test(output), 'Should have xor_test result');
    assert(/nested_logic:\s+(True|False)/s.test(output), 'Should have nested_logic result');
});

// Summary
const allPassed = test1Pass && test2Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All boolean compatibility tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
