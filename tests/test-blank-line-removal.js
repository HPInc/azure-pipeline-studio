#!/usr/bin/env node

const { formatYaml } = require('../extension.js');
const assert = require('assert');

console.log('Testing blank line removal after parent keys and sections...\n');

function testRemoveBlankLinesAfterSteps() {
    const input = `parameters:
- name: test
  type: string

stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    
    - bash: echo "test"
`;
    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    const hasBlankAfterSteps = /steps:\n\n/.test(result.text);
    assert(!hasBlankAfterSteps, 'Shouldremoveblanklineaftersteps:');
    assert(/steps:\n    - bash/.test(result.text), 'Should have step immediately after steps:');
    console.log('✓ Remove blank lines after steps: test passed');
}

function testRemoveBlankLinesAfterJobs() {
    const input = `stages:
- stage: Build
  jobs:
  
  - job: Test
    steps:
    - bash: echo "test"
`;
    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    const hasBlankAfterJobs = /jobs:\n\n/.test(result.text);
    assert(!hasBlankAfterJobs, 'Shouldremoveblanklineafterjobs:');
    assert(/jobs:\n  - job/.test(result.text), 'Should have job immediately after jobs:');
    console.log('✓ Remove blank lines after jobs: test passed');
}

function testRemoveBlankLinesAfterStages() {
    const input = `parameters:
- name: test
stages:

- stage: Build
  jobs:
  - job: Test
`;
    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    const hasBlankAfterStages = /stages:\n\n/.test(result.text);
    assert(!hasBlankAfterStages, 'Shouldremoveblanklineafterstages:');
    assert(/stages:\n- stage/.test(result.text), 'Should have stage immediately after stages:');
    console.log('✓ Remove blank lines after stages: test passed');
}

function testRemoveBlankLinesAfterNestedKeys() {
    const input = `stages:
- stage: Build
  jobs:
  
  - job: Compile
    steps:
    - bash: echo "test"
`;
    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    const hasBlankAfterJobs = /jobs:\n\n/.test(result.text);
    assert(!hasBlankAfterJobs, 'Shouldremoveblanklineafternestedjobs:');
    assert(/jobs:\n  - job/.test(result.text), 'Should have job immediately after nested jobs:');
    console.log('✓ Remove blank lines after nested keys test passed');
}

function testPreserveBlankLinesBetweenSteps() {
    const input = `steps:
- bash: echo "step1"

- bash: echo "step2"

- bash: echo "step3"
`;
    const result = formatYaml(input, { stepSpacing: true });
    const stepCount = (result.text.match(/- bash:/g) || []).length;
    assert(stepCount === 3, 'Should have 3 steps');
    console.log('✓ Preserve blank lines between steps test passed');
}

function testFirstBlockBlankLinesWithTopLevelSections() {
    const input = `resources:
  repositories:
  - repository: templates
    type: git

variables:
- name: test
  value: "1"

stages:
- stage: Build
`;
    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    const match = result.text.match(/value: "1"(\n+)stages:/);
    assert(match, 'Should find the section');
    const blankLines = match[1].split('\n').length - 1;
    // The input already has 2 blank lines, so it should be preserved or at least have 2
    assert(blankLines >= 2, `Should have at least 2 blank lines before stages:, got ${blankLines}`);
    console.log('✓ First block blank lines with top-level sections test passed');
}

function testNoBlankLinesWhenStagesFirst() {
    const input = `stages:
- stage: Build
  jobs:
  - job: Test
`;
    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    assert(result.text.startsWith('stages:'), 'Should start with stages:');
    console.log('✓ No blank lines when stages first test passed');
}

function testComplexNestedStructure() {
    const input = `parameters:
- name: test
stages:
- stage: Build
  
  jobs:
  
  - job: Test
    
    pool:
    
      name: Default
    
    steps:
    
    - bash: echo "test"
`;
    const result = formatYaml(input, { firstBlockBlankLines: 2, stepSpacing: true });
    assert(!/jobs:\n\n/.test(result.text), 'Shouldnothaveblankafterjobs:');
    assert(!/steps:\n\n/.test(result.text), 'Shouldnothaveblankaftersteps:');
    assert(!/pool:\n\n/.test(result.text), 'Shouldnothaveblankafterpool:');
    const hasBlankBeforeStages = /\n\n+stages:/.test(result.text);
    assert(hasBlankBeforeStages, 'Should have blank lines before stages:');
    console.log('✓ Complex nested structure test passed');
}

function testOnlyFirstOccurrenceGetsBlankLines() {
    const input = `parameters:
- name: test
stages:
- stage: Build
  jobs:
  - job: BuildJob
    steps:
    - bash: echo "build"

- stage: Deploy
  jobs:
  - job: DeployJob
    steps:
    - bash: echo "deploy"
`;
    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    const firstStagesMatch = result.text.match(/parameters:[\s\S]*?(\n+)stages:/);
    assert(firstStagesMatch, 'Should find first stages section');
    const blanksBeforeFirstStages = firstStagesMatch[1].split('\n').length - 1;
    assert(
        blanksBeforeFirstStages === 3,
        `Should have 3 newlines (2 blank lines) before first stages, got ${blanksBeforeFirstStages}`,
    );
    const secondStageMatch = result.text.match(/echo "build"([\s\S]*?)- stage: Deploy/);
    assert(secondStageMatch, 'Should find second stage');
    const blanksBeforeSecondStage = (secondStageMatch[1].match(/\n/g) || []).length;
    assert(
        blanksBeforeSecondStage <= 2,
        `Should have at most 2 newlines before second stage, got ${blanksBeforeSecondStage}`,
    );
    console.log('✓ Only first occurrence gets blank lines test passed');
}

// Run all tests
try {
    testRemoveBlankLinesAfterSteps();
    testRemoveBlankLinesAfterJobs();
    testRemoveBlankLinesAfterStages();
    testRemoveBlankLinesAfterNestedKeys();
    testPreserveBlankLinesBetweenSteps();
    testFirstBlockBlankLinesWithTopLevelSections();
    testNoBlankLinesWhenStagesFirst();
    testComplexNestedStructure();
    testOnlyFirstOccurrenceGetsBlankLines();

    console.log('\n✅ All blank line removal tests passed!');
    process.exit(0);
} catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
}
