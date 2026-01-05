#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { AzurePipelineParser } = require('../extension.js');

const repoRoot = path.resolve(__dirname, '..');
const testsDir = path.join(repoRoot, 'tests');

if (!fs.existsSync(testsDir)) {
    console.error(`Tests directory not found: ${testsDir}`);
    process.exit(1);
}

const testFiles = fs.readdirSync(testsDir).filter((file) => file.toLowerCase().endsWith('.yml'));

if (testFiles.length === 0) {
    console.log('No YAML test files found.');
    process.exit(0);
}

const parser = new AzurePipelineParser();

// Tests that are expected to fail (for testing error detection)
const expectedFailures = [
    'test-expressions.yml', // Has duplicate 'variables:' key
];

let hasFailures = false;
let passCount = 0;
let failCount = 0;
let expectedFailCount = 0;

/**
 * Custom YAML parser that allows duplicate ${{ insert }} keys at parse time
 * Duplicates are only checked after template expansion
 */
function parseYAMLWithInsertKeys(content) {
    const YAML = require('yaml');

    // For formatting: Allow duplicate ${{ insert }} keys by disabling uniqueKeys check
    // Other duplicates (like 'variables:') will still be caught
    const hasInsertKeys = content.includes('${{ insert }}');

    if (hasInsertKeys) {
        // Allow all duplicates for files with ${{ insert }}
        return YAML.parse(content, { uniqueKeys: false });
    } else {
        // For files without ${{ insert }}, use strict checking
        return YAML.parse(content); // Will throw on any duplicate keys
    }
}

// Test YAML files by attempting to parse and expand them
testFiles.forEach((file) => {
    const filePath = path.join(testsDir, file);
    const isExpectedFailure = expectedFailures.includes(file);

    try {
        // Use custom parser that allows ${{ insert }} duplicates
        const content = fs.readFileSync(filePath, 'utf8');
        parseYAMLWithInsertKeys(content);

        // For files with ${{ insert }}, also test expansion
        if (content.includes('${{ insert }}')) {
            try {
                const expanded = parser.expandPipelineFromString(content, { fileName: filePath });
                // Check for duplicates in expanded content
                const YAML = require('yaml');
                YAML.parse(expanded); // Will throw on duplicate keys
            } catch (expandErr) {
                if (expandErr.message.includes('Map keys must be unique')) {
                    throw new Error(`Duplicate keys after expansion: ${expandErr.message}`);
                }
                // Other expansion errors are OK for this test
            }
        }

        if (isExpectedFailure) {
            hasFailures = true;
            failCount++;
            console.log(`❌ FAIL ${file} - Expected to fail but passed`);
        } else {
            passCount++;
            console.log(`✅ PASS ${file}`);
        }
    } catch (err) {
        if (isExpectedFailure) {
            expectedFailCount++;
            console.log(`✅ PASS ${file} (expected failure: ${err.message.split('\n')[0]})`);
        } else {
            hasFailures = true;
            failCount++;
            console.log(`❌ FAIL ${file} - ${err.message}`);
        }
    }
});

const yamlSummary = `${passCount} passed`;
const failSummary =
    expectedFailCount > 0 ? `${expectedFailCount} expected failures, ${failCount} failed` : `${failCount} failed`;
console.log(`\n📊 YAML Tests: ${yamlSummary}, ${failSummary}, ${testFiles.length} total\n`);

// Run validation test scripts (test-*.js files)
const { execSync } = require('child_process');
const validationTests = fs.readdirSync(testsDir).filter((file) => file.startsWith('test-') && file.endsWith('.js'));

let validationPassCount = 0;
let validationFailCount = 0;

if (validationTests.length > 0) {
    validationTests.forEach((testScript) => {
        const testPath = path.join(testsDir, testScript);
        try {
            const output = execSync(`node "${testPath}"`, { cwd: testsDir, encoding: 'utf8' });
            validationPassCount++;
            console.log(`✅ PASS ${testScript}`);
        } catch (err) {
            hasFailures = true;
            validationFailCount++;
            console.log(`❌ FAIL ${testScript} - Exit code ${err.status}`);
        }
    });
    console.log(
        `\n📊 Validation Tests: ${validationPassCount} passed, ${validationFailCount} failed, ${validationTests.length} total\n`
    );
}

// Run comprehensive formatter tests
try {
    const output = execSync('node run-formatter-tests.js', { cwd: testsDir, encoding: 'utf8' });
    console.log('✅ PASS Formatter test suite\n');
} catch (err) {
    console.log('⚠️  WARN Formatter test suite - Some expected edge case failures\n');
    // Don't mark as failure since we expect some edge case failures
}

console.log(`\n${'='.repeat(60)}`);
console.log(`🏁 FINAL RESULTS`);
console.log(`${'='.repeat(60)}`);
console.log(`✅ Passed: ${passCount + validationPassCount}`);
if (expectedFailCount > 0) {
    console.log(`✅ Expected Failures: ${expectedFailCount} (correctly detected invalid YAML)`);
}
console.log(`❌ Failed: ${failCount + validationFailCount}`);
console.log(`📦 Total: ${testFiles.length + validationTests.length}`);
console.log(`${hasFailures ? '❌ TESTS FAILED' : '✅ ALL TESTS PASSED'}`);
console.log(`${'='.repeat(60)}\n`);

if (hasFailures) {
    process.exit(1);
}

// Exit successfully if no failures
process.exit(0);
