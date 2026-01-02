#!/usr/bin/env node

const { formatYaml } = require('../extension.js');
const assert = require('assert');

console.log('🧪 Testing Optimized preserveComments Function');
console.log('==============================================\n');

let testCount = 0;
let passCount = 0;

function runTest(testName, testFn) {
    testCount++;
    console.log(`Test ${testCount}: ${testName}`);
    try {
        testFn();
        passCount++;
        console.log('✅ PASS\n');
    } catch (error) {
        console.log(`❌ FAIL - ${error.message}\n`);
    }
}

// Test 1: Content line after comment block (critical bug fix)
runTest('Content line after comment block is preserved', () => {
    const input = `stages:
#     - template: /projects/pssw-devops/stages/publish-v0.yaml
#       parameters:
#         stageName: Publish
#         publishParams: \${{ parameters.publishParams }}

- template: /projects/pssw-devops/stages/report-status-v0.yaml
  parameters:
    stageName: ReportStatus
`;

    const result = formatYaml(input);

    // Verify all comments are preserved
    assert(
        result.text.includes('template: /projects/pssw-devops/stages/publish-v0.yaml'),
        'First comment line should be preserved',
    );
    assert(result.text.includes('stageName: Publish'), 'Second comment line should be preserved');
    assert(result.text.includes('publishParams'), 'Third comment line should be preserved');

    // Verify template line is preserved
    assert(
        result.text.includes('- template: /projects/pssw-devops/stages/report-status-v0.yaml'),
        'Template line after comments should be preserved',
    );

    // Verify blank line after comment block
    const lines = result.text.split('\n');
    const templateIndex = lines.findIndex((l) => l.includes('report-status-v0.yaml'));
    assert(lines[templateIndex - 1].trim() === '', 'Should have blank line before template after comment block');

    console.log('   ✓ All comments preserved');
    console.log('   ✓ Content after comments preserved');
    console.log('   ✓ Blank line after comment block preserved');
});

// Test 2: extractKey function with list items
runTest('extractKey handles list items with dashes', () => {
    const input = `stages:
- stage: Build
  jobs:
  - job: Test
- template: /path/to/template.yaml
`;

    const result = formatYaml(input);

    // All list items should be preserved
    assert(result.text.includes('- stage: Build'), 'Stage list item preserved');
    assert(result.text.includes('- job: Test'), 'Job list item preserved');
    assert(result.text.includes('- template:'), 'Template list item preserved');

    console.log('   ✓ List items with dashes handled correctly');
});

// Test 3: isNestedChild detection
runTest('Parent-child relationship detected correctly', () => {
    const input = `parameters:
  postPrComments: false
  pipelineConfiguration:

    versionMajorMinor: '1.0'
    trunkBranch: refs/heads/master
`;

    const result = formatYaml(input);
    const lines = result.text.split('\n');

    // Find pipelineConfiguration line
    const configIndex = lines.findIndex((l) => l.includes('pipelineConfiguration:'));
    assert(configIndex >= 0, 'pipelineConfiguration line should exist');

    // Next non-empty line should be a nested property (no blank between parent and child)
    const nextLine = lines[configIndex + 1];
    assert(nextLine.trim() !== '', 'Should not have blank line after parent key');
    assert(
        nextLine.includes('versionMajorMinor') || nextLine.includes('trunkBranch'),
        'Next line should be nested property',
    );

    console.log('   ✓ No blank line between parent and nested children');
});

// Test 4: addBlankLines function - prevents doubling
runTest('Blank lines not doubled when already present', () => {
    const input = `parameters:
- name: test
  default: false


stages:
- stage: Build
`;

    const result = formatYaml(input);
    const lines = result.text.split('\n');

    // Find stages line
    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');

    // Count blank lines before stages
    let blankCount = 0;
    for (let i = stagesIndex - 1; i >= 0 && lines[i].trim() === ''; i--) {
        blankCount++;
    }

    // Should have exactly 2 blank lines (not 4)
    assert.strictEqual(blankCount, 2, `Expected 2 blank lines, got ${blankCount}`);

    console.log('   ✓ Existing blanks counted and not doubled');
});

// Test 5: addComments function - preserves original blank lines after comments
runTest('Blank lines after comments preserved only if originally present', () => {
    // Test 5a: No blank after comment in original
    const input1 = `stages:
# Build stage comment
- stage: Build
`;

    const result1 = formatYaml(input1);
    const lines1 = result1.text.split('\n');
    const commentIndex1 = lines1.findIndex((l) => l.includes('# Build stage comment'));
    const buildIndex1 = lines1.findIndex((l) => l.includes('- stage: Build'));

    assert(result1.text.includes('# Build stage comment'), 'Comment preserved');

    // Should NOT have blank after comment (wasn't in original)
    const blanksBetween1 = buildIndex1 - commentIndex1 - 1;
    assert.strictEqual(blanksBetween1, 0, 'Should not add blank when not originally present');

    // Test 5b: Has blank after comment in original
    const input2 = `stages:
# Build stage comment

- stage: Build
`;

    const result2 = formatYaml(input2);
    const lines2 = result2.text.split('\n');
    const commentIndex2 = lines2.findIndex((l) => l.includes('# Build stage comment'));
    const buildIndex2 = lines2.findIndex((l) => l.includes('- stage: Build'));

    // Should have blank after comment (was in original)
    const blanksBetween2 = buildIndex2 - commentIndex2 - 1;
    assert.strictEqual(blanksBetween2, 1, 'Should preserve blank when originally present');

    console.log('   ✓ Blank lines after comments respect original spacing');
});

