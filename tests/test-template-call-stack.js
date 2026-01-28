#!/usr/bin/env node

/**
 * Test template call stack error formatting
 *
 * This test validates that:
 * 1. Template-not-found errors include formatted call stack
 * 2. Repository-missing errors include formatted call stack
 * 3. Parse-failure errors include formatted call stack
 * 4. Parameter validation errors include formatted call stack
 * 5. Call stack shows proper nesting with Unicode formatting
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Template Call Stack Error Formatting\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// Helper to run an error test case
function runErrorTestCase(name, yamlFile, params, expectedError, stackAssertions) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');
    const baseDir = path.join(__dirname, 'inputs');

    const options = {
        baseDir,
        fileName: filePath,
        ...params,
    };

    let passed = true;
    try {
        const output = parser.expandPipelineFromString(data, options);
        console.log('❌ FAIL: Expected error but expansion succeeded\n');
        if (verbose) {
            console.log('Unexpected output:', output);
        }
        passed = false;
    } catch (error) {
        const errorMsg = error.message;

        if (verbose) {
            console.log('\n--- Error message ---');
            console.log(errorMsg);
            console.log('--- end error message ---\n');
        }

        try {
            // Check expected error message
            if (!errorMsg.includes(expectedError)) {
                throw new Error(`Expected error message to contain "${expectedError}" but got: ${errorMsg}`);
            }

            // Check for call stack presence
            if (!errorMsg.includes('Template call stack:')) {
                throw new Error('Error message missing "Template call stack:"');
            }

            // Run additional stack assertions
            if (stackAssertions) {
                stackAssertions(errorMsg);
            }

            console.log('✅ PASS\n');
        } catch (assertError) {
            console.log('❌ FAIL: ' + assertError.message + '\n');
            passed = false;
        }
    }

    return passed;
}

// Test 1: Template-not-found error with call stack
const test1Pass = runErrorTestCase(
    'Test 1: Template-not-found shows call stack',
    'error-template-not-found.yaml',
    {},
    'Template file not found',
    (errorMsg) => {
        // Should show the root file in the stack
        if (!errorMsg.includes('error-template-not-found.yaml')) {
            throw new Error('Call stack missing root file');
        }

        // Should show the missing template reference
        if (!errorMsg.includes('missing-template.yaml')) {
            throw new Error('Error message missing template reference');
        }
    }
);

// Test 2: Repository-missing error with call stack
const test2Pass = runErrorTestCase(
    'Test 2: Repository-missing shows call stack',
    'error-repo-missing.yaml',
    {
        resources: {
            repositories: [{ repository: 'self', type: 'git' }],
        },
    },
    "Repository resource 'unknownrepo' is not defined",
    (errorMsg) => {
        // Should show the root file in the stack
        if (!errorMsg.includes('error-repo-missing.yaml')) {
            throw new Error('Call stack missing root file');
        }
    }
);

// Test 3: Parse-failure error with call stack
const test3Pass = runErrorTestCase(
    'Test 3: Parse-failure shows call stack',
    'error-parse-failure-root.yaml',
    {},
    'Failed to parse template',
    (errorMsg) => {
        // Should show the root file in the stack
        if (!errorMsg.includes('error-parse-failure-root.yaml')) {
            throw new Error('Call stack missing root file');
        }

        // Should mention the bad template
        if (!errorMsg.includes('bad-yaml-template.yaml')) {
            throw new Error('Error message missing bad template reference');
        }
    }
);

// Test 4: Parameter validation error with nested call stack
const test4Pass = runErrorTestCase(
    'Test 4: Parameter validation shows nested call stack',
    'error-param-validation-nested.yaml',
    {},
    'Unknown parameter(s) for template',
    (errorMsg) => {
        // Should show the root file
        if (!errorMsg.includes('error-param-validation-nested.yaml')) {
            throw new Error('Call stack missing root file');
        }

        // Should show intermediate template
        if (!errorMsg.includes('intermediate-template.yaml')) {
            throw new Error('Call stack missing intermediate template');
        }

        // Should show final template with the error
        if (!errorMsg.includes('final-template.yaml')) {
            throw new Error('Call stack missing final template');
        }

        // Check for Unicode formatting (└──)
        if (!errorMsg.includes('└──')) {
            throw new Error('Call stack missing Unicode formatting');
        }
    }
);

// Test 5: Multi-level template call stack ordering
const test5Pass = runErrorTestCase(
    'Test 5: Call stack shows correct ordering',
    'error-multilevel-stack.yaml',
    {},
    'Template file not found',
    (errorMsg) => {
        // Extract the call stack section
        const stackMatch = errorMsg.match(/Template call stack:([\s\S]*?)(?:\n\n|$)/);
        if (!stackMatch) {
            throw new Error('Could not extract call stack section');
        }

        const stackSection = stackMatch[1];
        const lines = stackSection.split('\n').filter((line) => line.trim());

        // Should have 3 levels: root -> level1 -> level2 (missing)
        if (lines.length < 2) {
            throw new Error('Call stack should have at least 2 entries');
        }

        // First line should be the root
        if (!lines[0].includes('error-multilevel-stack.yaml')) {
            throw new Error('First stack entry should be root file');
        }

        // Second line should be indented and show intermediate template
        if (!lines[1].includes('└──') || !lines[1].includes('level1-template.yaml')) {
            throw new Error('Second stack entry should show level1 template with indentation');
        }
    }
);

// Summary
console.log('='.repeat(70));
const totalTests = 5;
const passedTests = [test1Pass, test2Pass, test3Pass, test4Pass, test5Pass].filter(Boolean).length;
const failedTests = totalTests - passedTests;

console.log(`Total tests: ${totalTests}`);
console.log(`Passed: ${passedTests} ✅`);
console.log(`Failed: ${failedTests} ❌`);
console.log('='.repeat(70));

if (failedTests === 0) {
    console.log('\n🎉 All template call stack tests passed!\n');
    process.exit(0);
} else {
    console.log('\n❌ Some tests failed.\n');
    process.exit(1);
}
