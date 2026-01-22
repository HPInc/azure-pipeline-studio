#!/usr/bin/env node

/**
 * Test variable scoping (global, stage, job levels)
 *
 * This test validates that:
 * 1. Global variables are accessible everywhere
 * 2. Stage variables are accessible within that stage and its jobs
 * 3. Job variables are accessible only within that job
 * 4. Variables at more specific scopes override broader scopes
 * 5. Job variables from one job don't leak into other jobs
 * 6. Stage variables from one stage don't leak into other stages
 */

const fs = require('fs');
const path = require('path');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Variable Scoping\n');

function testVariableScoping() {
    console.log('=== Variable Scoping Test ===');
    const filePath = path.join(__dirname, 'inputs', 'variable-scoping.yaml');
    const data = fs.readFileSync(filePath, 'utf8');

    const output = parser.expandPipelineFromString(data, { azureCompatible: true });
    const yaml = require('yaml');
    const result = yaml.parse(output);

    // Verify Stage1, Job1
    const stage1 = result.stages[0];
    const job1 = stage1.jobs[0];
    const job1Steps = job1.steps;

    console.log('Checking Stage1, Job1...');

    // Global var should be 'global-value'
    if (!job1Steps[0].inputs.script.includes('global-value')) {
        throw new Error(`Job1 Step1: Expected 'global-value', got: ${job1Steps[0].inputs.script}`);
    }

    // Stage var should be 'stage1-value'
    if (!job1Steps[1].inputs.script.includes('stage1-value')) {
        throw new Error(`Job1 Step2: Expected 'stage1-value', got: ${job1Steps[1].inputs.script}`);
    }

    // Job var should be 'job1-value'
    if (!job1Steps[2].inputs.script.includes('job1-value')) {
        throw new Error(`Job1 Step3: Expected 'job1-value', got: ${job1Steps[2].inputs.script}`);
    }

    // Shared var should be 'job1-shared' (job level overrides stage and global)
    if (!job1Steps[3].inputs.script.includes('job1-shared')) {
        throw new Error(`Job1 Step4: Expected 'job1-shared', got: ${job1Steps[3].inputs.script}`);
    }

    console.log('  ✅ Job1 variables correct');

    // Verify Stage1, Job2
    const job2 = stage1.jobs[1];
    const job2Steps = job2.steps;

    console.log('Checking Stage1, Job2...');

    // Global var should still be 'global-value'
    if (!job2Steps[0].inputs.script.includes('global-value')) {
        throw new Error(`Job2 Step1: Expected 'global-value', got: ${job2Steps[0].inputs.script}`);
    }

    // Stage var should still be 'stage1-value'
    if (!job2Steps[1].inputs.script.includes('stage1-value')) {
        throw new Error(`Job2 Step2: Expected 'stage1-value', got: ${job2Steps[1].inputs.script}`);
    }

    // Job var should be 'job2-value' (different from Job1)
    if (!job2Steps[2].inputs.script.includes('job2-value')) {
        throw new Error(`Job2 Step3: Expected 'job2-value', got: ${job2Steps[2].inputs.script}`);
    }

    // Shared var should be 'stage1-shared' (job1's variable doesn't leak to job2)
    if (!job2Steps[3].inputs.script.includes('stage1-shared')) {
        throw new Error(`Job2 Step4: Expected 'stage1-shared', got: ${job2Steps[3].inputs.script}`);
    }

    console.log('  ✅ Job2 variables correct (Job1 vars did not leak)');

    // Verify Stage2, Job3
    const stage2 = result.stages[1];
    const job3 = stage2.jobs[0];
    const job3Steps = job3.steps;

    console.log('Checking Stage2, Job3...');

    // Global var should still be 'global-value'
    if (!job3Steps[0].inputs.script.includes('global-value')) {
        throw new Error(`Job3 Step1: Expected 'global-value', got: ${job3Steps[0].inputs.script}`);
    }

    // Stage var should be 'stage2-value' (different from Stage1)
    if (!job3Steps[1].inputs.script.includes('stage2-value')) {
        throw new Error(`Job3 Step2: Expected 'stage2-value', got: ${job3Steps[1].inputs.script}`);
    }

    // Shared var should be 'global-shared' (stage1's variable doesn't leak to stage2)
    if (!job3Steps[2].inputs.script.includes('global-shared')) {
        throw new Error(`Job3 Step3: Expected 'global-shared', got: ${job3Steps[2].inputs.script}`);
    }

    console.log('  ✅ Job3 variables correct (Stage1 vars did not leak)');
    console.log('\n✅ All variable scoping tests passed!\n');
}

// Run the test
try {
    testVariableScoping();
    console.log('======================================================================');
    console.log('✅ Variable scoping tests completed successfully!');
    console.log('======================================================================\n');
    process.exit(0);
} catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
}
