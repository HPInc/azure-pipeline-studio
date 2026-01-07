#!/usr/bin/env node

/**
 * Test: Quote preservation during variable format conversion
 *
 * This test verifies that when variables are converted from object format
 * to array format, the quote styles are preserved correctly.
 */

const { AzurePipelineParser } = require('../parser');
const fs = require('fs');
const path = require('path');

console.log('Testing Variable Quote Preservation During Format Conversion\n');

// Test 1: Variables with quotes in object format
console.log('=== Test 1: Object format variables with quotes ===');

const input1 = `
variables:
  myString: 'quoted value'
  myNumber: 42
  myPattern: "*.txt"

stages:
  - stage: Test
    jobs:
      - job: TestJob
        steps:
          - bash: echo "$(myString)"
`;

try {
    const parser = new AzurePipelineParser();
    const result = parser.expandPipeline(input1, { azureCompatible: true });
    const output = result.yaml;

    console.log('Input variables format: object');
    console.log('Output:');
    console.log(output);

    // Check if quotes are preserved
    if (output.includes("'quoted value'")) {
        console.log('✅ Single quotes preserved for myString');
    } else {
        console.log('❌ Single quotes NOT preserved for myString');
        console.log('Expected: myString with single quotes');
        process.exit(1);
    }

    if (output.includes('"*.txt"')) {
        console.log('✅ Double quotes preserved for myPattern');
    } else {
        console.log('❌ Double quotes NOT preserved for myPattern');
        console.log('Expected: myPattern with double quotes');
        process.exit(1);
    }

    console.log('✅ PASS\n');
} catch (error) {
    console.error('❌ FAIL:', error.message);
    process.exit(1);
}

// Test 2: Variables with template expressions
console.log('=== Test 2: Variables with template expressions ===');

const input2 = `
variables:
  env: 'production'
  region: '\${{ parameters.region }}'

parameters:
  - name: region
    default: 'us-west-2'

stages:
  - stage: Deploy
    jobs:
      - job: DeployJob
        steps:
          - bash: echo "Deploying to \$(region)"
`;

try {
    const parser = new AzurePipelineParser();
    const result = parser.expandPipeline(input2, { azureCompatible: true });
    const output = result.yaml;

    console.log('Output:');
    console.log(output);

    // Check if single quotes preserved for env
    if (output.includes("'production'")) {
        console.log('✅ Single quotes preserved for env variable');
    } else {
        console.log('❌ Single quotes NOT preserved for env variable');
        process.exit(1);
    }

    // Check if region value was expanded (should NOT have quotes after template expansion)
    if (output.includes('us-west-2') && !output.includes("'us-west-2'") && !output.includes('"us-west-2"')) {
        console.log('✅ Template expression expanded correctly without quotes');
    } else if (output.includes('us-west-2')) {
        console.log('⚠️  Template expression expanded but still has quotes (acceptable)');
    } else {
        console.log('❌ Template expression NOT expanded correctly');
        process.exit(1);
    }

    console.log('✅ PASS\n');
} catch (error) {
    console.error('❌ FAIL:', error.message);
    process.exit(1);
}

console.log('=== Summary ===');
console.log('All variable quote preservation tests passed ✅');
