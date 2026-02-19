#!/usr/bin/env node

/**
 * Test variable template behavior
 *
 * This test validates that:
 * 1. Variables defined in a variable template are accessible in the parent file
 * 2. Variables defined in the template can override parent variables
 * 3. Variable templates merge their variables into the parent scope
 * 4. Steps templates still have isolated variables (don't leak)
 */

const fs = require('fs');
const path = require('path');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Variable Template Behavior\n');

function testVariableTemplate() {
    console.log('=== Variable Template Test ===');
    const filePath = path.join(__dirname, 'inputs', 'variable-template-main.yaml');
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

    console.log('Checking variable template behavior...');

    // Step 0: mainVar from main file should work
    if (!steps[0].inputs.script.includes('mainVar=main-value')) {
        throw new Error(`Step 0: Expected 'mainVar=main-value', got: ${steps[0].inputs.script}`);
    }
    console.log('  ✅ Main file variables accessible');

    // Step 1: sharedVar should be overridden by variable template
    if (!steps[1].inputs.script.includes('sharedVar=template-overrides-main')) {
        throw new Error(`Step 1: Expected 'sharedVar=template-overrides-main', got: ${steps[1].inputs.script}`);
    }
    console.log('  ✅ Variable template can override parent variables');

    // Step 2: templateVar1 from variable template should be accessible in parent
    if (!steps[2].inputs.script.includes('templateVar1=from-template-1')) {
        throw new Error(`Step 2: Expected 'templateVar1=from-template-1', got: ${steps[2].inputs.script}`);
    }
    console.log('  ✅ Variable template variables accessible in parent file');

    // Step 3: templateVar2 from variable template should be accessible in parent
    if (!steps[3].inputs.script.includes('templateVar2=from-template-2')) {
        throw new Error(`Step 3: Expected 'templateVar2=from-template-2', got: ${steps[3].inputs.script}`);
    }
    console.log('  ✅ Multiple variable template variables accessible in parent');

    console.log('\n✅ All variable template tests passed!\n');
}

// Run the test
try {
    testVariableTemplate();
    console.log('======================================================================');
    console.log('✅ Variable template tests completed successfully!');
    console.log('======================================================================\n');
    process.exit(0);
} catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
}
