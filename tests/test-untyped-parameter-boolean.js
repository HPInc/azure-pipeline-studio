#!/usr/bin/env node

/**
 * Test untyped parameter boolean coercion
 *
 * Azure Pipelines treats parameters without a declared type (or with object-mode
 * parameter syntax) as strings. YAML parses bare `false`/`true` as JS booleans, so a
 * boolean `false` default/value must be stringified to "false" before expression
 * evaluation — otherwise `not(false)` would incorrectly return True instead of False.
 *
 * Scenarios covered:
 *   1. Object-mode parameters block (parameters: { foo: false }) — untyped, treated as string
 *   2. Array-mode with no type declared — treated as string
 *   3. Array-mode with type: boolean — JS boolean, not coerced
 *   4. Call-site passing boolean false to an untyped parameter — coerced to string
 *   5. Call-site passing boolean false to a type: boolean parameter — kept as boolean
 *   6. not() on untyped false parameter — must return False (string "false" is truthy → not = False)
 *   7. or() combining untyped false parameters — must be truthy (both are "false" strings)
 *   8. eq() comparison between untyped false and literal false — must be True
 */

const assert = require('assert');
const path = require('path');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

let allPassed = true;

function runTest(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
    } catch (err) {
        console.error(`❌ ${name}`);
        console.error(`   ${err.message}`);
        allPassed = false;
    }
}

function expand(yamlString) {
    return parser.expandPipelineFromString(yamlString.trim(), { azureCompatible: true });
}

// ---------------------------------------------------------------------------
// Test 1: Object-mode parameter default `false` is treated as string
// ---------------------------------------------------------------------------
runTest('Object-mode parameter: default false treated as string (not coerced to boolean)', () => {
    const yaml = [
        'parameters:',
        '  myFlag: false',
        '',
        'steps:',
        '- script: echo "flag=${{ parameters.myFlag }}"',
        '  displayName: Print flag',
    ].join('\n');
    const output = expand(yaml);
    assert(output.includes('flag=false'), `Expected flag=false, got:\n${output}`);
});

// ---------------------------------------------------------------------------
// Test 2: not() on object-mode false parameter — must return False
// (string "false" is truthy, so not("false") = False)
// ---------------------------------------------------------------------------
runTest('Object-mode parameter: not(false) returns False', () => {
    const yaml = [
        'parameters:',
        '  myFlag: false',
        '',
        'steps:',
        '- script: echo "result=${{ not(parameters.myFlag) }}"',
        '  displayName: Not flag',
    ].join('\n');
    const output = expand(yaml);
    assert(output.includes('result=False'), `Expected result=False, got:\n${output}`);
});

// ---------------------------------------------------------------------------
// Test 3: Array-mode parameter with no type — default false treated as string
// ---------------------------------------------------------------------------
runTest('Array-mode parameter (no type): default false treated as string', () => {
    const yaml = [
        'parameters:',
        '- name: myFlag',
        '  default: false',
        '',
        'steps:',
        '- script: echo "flag=${{ parameters.myFlag }}"',
        '  displayName: Print flag',
    ].join('\n');
    const output = expand(yaml);
    assert(output.includes('flag=false'), `Expected flag=false, got:\n${output}`);
});

// ---------------------------------------------------------------------------
// Test 4: Array-mode parameter with no type — not(false) returns False
// ---------------------------------------------------------------------------
runTest('Array-mode parameter (no type): not(false) returns False', () => {
    const yaml = [
        'parameters:',
        '- name: myFlag',
        '  default: false',
        '',
        'steps:',
        '- script: echo "result=${{ not(parameters.myFlag) }}"',
        '  displayName: Not flag',
    ].join('\n');
    const output = expand(yaml);
    assert(output.includes('result=False'), `Expected result=False, got:\n${output}`);
});

