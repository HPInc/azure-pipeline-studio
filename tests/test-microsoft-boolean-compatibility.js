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

const assert = require('assert');
const { AzurePipelineParser } = require('../parser.js');

// Test input YAML with various boolean expressions
const testYaml = `
parameters:
  - name: enableFeature
    type: boolean
    default: true
  - name: skipTests
    type: boolean
    default: false
  - name: stringTrue
    type: string
    default: "True"
  - name: stringFalse
    type: string
    default: "False"
  - name: buildReason
    type: string
    default: "Manual"
  - name: sourceBranch
    type: string
    default: "refs/heads/main"

variables:
  # Comparison functions
  - name: isEqual
    value: \${{ eq(parameters.buildReason, 'Manual') }}
  - name: notEqual
    value: \${{ ne(parameters.buildReason, 'PullRequest') }}
  - name: greaterThan
    value: \${{ gt(5, 3) }}

  # Logical functions
  - name: andResult
    value: \${{ and(parameters.enableFeature, eq(parameters.buildReason, 'Manual')) }}
  - name: orResult
    value: \${{ or(parameters.skipTests, eq(parameters.buildReason, 'PullRequest')) }}
  - name: notResult
    value: \${{ not(parameters.skipTests) }}

  # Containment functions
  - name: containsResult
    value: \${{ contains(parameters.sourceBranch, 'main') }}
  - name: inResult
    value: \${{ in(parameters.buildReason, 'Manual', 'PullRequest', 'Schedule') }}

  # String functions
  - name: startsWithResult
    value: \${{ startsWith(parameters.sourceBranch, 'refs/heads/') }}
  - name: endsWithResult
    value: \${{ endsWith(parameters.sourceBranch, '/main') }}

  # Status functions
  - name: alwaysRun
    value: \${{ always() }}
  - name: succeededRun
    value: \${{ succeeded() }}

  # Original string values should be preserved
  - name: originalStringTrue
    value: \${{ parameters.stringTrue }}
  - name: originalStringFalse
    value: \${{ parameters.stringFalse }}
  - name: literalTrue
    value: "True"
  - name: literalFalse
    value: "False"

jobs:
  - job: TestJob
    displayName: 'Test Boolean Compatibility'
    condition: \${{ eq(parameters.enableFeature, true) }}
    steps:
      - script: echo "Testing boolean output"
        displayName: 'Display message'
`;

function runTest() {
    console.log('Testing Microsoft Azure Pipelines Boolean Compatibility...\n');

    // Test 1: Boolean expressions output as True/False (Microsoft format - default)
    console.log('Test 1: Boolean expressions output as True/False (Microsoft format)');
    const parser1 = new AzurePipelineParser();
    const output1 = parser1.expandPipelineToString(testYaml, {});

    console.log('Checking for unquoted capitalized booleans...');

    // Should have unquoted True/False for expression-evaluated booleans
    assert(output1.includes('value: True'), 'Should have unquoted True values');
    assert(output1.includes('value: False'), 'Should have unquoted False values');

    // Verify specific variables (array format with name/value pairs)
    const isEqualMatch = /name: isEqual\s+value: True/s.test(output1);
    const notEqualMatch = /name: notEqual\s+value: True/s.test(output1);
    const orResultMatch = /name: orResult\s+value: False/s.test(output1);

    assert(isEqualMatch, 'isEqual should be True');
    assert(notEqualMatch, 'notEqual should be True');
    assert(orResultMatch, 'orResult should be False');

    // Original string values should be preserved as quoted strings
    assert(
        output1.includes('value: "True"') || output1.includes("value: 'True'"),
        'String literals with "True" should remain quoted',
    );

    // Should NOT have any marker strings in output
    assert(output1.includes('__TRUE__') === false, 'Should not contain __TRUE__ marker');
    assert(output1.includes('__FALSE__') === false, 'Should not contain __FALSE__ marker');

    console.log('✓ All boolean expressions output as unquoted True/False');
    console.log('✓ Original string values preserved\n');

    // Test 2: Edge cases
    console.log('Test 2: Edge cases');
    const edgeCaseYaml = `
variables:
  - name: complexAnd
    value: \${{ and(true, true, false) }}
  - name: complexOr
    value: \${{ or(false, false, true) }}
  - name: nestedCondition
    value: \${{ and(eq('a', 'a'), or(eq('b', 'c'), eq('d', 'd'))) }}
  - name: xorTest
    value: \${{ xor(true, false) }}
`;

    const parser2 = new AzurePipelineParser();
    const output2 = parser2.expandPipelineToString(edgeCaseYaml, {});

    const complexAndMatch = /name: complexAnd\s+value: False/s.test(output2);
    const complexOrMatch = /name: complexOr\s+value: True/s.test(output2);
    const nestedMatch = /name: nestedCondition\s+value: True/s.test(output2);
    const xorMatch = /name: xorTest\s+value: True/s.test(output2);

    assert(complexAndMatch, 'complexAnd should be False');
    assert(complexOrMatch, 'complexOr should be True');
    assert(nestedMatch, 'nestedCondition should be True');
    assert(xorMatch, 'xorTest should be True');

    console.log('✓ Complex boolean expressions work correctly\n');

    // Test 3: Booleans in bash script literals preserve quotes
    console.log('Test 3: Booleans in script literals');
    const scriptYaml = `
parameters:
- name: enabled
  type: boolean
  default: true

steps:
- bash: |
    var="\${{ parameters.enabled }}"
  displayName: Test
`;

    const parser3 = new AzurePipelineParser();
    const output3 = parser3.expandPipelineToString(scriptYaml, {});

    assert(output3.includes('var="True"'), 'Boolean in script should be True with quotes preserved');
    console.log('✓ Booleans in script literals preserve quotes\n');

    console.log('✅ All tests passed!');
}

// Run the tests
try {
    runTest();
    process.exit(0);
} catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
}
