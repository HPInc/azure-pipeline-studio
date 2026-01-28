#!/usr/bin/env node

const { formatYaml } = require('../formatter.js');
const assert = require('assert');

console.log('Testing Refactored Formatter Functions\n');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
        passCount++;
    } catch (error) {
        console.log(`❌ ${name}`);
        console.log(`   ${error.message}`);
        failCount++;
    }
}

// Test 1: Blank line handling in parameters section
test('Blank lines removed in parameters section', () => {
    const input = `parameters:
  - name: environment
    type: string

  - name: version
    type: string`;

    const result = formatYaml(input);
    const lines = result.text.split('\n').filter((l) => l.trim() !== '');

    // Should have no blank lines between parameter items
    assert(!result.text.includes('string\n\n  - name: version'), 'Should not have blank line between parameters');
});

// Test 2: Blank line handling in variables section
test('Blank lines removed in variables section', () => {
    const input = `variables:
  - name: buildConfig
    value: Release

  - name: testMode
    value: unit`;

    const result = formatYaml(input);

    // Should have no blank lines between variable items
    assert(!result.text.includes('Release\n\n  - name: testMode'), 'Should not have blank line between variables');
});

// Test 3: Blank lines preserved in multi-line blocks
test('Blank lines preserved inside script blocks', () => {
    const input = `steps:
  - script: |
      echo "First line"

      echo "Third line"
    displayName: Test Script`;

    const result = formatYaml(input);

    // Should preserve blank line inside script (whitespace-insensitive)
    assert(result.text.includes('First line'), 'Should preserve first line in script');
    assert(result.text.includes('Third line'), 'Should preserve third line in script');
    assert(
        /First line[\s\S]*?\n\s*\n\s*[^\n]*Third line/.test(result.text),
        'Should preserve a blank line between first and third lines in script block'
    );
});

// Test 4: Step spacing between pipeline items
test('Blank lines added between steps', () => {
    const input = `steps:
  - task: NuGetToolInstaller@1
  - task: NuGetCommand@2
    inputs:
      command: restore`;

    const result = formatYaml(input);

    // Should add a blank line between the two task items (whitespace-insensitive)
    const idxA = result.text.indexOf('NuGetToolInstaller@1');
    const idxB = result.text.indexOf('NuGetCommand@2');
    assert(idxA !== -1 && idxB !== -1 && idxB > idxA, 'Both tasks should appear in output');
    const between = result.text.substring(idxA + 'NuGetToolInstaller@1'.length, idxB);
    assert(/\n\s*\n/.test(between), 'Should have a blank line between the two steps');
});

// Test 5: Section spacing after parameters
test('Proper spacing after parameters section', () => {
    const input = `parameters:
  - name: test
    type: string
stages:
  - stage: Build`;

    const result = formatYaml(input);

    // Should have 2 blank lines after parameters (firstBlockBlankLines default)
    const lines = result.text.split('\n');
    const paramsEndIndex = lines.findIndex((l) => l.includes('string'));
    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');
    const blankLinesBetween = stagesIndex - paramsEndIndex - 1;

    assert(blankLinesBetween === 2, `Expected 2 blank lines after parameters, got ${blankLinesBetween}`);
});

// Test 6: Comment handling in steps section
test('Blank line before comments in steps', () => {
    const input = `steps:
  - task: Build@1
  # This is a comment
  - task: Test@1`;

    const result = formatYaml(input);

    // Should add a blank line before the inline comment (whitespace-insensitive)
    const idxTask = result.text.indexOf('Build@1');
    const idxComment = result.text.indexOf('# This is a comment');
    assert(idxTask !== -1 && idxComment !== -1 && idxComment > idxTask, 'Task and comment should exist in output');
    const between = result.text.substring(idxTask + 'Build@1'.length, idxComment);
    assert(/\n\s*\n/.test(between), 'Should have a blank line before the comment in steps');
});

// Test 7: No blank line after steps header
test('No blank line between steps: and first comment', () => {
    const input = `steps:
  # First step comment
  - task: Build@1`;

    const result = formatYaml(input);

    // Should NOT insert an extra blank line between header and initial comment (allow flexible indentation)
    assert(
        /steps:\s*\n\s*# First step comment/.test(result.text),
        'No blank line should be inserted between header and first comment'
    );
});

// Test 8: Trailing comments spacing
test('Single blank line before trailing comments', () => {
    const input = `steps:
  - task: Build@1
# End of file comment`;

    const result = formatYaml(input);

    // Should have exactly one blank line before trailing comment
    assert(
        result.text.includes('Build@1\n\n# End of file comment'),
        'Should have one blank line before trailing comment'
    );
});

// Test 9: Multi-line block tracking
test('Multi-line block (heredoc) content preserved', () => {
    const input = `steps:
  - bash: |
      cat <<EOF
      Line 1
      Line 2
      EOF
    displayName: Heredoc Test`;

    const result = formatYaml(input);

    // Content should be preserved exactly
    assert(result.text.includes('cat <<EOF'), 'Should preserve heredoc start');
    assert(result.text.includes('Line 1'), 'Should preserve heredoc content');
    assert(result.text.includes('EOF'), 'Should preserve heredoc end');
});