// ---------------------------------------------------------------------------
// Test 5: Array-mode parameter with type: boolean — not(false) returns True
// ---------------------------------------------------------------------------
runTest('Array-mode parameter (type: boolean): not(false) returns True', () => {
    const yaml = [
        'parameters:',
        '- name: myFlag',
        '  type: boolean',
        '  default: false',
        '',
        'steps:',
        '- script: echo "result=${{ not(parameters.myFlag) }}"',
        '  displayName: Not flag',
    ].join('\n');
    const output = expand(yaml);
    assert(output.includes('result=True'), `Expected result=True, got:\n${output}`);
});

// ---------------------------------------------------------------------------
// Test 6: eq() — untyped false parameter equals literal false
// ---------------------------------------------------------------------------
runTest('Object-mode parameter: eq(false, false) returns True', () => {
    const yaml = [
        'parameters:',
        '  myFlag: false',
        '',
        'steps:',
        '- script: echo "result=${{ eq(parameters.myFlag, false) }}"',
        '  displayName: Eq test',
    ].join('\n');
    const output = expand(yaml);
    assert(output.includes('result=True'), `Expected result=True, got:\n${output}`);
});

// ---------------------------------------------------------------------------
// Test 7: or() with two untyped false parameters — truthy strings → True
// ---------------------------------------------------------------------------
runTest('Object-mode parameters: or(false, false) returns True (string truthiness)', () => {
    const yaml = [
        'parameters:',
        '  flagA: false',
        '  flagB: false',
        '',
        'steps:',
        '- script: echo "result=${{ or(parameters.flagA, parameters.flagB) }}"',
        '  displayName: Or test',
    ].join('\n');
    const output = expand(yaml);
    assert(output.includes('result=True'), `Expected result=True (strings are truthy), got:\n${output}`);
});

// ---------------------------------------------------------------------------
// Test 8: File-based template — call-site passes boolean false to an untyped parameter
// ---------------------------------------------------------------------------
runTest('Template call: boolean false passed to untyped array-mode parameter — not() returns False', () => {
    const inputsDir = path.join(__dirname, 'inputs');
    const callerYaml = [
        'steps:',
        '- template: untyped-bool-template.yaml',
        '  parameters:',
        '    enableFeature: false',
    ].join('\n');
    const output = parser.expandPipelineFromString(callerYaml, {
        azureCompatible: true,
        baseDir: inputsDir,
    });
    assert(output.includes('enabled=false'), `Expected enabled=false, got:\n${output}`);
    assert(output.includes('not-enabled=False'), `Expected not-enabled=False, got:\n${output}`);
});

// ---------------------------------------------------------------------------
// Test 9: File-based template — call-site passes boolean false to type: boolean parameter
// ---------------------------------------------------------------------------
runTest('Template call: boolean false passed to type: boolean parameter — not() returns True', () => {
    const inputsDir = path.join(__dirname, 'inputs');
    const callerYaml = [
        'steps:',
        '- template: typed-bool-template.yaml',
        '  parameters:',
        '    enableFeature: false',
    ].join('\n');
    const output = parser.expandPipelineFromString(callerYaml, {
        azureCompatible: true,
        baseDir: inputsDir,
    });
    assert(output.includes('not-enabled=True'), `Expected not-enabled=True, got:\n${output}`);
});

// ---------------------------------------------------------------------------
// Test 10: Object-mode parameter — true default also treated as string
// ---------------------------------------------------------------------------
runTest('Object-mode parameter: default true treated as string — not(true) returns False', () => {
    const yaml = [
        'parameters:',
        '  myFlag: true',
        '',
        'steps:',
        '- script: echo "result=${{ not(parameters.myFlag) }}"',
        '  displayName: Not true flag',
    ].join('\n');
    const output = expand(yaml);
    // String "true" is truthy → not("true") = False
    assert(output.includes('result=False'), `Expected result=False, got:\n${output}`);
});

// ---------------------------------------------------------------------------
console.log();
console.log('='.repeat(70));
if (allPassed) {
    console.log('✅ All untyped parameter boolean coercion tests passed!');
    console.log('='.repeat(70));
    process.exit(0);
} else {
    console.log('❌ Some tests failed.');
    console.log('='.repeat(70));
    process.exit(1);
}
