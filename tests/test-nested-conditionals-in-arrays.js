#!/usr/bin/env node

/**
 * Test nested conditional directives in arrays
 *
 * This test validates that:
 * 1. Nested conditionals in arrays are properly evaluated
 * 2. False conditions don't create empty objects in arrays
 * 3. Multiple levels of nesting work correctly
 * 4. Array items are properly flattened when conditionals expand to arrays
 */

const assert = require('assert');
const { AzurePipelineParser } = require('../parser.js');

console.log('Testing nested conditionals in arrays...');

// Test 1: Nested conditionals - all true
const test1Yaml = `
parameters:
- name: enableBuild
  type: boolean
  default: true
- name: enableTests
  type: boolean
  default: true

stages:
- stage: Publish
  dependsOn:
  - Configure
  - \${{ if eq(parameters.enableBuild, true) }}:
    - Build
    - \${{ if eq(parameters.enableTests, true) }}:
      - Tests
`;

const parser1 = new AzurePipelineParser();
const result1 = parser1.expandPipeline(test1Yaml, {}).document;

assert(result1.stages[0].dependsOn.includes('Configure'), 'Test 1: Should include Configure');
assert(result1.stages[0].dependsOn.includes('Build'), 'Test 1: Should include Build');
assert(result1.stages[0].dependsOn.includes('Tests'), 'Test 1: Should include Tests');
assert.strictEqual(result1.stages[0].dependsOn.length, 3, 'Test 1: Should have exactly 3 dependencies');
assert(
    !result1.stages[0].dependsOn.some((d) => typeof d === 'object'),
    'Test 1: Should not have any objects in dependsOn'
);
console.log('✓ Test 1 passed: All nested conditionals true - all items included');

// Test 2: Nested conditionals - inner false
const test2Yaml = `
parameters:
- name: enableBuild
  type: boolean
  default: true
- name: enableTests
  type: boolean
  default: false

stages:
- stage: Publish
  dependsOn:
  - Configure
  - \${{ if eq(parameters.enableBuild, true) }}:
    - Build
    - \${{ if eq(parameters.enableTests, true) }}:
      - Tests
`;

const parser2 = new AzurePipelineParser();
const result2 = parser2.expandPipeline(test2Yaml, {}).document;

assert(result2.stages[0].dependsOn.includes('Configure'), 'Test 2: Should include Configure');
assert(result2.stages[0].dependsOn.includes('Build'), 'Test 2: Should include Build');
assert(!result2.stages[0].dependsOn.includes('Tests'), 'Test 2: Should not include Tests');
assert.strictEqual(result2.stages[0].dependsOn.length, 2, 'Test 2: Should have exactly 2 dependencies');
assert(
    !result2.stages[0].dependsOn.some((d) => typeof d === 'object'),
    'Test 2: Should not have any objects in dependsOn'
);
console.log('✓ Test 2 passed: Inner nested conditional false - Tests excluded');

// Test 3: Nested conditionals - outer false
const test3Yaml = `
parameters:
- name: enableBuild
  type: boolean
  default: false
- name: enableTests
  type: boolean
  default: true

stages:
- stage: Publish
  dependsOn:
  - Configure
  - \${{ if eq(parameters.enableBuild, true) }}:
    - Build
    - \${{ if eq(parameters.enableTests, true) }}:
      - Tests
`;

const parser3 = new AzurePipelineParser();
const result3 = parser3.expandPipeline(test3Yaml, {}).document;

assert(result3.stages[0].dependsOn.includes('Configure'), 'Test 3: Should include Configure');
assert(!result3.stages[0].dependsOn.includes('Build'), 'Test 3: Should not include Build');
assert(!result3.stages[0].dependsOn.includes('Tests'), 'Test 3: Should not include Tests');
assert.strictEqual(result3.stages[0].dependsOn.length, 1, 'Test 3: Should have exactly 1 dependency');
assert(
    !result3.stages[0].dependsOn.some((d) => typeof d === 'object'),
    'Test 3: Should not have any objects in dependsOn'
);
console.log('✓ Test 3 passed: Outer nested conditional false - Build and Tests excluded');

// Test 4: Multiple separate nested conditionals
const test4Yaml = `
parameters:
- name: enableBuild
  type: boolean
  default: true
- name: enableTests
  type: boolean
  default: false
- name: enableSigning
  type: boolean
  default: true

stages:
- stage: Publish
  dependsOn:
  - Configure
  - \${{ if eq(parameters.enableBuild, true) }}:
    - Build
  - \${{ if eq(parameters.enableTests, true) }}:
    - Tests
  - \${{ if eq(parameters.enableSigning, true) }}:
    - Signing
`;

const parser4 = new AzurePipelineParser();
const result4 = parser4.expandPipeline(test4Yaml, {}).document;

assert(result4.stages[0].dependsOn.includes('Configure'), 'Test 4: Should include Configure');
assert(result4.stages[0].dependsOn.includes('Build'), 'Test 4: Should include Build');
assert(!result4.stages[0].dependsOn.includes('Tests'), 'Test 4: Should not include Tests');
assert(result4.stages[0].dependsOn.includes('Signing'), 'Test 4: Should include Signing');
assert.strictEqual(result4.stages[0].dependsOn.length, 3, 'Test 4: Should have exactly 3 dependencies');
assert(
    !result4.stages[0].dependsOn.some((d) => typeof d === 'object'),
    'Test 4: Should not have any objects in dependsOn'
);
console.log('✓ Test 4 passed: Multiple separate conditionals - only true conditions included');

// Test 5: Complex nested structure matching user's case
const test5Yaml = `
parameters:
- name: enableBuild
  type: boolean
  default: true
- name: enableUnitTests
  type: boolean
  default: true
- name: enableSigning
  type: boolean
  default: false

stages:
- stage: Publish
  dependsOn:
  - Configure
  - \${{ if eq(parameters.enableBuild, true) }}:
    - Build
    - \${{ if eq(parameters.enableUnitTests, true) }}:
      - UnitTests
    - ArtifactScan
    - \${{ if eq(parameters.enableSigning, true) }}:
      - Signing
`;

const parser5 = new AzurePipelineParser();
const result5 = parser5.expandPipeline(test5Yaml, {}).document;

assert(result5.stages[0].dependsOn.includes('Configure'), 'Test 5: Should include Configure');
assert(result5.stages[0].dependsOn.includes('Build'), 'Test 5: Should include Build');
assert(result5.stages[0].dependsOn.includes('UnitTests'), 'Test 5: Should include UnitTests');
assert(result5.stages[0].dependsOn.includes('ArtifactScan'), 'Test 5: Should include ArtifactScan');
assert(!result5.stages[0].dependsOn.includes('Signing'), 'Test 5: Should not include Signing');
assert.strictEqual(result5.stages[0].dependsOn.length, 4, 'Test 5: Should have exactly 4 dependencies');
assert(
    !result5.stages[0].dependsOn.some((d) => typeof d === 'object'),
    'Test 5: Should not have any objects in dependsOn'
);
console.log('✓ Test 5 passed: Complex nested structure - matches user case');

console.log('\n✅ All nested conditional in array tests passed!');
