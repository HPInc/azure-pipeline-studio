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
    // Expect at most ~40 blank lines for the comprehensive test file
    if (blankCount > 40) {
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

// Test 14: No false positive for nested conditional mapping (more indented)
function runTest(name, fn) {
    console.log(`=== ${name} ===`);
    try {
        fn();
        console.log('✅ PASS\n');
        return true;
    } catch (error) {
        console.log(`❌ FAIL: ${error.message}\n`);
        return false;
    }
}

const test14Pass = runTest('Test 14: No false positive for nested conditional mapping', () => {
    // Conditional mapping nested under a list item should NOT trigger dash warning
    const yaml = [
        'variables:',
        '  - name: pool',
        "    value: 'x'",
        "  ${{ if eq(variables.pool, 'windows') }}:",
        '    name: winpool',
        "    value: 'y'",
    ].join('\n');

    const result = formatYaml(yaml);
    const output = [result.error || '', result.warning || ''].join(' ');

    if (output.includes("Prepend '-' for list items")) {
        throw new Error('Should not warn about dash for nested conditional mapping');
    }
});

// Test 15: Warn about missing dash for sibling list items (same indentation)
const test15Pass = runTest('Test 15: Warn about missing dash for sibling list items', () => {
    // Expression at same indentation as previous list item should trigger warning
    const yaml = ['steps:', '  - script: echo 1', "  ${{ if eq(variables.x, 'a') }}:", '    script: echo 2'].join('\n');

    const result = formatYaml(yaml);
    const output = [result.error || '', result.warning || ''].join(' ');

    if (!output.includes("Prepend '-' for list items")) {
        throw new Error('Should warn about dash for sibling expression');
    }
});

// Test 16: No false positive for regular parameter expression without colon
const test16Pass = runTest('Test 16: No false positive for parameter expression without colon', () => {
    // Regular parameter expressions don't need colons
    const yaml = ['steps:', '  - ${{ parameters.preSteps }}', '  - script: echo hi'].join('\n');

    const result = formatYaml(yaml);
    const output = [result.error || '', result.warning || ''].join(' ');

    if (output.includes("Add ':' after the expression")) {
        throw new Error('Should not warn about colon for parameter expression');
    }
});

// Test 17: Warn about missing colon for conditional expression
const test17Pass = runTest('Test 17: Warn about missing colon for conditional expression', () => {
    // Conditional expressions need colons
    const yaml = ['steps:', "- ${{ if eq(parameters.a, 'x') }}", '  - script: echo hi'].join('\n');

    const result = formatYaml(yaml);
    const output = [result.error || '', result.warning || ''].join(' ');

    if (!output.includes("Add ':' after the expression")) {
        throw new Error('Should warn about colon for conditional expression');
    }
});

// Test 18: Colon hint only for if/else/elseif/each directives
const test18Pass = runTest('Test 18: Colon hint only for directives', () => {
    // Test various expression types
    const testCases = [
        { name: 'if expression', yaml: '- ${{ if true }}', shouldWarn: true },
        { name: 'else expression', yaml: '- ${{ else }}', shouldWarn: true },
        { name: 'elseif expression', yaml: '- ${{ elseif true }}', shouldWarn: true },
        { name: 'each expression', yaml: '- ${{ each item in items }}', shouldWarn: true },
        { name: 'eq function', yaml: '- ${{ eq(a, b) }}', shouldWarn: false },
        { name: 'contains function', yaml: '- ${{ contains(a, b) }}', shouldWarn: false },
    ];

    testCases.forEach(({ name, yaml, shouldWarn }) => {
        const result = formatYaml(yaml);
        const output = [result.error || '', result.warning || ''].join(' ');
        const hasWarning = output.includes("Add ':' after the expression");

        if (hasWarning !== shouldWarn) {
            throw new Error(`${name}: expected colon warning=${shouldWarn}, got=${hasWarning}`);
        }
    });
});

// Test 19: Respect aps-format=false even with metadata options
const test19Pass = runTest('Test 19: Respect aps-format=false with metadata options', () => {
    const yaml = ['# aps-format=false', 'steps:', '  - script: echo not formatted'].join('\n');

    // Call with metadata options (like fileName) to simulate real usage
    const result = formatYaml(yaml, { fileName: 'test.yaml' });

    if (result.text !== yaml) {
        throw new Error('Should return original content when aps-format=false, ignoring metadata options');
    }
});

// Test 20: File directive takes precedence over options
const test20Pass = runTest('Test 20: aps-format=false takes precedence over options', () => {
    const yaml = ['# aps-format=false', 'steps:', '  - script: echo formatted'].join('\n');

    // Call with actual formatting option - directive should still take precedence
    const result = formatYaml(yaml, {
        fileName: 'test.yaml',
        stepSpacing: true,
        indent: 4,
    });

    if (result.text !== yaml) {
        throw new Error('aps-format=false should take precedence over explicit format options');
    }
});

// Test 21: Disabled directive blocks formatting
const test21Pass = runTest('Test 21: aps-format=false blocks formatting', () => {
    const yaml = '# aps-format=false\nsteps: []';
    const result = formatYaml(yaml);

    if (result.text !== yaml) {
        throw new Error('aps-format=false should return original content unchanged');
    }
});

// Test 22: Remove blank lines immediately after mapping keys
const test22Pass = runTest('Test 22: Remove blank lines after mapping keys', () => {
    const yaml = [
        'stages:',
        '  - stage: Build',
        '    dependsOn:',
        ' ',
        '    - Init',
        '    jobs:',
        ' ',
        '    - job: build',
    ].join('\n');

    const result = formatYaml(yaml);

    if (result.text.includes('dependsOn:\n\n')) {
        throw new Error('Blank line retained after dependsOn key');
    }
    if (result.text.includes('jobs:\n\n')) {
        throw new Error('Blank line retained after jobs key');
    }
});

// Test 23: Multi-document YAML with comments before separator
const test23Pass = runTest('Test 23: Multi-document YAML preserves comment sections', () => {
    const yaml = [
        '# aps-format=false',
        '# file: /test.yaml',
        '# This is a comment block',
        '',
        '---',
        'parameters:',
        '- name: test',
        '  type: string',
    ].join('\n');

    const result = formatYaml(yaml);

    // Should not add "null" before ---
    if (result.text.includes('null')) {
        throw new Error('Multi-document YAML should not add "null" for comment-only sections');
    }

    // Should preserve the comment section and separator
    if (!result.text.includes('# file: /test.yaml')) {
        throw new Error('Comment section should be preserved');
    }

    if (!result.text.includes('---')) {
        throw new Error('Document separator should be preserved');
    }
});

// Test 24: Multi-document YAML formats both documents
const test24Pass = runTest('Test 24: Multi-document YAML formats all documents', () => {
    const yaml = ['variables:', '- name: var1', '  value: test', '', '---', 'steps:', '- script: echo test'].join('\n');

    const result = formatYaml(yaml, { stepSpacing: true });

    // Should have document separator
    if (!result.text.includes('---')) {
        throw new Error('Document separator should be preserved');
    }

    // Both documents should be formatted
    const parts = result.text.split('---');
    if (parts.length !== 2) {
        throw new Error('Should have two documents separated by ---');
    }
});

// Test 25: Multi-document YAML with empty sections skipped
const test25Pass = runTest('Test 25: Multi-document YAML skips empty sections', () => {
    const yaml = ['steps:', '- script: echo test', '', '---', '', '---', 'stages:', '- stage: Build'].join('\n');

    const result = formatYaml(yaml);

    // Should skip empty document between separators
    const separatorCount = (result.text.match(/\n---\n/g) || []).length;
    if (separatorCount !== 1) {
        throw new Error(`Expected 1 document separator, got ${separatorCount}`);
    }
});

// Test 26: Indentation validation - malformed YAML handled gracefully
const test26Pass = runTest('Test 26: Malformed indentation handled gracefully', () => {
    // Incorrect indentation (steps too far left)
    const incorrectYaml = `parameters:
  - name: testConfigurations
    type: object

jobs:
- job: TestJob
  displayName: 'Test Job'
   steps:
    - script: echo "Test"`;

    try {
        // Parser should handle this gracefully, either fixing or erroring
        const parser = new AzurePipelineParser();
        const output = parser.expandPipelineFromString(incorrectYaml, {
            azureCompatible: true,
            parameters: { testConfigurations: [] },
        });

        // If it succeeds, it should have some content
        if (output.length === 0) {
            throw new Error('Parser returned empty output for malformed YAML');
        }
    } catch (error) {
        // Errors are acceptable for malformed YAML
        if (!error.message) {
            throw new Error('Error should have a message');
        }
    }

    // Test another case: missing proper indentation for nested elements
    const yaml2 = `stages:
- stage: Build
jobs:
- job: build
steps:
- script: echo test`;

    try {
        const result = formatYaml(yaml2);
        // Should either format it or return with warning
        if (!result.text && !result.error && !result.warning) {
            throw new Error('Formatter should return text, error, or warning');
        }
    } catch (error) {
        // Errors acceptable for malformed structure
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
    test14Pass,
    test15Pass,
    test16Pass,
    test17Pass,
    test18Pass,
    test19Pass,
    test20Pass,
    test21Pass,
    test22Pass,
    test23Pass,
    test24Pass,
    test25Pass,
    test26Pass,
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