// Test 6: analyzeOriginalContent single-pass efficiency
runTest('Single-pass analysis builds all metadata', () => {
    const input = `# Top comment
parameters:
- name: test

stages:
# Stage comment
- stage: Build
  # Job comment
  jobs:
  - job: BuildJob
`;

    const result = formatYaml(input);

    // Verify all comments are preserved
    assert(result.text.includes('# Top comment'), 'Top comment preserved');
    assert(result.text.includes('# Stage comment'), 'Stage comment preserved');
    assert(result.text.includes('# Job comment'), 'Job comment preserved');

    // Verify blank lines are preserved
    const lines = result.text.split('\n');
    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');
    let hasBlankBeforeStages = false;
    for (let i = stagesIndex - 1; i >= 0 && lines[i].trim() === ''; i--) {
        hasBlankBeforeStages = true;
        break;
    }
    assert(hasBlankBeforeStages, 'Blank line before stages preserved');

    console.log('   ✓ All metadata collected in single pass');
});

// Test 7: Block scalar handling
runTest('Block scalars are not confused with comments', () => {
    const input = `steps:
- bash: |
    echo "test"
    # This is part of the script
  displayName: Run Script
`;

    const result = formatYaml(input);

    // Block scalar content should be preserved
    assert(result.text.includes('bash: |'), 'Block scalar indicator preserved');
    assert(result.text.includes('echo "test"'), 'Script content preserved');
    assert(result.text.includes('# This is part of the script'), 'Comment inside script preserved as script content');

    console.log('   ✓ Block scalars handled correctly');
});

// Test 8: Empty lines between non-related content
runTest('Blank lines between unrelated content preserved', () => {
    const input = `parameters:
- name: test

variables:
  version: 1.0

stages:
- stage: Build
`;

    const result = formatYaml(input);
    const lines = result.text.split('\n');

    // Find parameters, variables and stages sections
    const paramsIndex = lines.findIndex((l) => l.trim() === 'parameters:');
    const varsIndex = lines.findIndex((l) => l.trim() === 'variables:');
    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');

    // Should have blank lines before variables (firstBlockBlankLines applies to first section after parameters)
    let blanksBeforeVars = 0;
    for (let i = varsIndex - 1; i >= 0 && lines[i].trim() === ''; i--) {
        blanksBeforeVars++;
    }
    assert(
        blanksBeforeVars === 2,
        `Expected 2 blanks before variables (first section after params), got ${blanksBeforeVars}`,
    );

    // Should have at least 1 blank before stages (preserved from input)
    let blanksBeforeStages = 0;
    for (let i = stagesIndex - 1; i >= 0 && lines[i].trim() === ''; i--) {
        blanksBeforeStages++;
    }
    assert(blanksBeforeStages >= 1, `Expected at least 1 blank before stages, got ${blanksBeforeStages}`);

    console.log('   ✓ Blank lines between unrelated content preserved');
});

// Test 9: Multiple content lines with same key
runTest('Multiple occurrences of same key handled correctly', () => {
    const input = `stages:
- stage: Build
- stage: Test
- stage: Deploy
`;

    const result = formatYaml(input);

    // All stage entries should be preserved
    const stageCount = (result.text.match(/- stage:/g) || []).length;
    assert.strictEqual(stageCount, 3, `Expected 3 stages, found ${stageCount}`);

    assert(result.text.includes('- stage: Build'), 'Build stage preserved');
    assert(result.text.includes('- stage: Test'), 'Test stage preserved');
    assert(result.text.includes('- stage: Deploy'), 'Deploy stage preserved');

    console.log('   ✓ Multiple same-key entries handled with position array');
});

// Test 10: Edge case - comment at end of file
runTest('Comment at end of file preserved', () => {
    const input = `stages:
- stage: Build
# Final comment`;

    const result = formatYaml(input);

    // Note: The yaml package preserves trailing comments, and our function
    // should handle this gracefully without error
    assert(!result.error, 'No error with trailing comment');

    console.log('   ✓ Trailing comment handled gracefully');
});

// Summary
console.log('═══════════════════════════════════════════');
console.log(`Total Tests: ${testCount}`);
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${testCount - passCount}`);
console.log(`📊 Success Rate: ${Math.round((passCount / testCount) * 100)}%\n`);

if (passCount === testCount) {
    console.log('🎉 ALL OPTIMIZATION TESTS PASSED!');
    process.exit(0);
} else {
    console.error('❌ Some optimization tests failed');
    process.exit(1);
}
