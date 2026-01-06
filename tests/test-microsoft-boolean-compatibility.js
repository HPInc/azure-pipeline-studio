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
    'boolean-compat.yaml',
    (output) => {
        // Should have unquoted True/False for expression-evaluated booleans
        assert(output.includes('value: True'), 'Should have unquoted True values');
        assert(output.includes('value: False'), 'Should have unquoted False values');

        // Verify specific variables
        assert(/name: isEqual\s+value: True/s.test(output), 'isEqual should be True');
        assert(/name: notEqual\s+value: True/s.test(output), 'notEqual should be True');
        assert(/name: orResult\s+value: False/s.test(output), 'orResult should be False');

        // Original string values should be preserved as quoted strings
        assert(
            output.includes('value: "True"') || output.includes("value: 'True'"),
            'String literals with "True" should remain quoted'
        );

        // Should NOT have any marker strings
        assert(!output.includes('__TRUE__'), 'Should not contain __TRUE__ marker');
        assert(!output.includes('__FALSE__'), 'Should not contain __FALSE__ marker');

        // Check script literal preserves quotes
        assert(output.includes('var="True"'), 'Boolean in script should be True with quotes preserved');
    }
);

// Test 2: Edge cases
const test2Pass = runTestCase(
    'Test 2: Complex boolean expressions and edge cases',
    'boolean-edge-cases.yaml',
    (output) => {
        assert(/name: complexAnd\s+value: False/s.test(output), 'complexAnd should be False');
        assert(/name: complexOr\s+value: True/s.test(output), 'complexOr should be True');
        assert(/name: nestedCondition\s+value: True/s.test(output), 'nestedCondition should be True');
        assert(/name: xorTest\s+value: True/s.test(output), 'xorTest should be True');
    }
);

// Summary
const allPassed = test1Pass && test2Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All boolean compatibility tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
