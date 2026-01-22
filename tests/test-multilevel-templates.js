#!/usr/bin/env node

/**
 * Test multi-level template expansion
 *
 * This test validates that:
 * 1. Multi-level template references work correctly
 * 2. Quote styles are preserved through multiple template levels
 * 3. Stage/job/step indices are tracked correctly
 * 4. Template parameters are passed through correctly
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Multi-Level Template Expansion\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// Helper to run a test case
function runTestCase(name, yamlFile, params, azureCompatible, assertions) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');
    const baseDir = path.join(__dirname, 'inputs');

    const options = {
        azureCompatible,
        baseDir,
        fileName: filePath,
        ...params,
    };

    const output = parser.expandPipelineFromString(data, options);

    if (verbose) {
        console.log('\n--- Parser output ---');
        console.log(output);
        console.log('--- end output ---\n');
    }

    let passed = true;
    try {
        assertions(output);
        console.log('✅ PASS\n');
    } catch (error) {
        console.log('❌ FAIL: ' + error.message + '\n');
        passed = false;
    }

    return passed;
}

// Test 1: Stage template references
const test1Pass = runTestCase(
    'Test 1: Stage template expansion',
    'include-stage-template.yaml',
    {},
    false,
    (output) => {
        // Should have two stages from the template
        const stageMatches = output.match(/stage: Stage1/g);
        if (!stageMatches || stageMatches.length !== 1) {
            throw new Error('Expected 1 occurrence of Stage1');
        }

        const stage2Matches = output.match(/stage: Stage2/g);
        if (!stage2Matches || stage2Matches.length !== 1) {
            throw new Error('Expected 1 occurrence of Stage2');
        }

        // Both stages should have jobs
        const jobMatches = output.match(/job: Job2/g);
        if (!jobMatches || jobMatches.length !== 2) {
            throw new Error('Expected 2 jobs (one in each stage)');
        }

        // Check for template-expanded content
        if (!output.includes('echo "Test"')) {
            throw new Error('Template content not found');
        }
    }
);

// Test 2: Step template references
const test2Pass = runTestCase('Test 2: Step template expansion', 'include-step-template.yaml', {}, false, (output) => {
    // Should have expanded steps from template
    if (!output.includes('Environment: staging')) {
        throw new Error('Step template not expanded with parameter');
    }

    // Should have two steps from template (with single and double quotes in original)
    const envMatches = output.match(/Environment: staging/g);
    if (!envMatches || envMatches.length !== 2) {
        throw new Error('Expected 2 steps from step template');
    }
});

// Test 3: Variable template references
const test3Pass = runTestCase(
    'Test 3: Variable template expansion',
    'include-variable-template.yaml',
    {},
    false,
    (output) => {
        // Variables should be expanded in both Build and Deploy stages
        const serverMatches = output.match(/name: server/g);
        if (!serverMatches || serverMatches.length !== 2) {
            throw new Error('Expected 2 variable definitions (one per stage)');
        }

        // Check conditional variable value (default is production)
        if (!output.includes('production.db.test.com')) {
            throw new Error('Variable template conditional not evaluated correctly');
        }
    }
);

// Test 4: Multi-level template expansion (template includes template)
const test4Pass = runTestCase(
    'Test 4: Multi-level template expansion',
    'stage-multilevel.yaml',
    {},
    false,
    (output) => {
        // Should have Stage0 from conditional in stage-toplevel.yaml
        if (!output.includes('stage: Stage0')) {
            throw new Error('Stage0 from top-level template not found');
        }

        // Should have Stage1 from stage-secondlevel.yaml
        if (!output.includes('stage: Stage1')) {
            throw new Error('Stage1 from second-level template not found');
        }

        // Should have Stage2 from stage-toplevel.yaml
        if (!output.includes('stage: Stage2')) {
            throw new Error('Stage2 from top-level template not found');
        }

        // Check that all stages have correct structure
        const stageMatches = output.match(/stage: Stage\d/g);
        if (!stageMatches || stageMatches.length !== 3) {
            throw new Error(`Expected 3 stages, found ${stageMatches ? stageMatches.length : 0}`);
        }

        // Check job content from different levels
        if (!output.includes('echo "Stage.0.Job.0"')) {
            throw new Error('Stage 0 job content not found');
        }
        if (!output.includes('echo "Stage.1.Job.1"')) {
            throw new Error('Stage 1 job content not found');
        }
        if (!output.includes('echo "Stage.2.Job.2"')) {
            throw new Error('Stage 2 job content not found');
        }
    }
);

// Summary
const allPassed = test1Pass && test2Pass && test3Pass && test4Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All multi-level template tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
