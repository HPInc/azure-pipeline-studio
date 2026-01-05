#!/usr/bin/env node

/**
 * Test that checkout: none gets condition: false
 */

const assert = require('assert');
const { AzurePipelineParser } = require('../extension.js');

console.log('🧪 Testing checkout: none with condition: false');
console.log('='.repeat(60) + '\n');

const parser = new AzurePipelineParser();
parser.printTree = false;

let passCount = 0;
let failCount = 0;

function test(name, yamlContent, expectedChecks) {
    try {
        const result = parser.expandPipeline(yamlContent);
        expectedChecks(result.document);
        console.log(`✅ Test passed: ${name}`);
        passCount++;
    } catch (error) {
        console.error(`❌ Test failed: ${name}`);
        console.error(`   ${error.message}`);
        if (error.stack) {
            console.error(`   ${error.stack.split('\n').slice(1, 3).join('\n   ')}`);
        }
        failCount++;
    }
}

// Test 1: checkout: none shorthand should get condition: false
test(
    'checkout: none shorthand gets condition: false',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: none
      - script: echo "test"
`,
    (result) => {
        const step = result.jobs[0].steps[0];
        assert.strictEqual(step.task, '6d15af64-176c-496d-b583-fd2ae21d4df4@1', 'Should be checkout task');
        assert.strictEqual(step.inputs.repository, 'none', 'Repository should be none');
        assert.strictEqual(step.condition, false, 'Should have condition: false');
    }
);

// Test 2: checkout: self should NOT get condition: false
test(
    'checkout: self does not get condition: false',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
      - script: echo "test"
`,
    (result) => {
        const step = result.jobs[0].steps[0];
        assert.strictEqual(step.task, '6d15af64-176c-496d-b583-fd2ae21d4df4@1', 'Should be checkout task');
        assert.strictEqual(step.inputs.repository, 'self', 'Repository should be self');
        assert.strictEqual(step.condition, undefined, 'Should NOT have condition: false');
    }
);

// Test 3: Explicit checkout task with repository: none
test(
    'Explicit checkout task with repository: none gets condition: false',
    `
jobs:
  - job: TestJob
    steps:
      - task: 6d15af64-176c-496d-b583-fd2ae21d4df4@1
        inputs:
          repository: none
      - script: echo "test"
`,
    (result) => {
        const step = result.jobs[0].steps[0];
        assert.strictEqual(step.task, '6d15af64-176c-496d-b583-fd2ae21d4df4@1', 'Should be checkout task');
        assert.strictEqual(step.inputs.repository, 'none', 'Repository should be none');
        assert.strictEqual(step.condition, false, 'Should have condition: false');
    }
);

// Test 4: checkout: none with additional properties
test(
    'checkout: none with displayName preserves properties',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: none
        displayName: 'Skip checkout'
      - script: echo "test"
`,
    (result) => {
        const step = result.jobs[0].steps[0];
        assert.strictEqual(step.task, '6d15af64-176c-496d-b583-fd2ae21d4df4@1', 'Should be checkout task');
        assert.strictEqual(step.inputs.repository, 'none', 'Repository should be none');
        assert.strictEqual(step.condition, false, 'Should have condition: false');
        assert.strictEqual(step.displayName, 'Skip checkout', 'Should preserve displayName');
    }
);

// Test 5: Don't override existing condition
test(
    'Do not override existing condition property',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: none
        condition: succeeded()
      - script: echo "test"
`,
    (result) => {
        const step = result.jobs[0].steps[0];
        assert.strictEqual(step.task, '6d15af64-176c-496d-b583-fd2ae21d4df4@1', 'Should be checkout task');
        assert.strictEqual(step.inputs.repository, 'none', 'Repository should be none');
        assert.strictEqual(step.condition, 'succeeded()', 'Should preserve existing condition');
    }
);

// Test 6: Multiple checkout steps
test(
    'Multiple checkout steps with different repositories',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: none
      - checkout: self
      - checkout: none
        displayName: 'Another skip'
      - script: echo "test"
`,
    (result) => {
        const steps = result.jobs[0].steps;

        // First checkout: none
        assert.strictEqual(steps[0].task, '6d15af64-176c-496d-b583-fd2ae21d4df4@1');
        assert.strictEqual(steps[0].inputs.repository, 'none');
        assert.strictEqual(steps[0].condition, false, 'First none should have condition: false');

        // Second checkout: self
        assert.strictEqual(steps[1].task, '6d15af64-176c-496d-b583-fd2ae21d4df4@1');
        assert.strictEqual(steps[1].inputs.repository, 'self');
        assert.strictEqual(steps[1].condition, undefined, 'Self should not have condition');

        // Third checkout: none
        assert.strictEqual(steps[2].task, '6d15af64-176c-496d-b583-fd2ae21d4df4@1');
        assert.strictEqual(steps[2].inputs.repository, 'none');
        assert.strictEqual(steps[2].condition, false, 'Second none should have condition: false');
    }
);

// Test 7: Checkout in template expansion
test(
    'checkout: none in template parameters',
    `
parameters:
  - name: skipCheckout
    type: boolean
    default: true

jobs:
  - job: TestJob
    steps:
      - \${{ if eq(parameters.skipCheckout, true) }}:
        - checkout: none
      - \${{ else }}:
        - checkout: self
      - script: echo "test"
`,
    (result) => {
        const steps = result.jobs[0].steps;
        // The if condition is true, so we get checkout: none
        const checkoutStep = steps.find((s) => s.task === '6d15af64-176c-496d-b583-fd2ae21d4df4@1');
        assert(checkoutStep, 'Should have checkout step');
        assert.strictEqual(checkoutStep.inputs.repository, 'none', 'Repository should be none');
        assert.strictEqual(checkoutStep.condition, false, 'Should have condition: false');
    }
);

// Final Results
console.log('\n' + '='.repeat(60));
console.log('📊 CHECKOUT NONE CONDITION TEST RESULTS');
console.log('='.repeat(60));
console.log(`Total Tests: ${passCount + failCount}`);
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${failCount}`);
console.log('='.repeat(60));

if (failCount > 0) {
    console.log('\n⚠️  Some tests failed.');
    process.exit(1);
} else {
    console.log('\n🎉 All tests passed!');
    console.log('\n✨ Verified:');
    console.log('   • checkout: none gets condition: false');
    console.log('   • checkout: self does NOT get condition: false');
    console.log('   • Explicit checkout tasks with repository: none get condition: false');
    console.log('   • Additional properties are preserved');
    console.log('   • Existing condition values are not overridden');
    process.exit(0);
}
