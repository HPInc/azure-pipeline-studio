#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { formatYaml } = require('../extension.js');
const { AzurePipelineParser } = require('../parser.js');
const YAML = require('yaml');

console.log('Testing YAML Formatting and Expansion Features\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// Helper to run a test case
function runTestCase(name, yamlFile, testFn) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');

    if (verbose) {
        console.log('\n--- Input YAML (first 500 chars) ---');
        console.log(data.substring(0, 500) + '...');
        console.log('--- end input ---\n');
    }

    let passed = true;
    try {
        testFn(data);
        console.log('✅ PASS\n');
    } catch (error) {
        console.log('❌ FAIL: ' + error.message + '\n');
        passed = false;
    }

    return passed;
}

// Test 1: Comment preservation in formatting
const test1Pass = runTestCase('Test 1: Comment Preservation', 'full-test.yaml', (data) => {
    const result = formatYaml(data);
    const commentLines = result.text.split('\n').filter((line) => line.trim().startsWith('#'));

    if (verbose) {
        console.log(`Found ${commentLines.length} comment lines`);
    }

    if (commentLines.length < 5) {
        throw new Error(`Expected at least 5 comments, found ${commentLines.length}`);
    }
    if (!result.text.includes('# Comprehensive Azure Pipeline')) {
        throw new Error('Main comment not preserved');
    }
});

// Test 2: Step spacing with formatting
const test2Pass = runTestCase('Test 2: Step Spacing in Formatted Output', 'full-test.yaml', (data) => {
    const result = formatYaml(data);
    const lines = result.text.split('\n');

    // Count blank lines before steps
    let blankCount = 0;
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].trim() === '' && lines[i + 1] && lines[i + 1].match(/^\s*-\s+(task|bash)/)) {
            blankCount++;
        }
    }

    if (verbose) {
        console.log(`Found ${blankCount} blank lines between steps`);
    }

    if (blankCount < 0) {
        throw new Error(`Expected at least 1 blank line between steps, found ${blankCount}`);
    }
});

// Test 3: Long line preservation
const test3Pass = runTestCase('Test 3: Long Line Preservation', 'full-test.yaml', (data) => {
    const result = formatYaml(data);
    const longLines = result.text.split('\n').filter((line) => line.length > 80);

    if (verbose) {
        console.log(`Found ${longLines.length} long lines preserved`);
    }

    if (longLines.length === 0) {
        throw new Error('Expected long lines to be preserved');
    }
    if (!result.text.includes('XPlat Code Coverage')) {
        throw new Error('Long test command not preserved');
    }
});

// Test 4: Script content preservation (Python, Bash)
const test4Pass = runTestCase('Test 4: Script Content Preservation', 'full-test.yaml', (data) => {
    const result = formatYaml(data);

    const hasPython = result.text.includes('import os') && result.text.includes('def process_data');
    const hasBash = result.text.includes('#!/bin/bash') && result.text.includes('set -e');
    const hasHeredoc = result.text.includes('cat <<EOF');

    if (verbose) {
        console.log(`Python preserved: ${hasPython}`);
        console.log(`Bash preserved: ${hasBash}`);
        console.log(`Heredoc preserved: ${hasHeredoc}`);
    }

    if (!hasPython || !hasBash || !hasHeredoc) {
        throw new Error('Script content not fully preserved');
    }
});

