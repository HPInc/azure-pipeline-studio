#!/usr/bin/env node

/**
 * Test file-scoped variable isolation and stage/job variable overriding
 *
 * This test validates that:
 * 1. Variable templates (in variables: section) ARE accessible in the parent file
 * 2. Steps templates have isolated variables that do NOT leak to parent
 * 3. Variables defined in the parent are NOT accessible in steps templates (complete file isolation)
 * 4. Each file has its own isolated variable scope (except variable templates)
 * 5. Stage-level variables override global variables
 * 6. Job-level variables override stage and global variables
 */

const fs = require('fs');
const path = require('path');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing File-Scoped Variable Isolation\n');

function testFileScopedVariables() {
    console.log('=== File-Scoped Variables Test ===');
    const filePath = path.join(__dirname, 'inputs', 'file-scoped-variables-main.yaml');
    const data = fs.readFileSync(filePath, 'utf8');

    const output = parser.expandPipelineFromString(data, {
        azureCompatible: true,
        baseDir: path.join(__dirname, 'inputs'),
    });

    const yaml = require('yaml');
    const result = yaml.parse(output);

    const stage1 = result.stages[0];
    const job1 = stage1.jobs[0];
    const steps = job1.steps;

    console.log('Checking main file variables...');

    // Step 0: mainVar should be 'main-value'
    if (!steps[0].inputs.script.includes('mainVar=main-value')) {
        throw new Error(`Step 0: Expected 'mainVar=main-value', got: ${steps[0].inputs.script}`);
    }
    console.log('  ✅ mainVar accessible in main file');

    // Step 1: sharedVar should be 'main-shared-value'
    if (!steps[1].inputs.script.includes('sharedVar=main-shared-value')) {
        throw new Error(`Step 1: Expected 'sharedVar=main-shared-value', got: ${steps[1].inputs.script}`);
    }
    console.log('  ✅ sharedVar has correct value in main file');

    // Step 2: varTemplateVar1 from variable template should be accessible
    if (!steps[2].inputs.script.includes('varTemplateVar1=from-var-template-1')) {
        throw new Error(`Step 2: Expected 'varTemplateVar1=from-var-template-1', got: ${steps[2].inputs.script}`);
    }
    console.log('  ✅ Variable template var1 accessible in main file');

    // Step 3: varTemplateVar2 from variable template should be accessible
    if (!steps[3].inputs.script.includes('varTemplateVar2=from-var-template-2')) {
        throw new Error(`Step 3: Expected 'varTemplateVar2=from-var-template-2', got: ${steps[3].inputs.script}`);
    }
    console.log('  ✅ Variable template var2 accessible in main file');

    console.log('\nChecking steps template variables...');

    // Step 4: Inside steps template - templateVar should be 'template-value'
    if (!steps[4].inputs.script.includes('Inside template - templateVar=template-value')) {
        throw new Error(
            `Step 4: Expected 'Inside template - templateVar=template-value', got: ${steps[4].inputs.script}`
        );
    }
    console.log('  ✅ templateVar accessible within steps template');

    // Step 5: Inside steps template - sharedVar should be 'template-shared-value'
    if (!steps[5].inputs.script.includes('Inside template - sharedVar=template-shared-value')) {
        throw new Error(
            `Step 5: Expected 'Inside template - sharedVar=template-shared-value', got: ${steps[5].inputs.script}`
        );
    }
    console.log('  ✅ Steps template variables accessible within template');

    // Step 6: Inside steps template - mainVar should NOT be accessible (complete file isolation)
    const step6Script = steps[6].inputs.script;
    if (step6Script.includes('mainVar=main-value')) {
        throw new Error(`Step 6: Parent variable leaked into steps template! Got: ${step6Script}`);
    }
    if (!step6Script.includes('mainVar=') || step6Script.match(/mainVar=\S+"/)) {
        throw new Error(`Step 6: Expected 'mainVar=' (empty), got: ${step6Script}`);
    }
    console.log('  ✅ Parent variables NOT accessible in steps template (complete file isolation)');

    console.log('\nChecking variable isolation after steps template...');

    // Step 7: Back in main file - templateVar should be undefined (not leaked from steps template)
    // It should show literally "templateVar=" (empty value)
    const step7Script = steps[7].inputs.script;
    if (step7Script.includes('templateVar=template-value')) {
        throw new Error(`Step 7: templateVar leaked from steps template! Got: ${step7Script}`);
    }
    // Check that the value after "templateVar=" has no non-whitespace characters until a quote or end of string
    if (!step7Script.includes('templateVar=') || step7Script.match(/templateVar=\S+"/)) {
        throw new Error(`Step 7: Expected 'templateVar=' (empty), got: ${step7Script}`);
    }
    console.log('  ✅ Steps template variables NOT accessible in main file (properly isolated)');

    // Step 8: Back in main file - sharedVar should be 'main-shared-value' (steps template override didn't leak)
    if (!steps[8].inputs.script.includes('sharedVar=main-shared-value')) {
        throw new Error(`Step 8: Expected 'sharedVar=main-shared-value', got: ${steps[8].inputs.script}`);
    }
    console.log('  ✅ Steps template variable override did not leak to parent');

    // Test stage and job variable scoping
    console.log('\nChecking stage-level variable overriding...');

    const stage2 = result.stages[1];
    const job2 = stage2.jobs[0];
    const job2Steps = job2.steps;

    // Stage2, Job2, Step 0: mainVar from global should be accessible
    if (!job2Steps[0].inputs.script.includes('Stage2-Job2-mainVar=main-value')) {
        throw new Error(`Stage2-Job2 Step 0: Expected 'mainVar=main-value', got: ${job2Steps[0].inputs.script}`);
    }
    console.log('  ✅ Global variables accessible in stage');

    // Stage2, Job2, Step 1: sharedVar should be overridden by stage
    if (!job2Steps[1].inputs.script.includes('Stage2-Job2-sharedVar=stage2-overrides-global')) {
        throw new Error(
            `Stage2-Job2 Step 1: Expected 'sharedVar=stage2-overrides-global', got: ${job2Steps[1].inputs.script}`
        );
    }
    console.log('  ✅ Stage variables override global variables');

    // Stage2, Job2, Step 2: stageVar should be accessible
    if (!job2Steps[2].inputs.script.includes('Stage2-Job2-stageVar=stage2-value')) {
        throw new Error(`Stage2-Job2 Step 2: Expected 'stageVar=stage2-value', got: ${job2Steps[2].inputs.script}`);
    }
    console.log('  ✅ Stage-level variables accessible in stage jobs');

    console.log('\nChecking job-level variable overriding...');

    const job3 = stage2.jobs[1];
    const job3Steps = job3.steps;

    // Stage2, Job3, Step 0: mainVar from global should be accessible
    if (!job3Steps[0].inputs.script.includes('Stage2-Job3-mainVar=main-value')) {
        throw new Error(`Stage2-Job3 Step 0: Expected 'mainVar=main-value', got: ${job3Steps[0].inputs.script}`);
    }
    console.log('  ✅ Global variables accessible in job');

    // Stage2, Job3, Step 1: sharedVar should be overridden by job (not stage)
    if (!job3Steps[1].inputs.script.includes('Stage2-Job3-sharedVar=job3-overrides-stage')) {
        throw new Error(
            `Stage2-Job3 Step 1: Expected 'sharedVar=job3-overrides-stage', got: ${job3Steps[1].inputs.script}`
        );
    }
    console.log('  ✅ Job variables override stage and global variables');

    // Stage2, Job3, Step 2: stageVar should be accessible from stage
    if (!job3Steps[2].inputs.script.includes('Stage2-Job3-stageVar=stage2-value')) {
        throw new Error(`Stage2-Job3 Step 2: Expected 'stageVar=stage2-value', got: ${job3Steps[2].inputs.script}`);
    }
    console.log('  ✅ Stage variables accessible in child jobs');

    // Stage2, Job3, Step 3: jobVar should be accessible
    if (!job3Steps[3].inputs.script.includes('Stage2-Job3-jobVar=job3-value')) {
        throw new Error(`Stage2-Job3 Step 3: Expected 'jobVar=job3-value', got: ${job3Steps[3].inputs.script}`);
    }
    console.log('  ✅ Job-level variables accessible in job steps');

    console.log('\n✅ All file-scoped variable isolation tests passed!');
    console.log('   - Variable templates merge into parent scope ✅');
    console.log('   - Steps templates are completely isolated ✅');
    console.log('   - Stage variables override global variables ✅');
    console.log('   - Job variables override stage and global variables ✅\n');
}

// Run the test
try {
    testFileScopedVariables();
    console.log('======================================================================');
    console.log('✅ File-scoped variable isolation tests completed successfully!');
    console.log('======================================================================\n');
    process.exit(0);
} catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
}
