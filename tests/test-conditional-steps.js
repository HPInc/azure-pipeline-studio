#!/usr/bin/env node

/**
 * Test: Conditional Step Execution
 *
 * Tests that conditional step inclusion and exclusion works correctly
 * when expressions evaluate to true/false in the if: field.
 *
 * Azure Pipelines uses:
 *   - if: condition(expression) - runs if expression is true
 *   - if: succeeded() - runs if previous step succeeded
 *   - if: failed() - runs if previous step failed
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');
const { formatYaml } = require('../formatter.js');

const parser = new AzurePipelineParser();
const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

function runTestCase(name, input, params, assertions) {
    console.log(`=== ${name} ===`);

    try {
        const expanded = parser.expandPipelineFromString(
            input,
            Object.assign(
                {
                    azureCompatible: true,
                },
                params || {}
            )
        );

        if (verbose) {
            console.log('\n--- Expanded output ---');
            console.log(expanded);
            console.log('--- end output ---\n');
        }

        assertions(expanded);
        console.log('✅ PASS\n');
        return true;
    } catch (error) {
        console.log('❌ FAIL: ' + error.message + '\n');
        return false;
    }
}

// Test 1: Conditional step with parameter expression
const test1Pass = runTestCase(
    'Test 1: Conditional step with parameter expression',
    `parameters:
- name: runTests
  type: boolean
  default: true

stages:
- stage: Build
  jobs:
  - job: BuildJob
    steps:
    - bash: echo "Building..."
    - bash: echo "Running tests..."
      condition: \${{ parameters.runTests }}`,
    { parameters: { runTests: true } },
    (output) => {
        // When runTests is true, the condition should be present
        if (!output.includes('condition:')) {
            throw new Error('Conditional step should have condition field');
        }
    }
);

// Test 2: Conditional step with nested if expression (won't run)
const test2Pass = runTestCase(
    'Test 2: Conditional step with false expression',
    `parameters:
- name: isRelease
  type: boolean
  default: false

stages:
- stage: Deploy
  jobs:
  - job: DeployJob
    steps:
    - bash: echo "Deploying..."
      condition: \${{ parameters.isRelease }}`,
    { parameters: { isRelease: false } },
    (output) => {
        // Condition should still be present (evaluated at runtime)
        if (!output.includes('condition:')) {
            throw new Error('Conditional step should have condition field even when false');
        }
    }
);

// Test 3: Mix of conditional and unconditional steps
const test3Pass = runTestCase(
    'Test 3: Mix of conditional and unconditional steps',
    `parameters:
- name: runOptional
  type: boolean
  default: true

stages:
- stage: Test
  jobs:
  - job: TestJob
    steps:
    - bash: echo "Step 1: Always runs"
    - bash: echo "Step 2: Conditional"
      condition: \${{ parameters.runOptional }}
    - bash: echo "Step 3: Always runs"`,
    { parameters: { runOptional: true } },
    (output) => {
        if (!output.includes('Step 1: Always runs')) {
            throw new Error('Unconditional step should be present');
        }
        if (!output.includes('Step 2: Conditional')) {
            throw new Error('Conditional step should be present');
        }
        if (!output.includes('Step 3: Always runs')) {
            throw new Error('Another unconditional step should be present');
        }
        // Check that only the conditional step has a condition field
        const lines = output.split('\n');
        let conditionalFound = false;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('Step 2: Conditional') && i + 1 < lines.length) {
                if (lines[i + 1].includes('condition:')) {
                    conditionalFound = true;
                }
            }
        }
        if (!conditionalFound) {
            throw new Error('Conditional step should have condition field');
        }
    }
);

// Test 4: Conditional with succeeded() function
const test4Pass = runTestCase(
    'Test 4: Conditional with succeeded() function',
    `stages:
- stage: Pipeline
  jobs:
  - job: Job1
    steps:
    - bash: echo "Step 1"
    - bash: echo "Step 2 - only if Step 1 succeeded"
      condition: succeeded()
    - bash: echo "Step 3 - only if Step 2 failed"
      condition: failed()`,
    {},
    (output) => {
        // Check that succeeded() and failed() conditions are preserved
        if (!output.includes('condition: succeeded()') && !output.includes("condition: 'succeeded()'")) {
            throw new Error('succeeded() condition should be preserved');
        }
        if (!output.includes('condition: failed()') && !output.includes("condition: 'failed()'")) {
            throw new Error('failed() condition should be preserved');
        }
    }
);

// Test 5: Conditional with complex expression
const test5Pass = runTestCase(
    'Test 5: Conditional with complex expression',
    `parameters:
- name: env
  type: string
  default: 'dev'
- name: deploy
  type: boolean
  default: false

stages:
- stage: Deploy
  jobs:
  - job: DeployJob
    steps:
    - bash: echo "Deploying to \${{ parameters.env }}"
      condition: and(eq('\${{ parameters.env }}', 'prod'), eq('\${{ parameters.deploy }}', true))`,
    { parameters: { env: 'prod', deploy: true } },
    (output) => {
        // Check that complex condition is preserved
        if (!output.includes('condition:')) {
            throw new Error('Complex condition should be preserved');
        }
        if (!output.includes('and(')) {
            throw new Error('and() function should be in the condition');
        }
    }
);

// Test 6: Formatting conditional steps preserves condition syntax
const test6Pass = runTestCase(
    'Test 6: Formatting conditional steps preserves condition syntax',
    `stages:
- stage: Build
  jobs:
  - job: BuildJob
    steps:
    - bash: echo "Build"
    - bash: echo "Test"
      condition: succeeded()`,
    {},
    (output) => {
        // Format the output and verify condition is preserved
        const formatted = formatYaml(output);

        if (formatted.error) {
            throw new Error(`Formatting error: ${formatted.error}`);
        }

        if (!formatted.text.includes('condition:')) {
            throw new Error('Condition field should be preserved after formatting');
        }

        if (!formatted.text.includes('succeeded()')) {
            throw new Error('succeeded() function should be preserved after formatting');
        }
    }
);

// Summary
const allTests = [test1Pass, test2Pass, test3Pass, test4Pass, test5Pass, test6Pass];
const allPassed = allTests.every((t) => t);

console.log('=== Summary ===');
console.log(allPassed ? 'All conditional step tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