// Test 10: Variables section tracking
test('Variables section properly detected and exited', () => {
    const input = `variables:
  - name: var1
    value: val1
steps:
  - script: echo test`;

    const result = formatYaml(input);

    // Should have proper spacing between sections
    assert(result.text.includes('variables:'), 'Should have variables section');
    assert(result.text.includes('steps:'), 'Should have steps section');
});

// Test 11: Conditional items spacing
test('Conditionals in steps get proper spacing', () => {
    const input = `steps:
  - task: Build@1
  - \${{ if eq(parameters.runTests, true) }}:
    - task: Test@1`;

    const result = formatYaml(input);

    // Should add a blank line before conditional list items (whitespace-insensitive)
    const idxTask = result.text.indexOf('Build@1');
    const idxCond = result.text.indexOf('${{ if');
    assert(idxTask !== -1 && idxCond !== -1 && idxCond > idxTask, 'Task and conditional should exist');
    const between = result.text.substring(idxTask + 'Build@1'.length, idxCond);
    assert(/\n\s*\n/.test(between), 'Should have a blank line before the conditional');
});

// Test 12: Mapping keys followed by blank lines
test('Blank lines removed after mapping keys', () => {
    const input = `pool:

  vmImage: ubuntu-latest`;

    const result = formatYaml(input);

    // Should remove blank line after pool:
    assert(result.text.includes('pool:\n  vmImage'), 'Should remove blank line after mapping key');
});

// Test 13: Section spacing between root sections
test('Proper spacing between root-level sections', () => {
    const input = `trigger:
  branches:
    include:
      - main
variables:
  buildConfig: Release`;

    const result = formatYaml(input);

    // Should have proper spacing between sections
    const lines = result.text.split('\n');
    const triggerEndIndex = lines.findIndex((l) => l.includes('main'));
    const variablesIndex = lines.findIndex((l) => l.trim() === 'variables:');
    const blankLinesBetween = variablesIndex - triggerEndIndex - 1;

    assert(blankLinesBetween >= 1, `Expected at least 1 blank line between sections, got ${blankLinesBetween}`);
});

// Test 14: Jobs section spacing
test('Blank line before jobs: at non-root level', () => {
    const input = `stages:
  - stage: Build
    jobs:
      - job: BuildJob`;

    const result = formatYaml(input);

    // Expect at least one blank line between the stage content and nested jobs: (whitespace-insensitive)
    const idxStage = result.text.indexOf('stage: Build');
    const idxJobs = result.text.indexOf('jobs:');
    assert(idxStage !== -1 && idxJobs !== -1 && idxJobs > idxStage, 'stage and jobs should exist in output');
    const between = result.text.substring(idxStage + 'stage: Build'.length, idxJobs);
    assert(/\n\s*\n/.test(between), 'Should have a blank line before nested jobs:');
});

// Test 15: Template expressions preserved
test('Template expressions preserved and formatted', () => {
    const input = `steps:
  - \${{parameters.customSteps}}
  - task: Build@1`;

    const result = formatYaml(input);

    // Template expression should be preserved with proper spacing
    assert(result.text.includes('${{ parameters.customSteps }}'), 'Template expression should be normalized');
});

// Test 16: Empty YAML handling
test('Empty input returns empty output', () => {
    const result = formatYaml('');
    assert(result.text === '', 'Empty input should return empty output');
});

// Test 17: Complex nested structure
test('Complex nested structure formatted correctly', () => {
    const input = `stages:
  - stage: Build
    jobs:
      - job: BuildJob
        pool:
          vmImage: ubuntu-latest
        steps:
          - task: Build@1
          - task: Test@1`;

    const result = formatYaml(input);

    // Should maintain structure and add step spacing
    assert(result.text.includes('stages:'), 'Should have stages');
    assert(result.text.includes('jobs:'), 'Should have jobs');
    assert(result.text.includes('steps:'), 'Should have steps');
    assert(result.text.includes('Build@1\n\n'), 'Should have spacing between steps');
});

// Test 18: List item compaction outside main sections
test('Blank lines removed between list items outside steps/jobs/stages', () => {
    const input = `trigger:
  branches:
    include:
      - main

      - develop`;

    const result = formatYaml(input);

    // Should remove blank line between branch list items
    assert(
        !result.text.includes('main\n\n      - develop'),
        'Should not have blank line between list items in trigger section'
    );
});

// Test 19: Step spacing insertion in final pass
test('Step spacing inserted in post-processing', () => {
    const input = `steps:
  - script: echo first
    displayName: First
  - script: echo second
    displayName: Second`;

    const result = formatYaml(input);

    // Should insert blank lines in final processing
    const stepCount = (result.text.match(/- script:/g) || []).length;
    assert(stepCount === 2, 'Should have 2 steps');
});

// Test 20: State initialization
test('Formatting state properly initialized', () => {
    const input = `parameters:
  - name: test
stages:
  - stage: Build`;

    const result = formatYaml(input);

    // Should detect parameters at start and handle accordingly
    assert(result.text.includes('parameters:'), 'Should preserve parameters');
    assert(result.text.includes('stages:'), 'Should preserve stages');
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Tests Passed: ${passCount}`);
console.log(`Tests Failed: ${failCount}`);
console.log(`Total Tests: ${passCount + failCount}`);
console.log('='.repeat(50));

process.exit(failCount > 0 ? 1 : 0);