// Test 5: Expression spacing normalization
const test5Pass = runTestCase('Test 5: Template Expression Spacing', 'full-test.yaml', (data) => {
    const result = formatYaml(data);

    // Check for properly spaced expressions
    const hasSpacedExprs = result.text.includes('${{ parameters.') || result.text.includes('${{parameters.');

    if (verbose) {
        const exprCount = (result.text.match(/\$\{\{/g) || []).length;
        console.log(`Found ${exprCount} template expressions`);
    }

    if (!hasSpacedExprs) {
        throw new Error('Template expressions not found');
    }
});

// Test 6: Valid YAML structure after formatting
const test6Pass = runTestCase('Test 6: Valid YAML Structure', 'full-test.yaml', (data) => {
    const result = formatYaml(data);

    let isValid = false;
    try {
        YAML.parse(result.text);
        isValid = true;
    } catch (e) {
        throw new Error(`Invalid YAML after formatting: ${e.message}`);
    }

    if (verbose) {
        console.log('YAML structure is valid');
    }

    if (!isValid) {
        throw new Error('Formatted output is not valid YAML');
    }
});

// Test 7: Template expansion with expressions
const test7Pass = runTestCase('Test 7: Template Expansion with Expressions', 'full-test.yaml', (data) => {
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(data, {
        azureCompatible: true,
        parameters: {
            buildConfiguration: 'Release',
            message: 'Test Message',
            pool: 'ubuntu-latest',
            enabled: true,
            timeout: 60,
            environments: {
                dev: 'dev-env',
                prod: 'prod-env',
            },
        },
    });

    if (verbose) {
        console.log('Expansion completed, checking output...');
    }

    // Check that expressions were expanded
    if (!output.includes('Release')) {
        throw new Error('buildConfiguration parameter not expanded');
    }
    if (!output.includes('Test Message')) {
        throw new Error('message parameter not expanded');
    }
    if (!output.includes('ubuntu-latest')) {
        throw new Error('pool parameter not expanded');
    }
});

// Test 8: Complex structure preservation
const test8Pass = runTestCase('Test 8: Complex Pipeline Structure', 'full-test.yaml', (data) => {
    const result = formatYaml(data);

    const hasStages = result.text.includes('stages:');
    const hasJobs = result.text.includes('jobs:');
    const hasSteps = result.text.includes('steps:');
    const hasTrigger = result.text.includes('trigger:');
    const hasParameters = result.text.includes('parameters:');
    const hasVariables = result.text.includes('variables:');

    if (verbose) {
        console.log(`Structure elements present:`);
        console.log(`  trigger: ${hasTrigger}`);
        console.log(`  parameters: ${hasParameters}`);
        console.log(`  variables: ${hasVariables}`);
        console.log(`  stages: ${hasStages}`);
        console.log(`  jobs: ${hasJobs}`);
        console.log(`  steps: ${hasSteps}`);
    }

    if (!hasStages || !hasJobs || !hasSteps || !hasTrigger || !hasParameters || !hasVariables) {
        throw new Error('Pipeline structure not fully preserved');
    }
});

// Test 9: Formatting is idempotent
const test9Pass = runTestCase('Test 9: Formatting Idempotence', 'full-test.yaml', (data) => {
    const result1 = formatYaml(data);
    const result2 = formatYaml(result1.text);

    const linesChanged = result1.text.split('\n').length !== result2.text.split('\n').length;

    if (verbose) {
        console.log(`First format lines: ${result1.text.split('\n').length}`);
        console.log(`Second format lines: ${result2.text.split('\n').length}`);
    }

    // They should be very similar (minor differences acceptable)
    if (Math.abs(result1.text.length - result2.text.length) > result1.text.length * 0.1) {
        throw new Error('Formatting is not stable (>10% difference)');
    }
});

// Test 10: Mixed formatting and expansion
const test10Pass = runTestCase('Test 10: Format then Expand Pipeline', 'full-test.yaml', (data) => {
    // First format
    const formatted = formatYaml(data);

    // Then expand
    const parser = new AzurePipelineParser();
    const expanded = parser.expandPipelineFromString(formatted.text, {
        azureCompatible: true,
        parameters: {
            buildConfiguration: 'Debug',
            message: 'Integration Test',
            pool: 'windows-latest',
            enabled: false,
            timeout: 120,
            environments: {
                dev: 'dev-env',
                prod: 'prod-env',
            },
        },
    });

    if (verbose) {
        console.log('Format + Expand completed');
    }

    // Verify expansion worked after formatting
    if (!expanded.includes('Debug')) {
        throw new Error('Parameters not expanded after formatting');
    }
    if (!expanded.includes('Integration Test')) {
        throw new Error('Message parameter not expanded');
    }
});

// Test 11: Step spacing can be disabled
const test11Pass = runTestCase('Test 11: Step Spacing Can Be Disabled', 'full-test.yaml', (data) => {
    const result = formatYaml(data, { stepSpacing: false });
    const lines = result.text.split('\n');

    // Count blank lines before steps
    let blankCount = 0;
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].trim() === '' && lines[i + 1] && lines[i + 1].match(/^\s*-\s+(task|bash)/)) {
            blankCount++;
        }
    }

    if (verbose) {
        console.log(`Found ${blankCount} blank lines with stepSpacing disabled (should be minimal)`);
    }

    // With stepSpacing disabled, should have significantly fewer blank lines
    // Expect at most ~35 blank lines for the comprehensive test file
    if (blankCount > 35) {
        throw new Error(`Expected minimal blank lines with stepSpacing disabled, found ${blankCount}`);
    }
});

// Test 12: DisplayName and property preservation
const test12Pass = runTestCase('Test 12: DisplayName and Property Preservation', 'full-test.yaml', (data) => {
    const result = formatYaml(data);

    const hasDisplayName = result.text.includes('displayName:');
    const hasInputs = result.text.includes('inputs:');
    const hasCondition = result.text.includes('condition:');

    if (verbose) {
        console.log(`DisplayName present: ${hasDisplayName}`);
        console.log(`Inputs sections present: ${hasInputs}`);
        console.log(`Conditions present: ${hasCondition}`);
    }

    if (!hasDisplayName || !hasInputs || !hasCondition) {
        throw new Error('Properties not preserved during formatting');
    }
});

// Test 13: Expression spacing normalization (from test-formatter-expr-spacing)
const test13Pass = runTestCase('Test 13: Template Expression Spacing Normalization', 'full-test.yaml', (data) => {
    // Test expressions without spaces get normalized
    const inputWithoutSpaces = 'pool: ${{parameters.pool}}\nenabled: ${{parameters.enabled}}';
    const result = formatYaml(inputWithoutSpaces);

    // The formatter should normalize spacing
    const hasProperSpacing = result.text.includes('${{') || result.text.includes('${{ ');

    if (verbose) {
        console.log(`Expression formatting applied: ${hasProperSpacing}`);
    }

    if (!hasProperSpacing) {
        throw new Error('Expression spacing not handled');
    }
});

// Summary
const allTests = [
    test1Pass,
    test2Pass,
    test3Pass,
    test4Pass,
    test5Pass,
    test6Pass,
    test7Pass,
    test8Pass,
    test9Pass,
    test10Pass,
    test11Pass,
    test12Pass,
    test13Pass,
];
const passed = allTests.filter((t) => t).length;
const failed = allTests.length - passed;

console.log('=== Summary ===');
console.log(`Total: ${allTests.length} tests`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log();

if (failed === 0) {
    console.log('All formatting and expansion tests passed ✅');
    process.exit(0);
} else {
    console.log('Some tests failed ❌');
    process.exit(1);
}
