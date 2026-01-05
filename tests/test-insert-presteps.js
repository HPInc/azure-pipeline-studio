#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { AzurePipelineParser } = require('../extension.js');

const testFile = path.join(__dirname, 'test-insert-presteps.yml');

console.log('Testing ${{ insert }} directive with preSteps template references...');

// Parse the test file
const parser = new AzurePipelineParser({ printTree: false });

try {
    const sourceText = fs.readFileSync(testFile, 'utf8');
    const result = parser.expandPipelineFromString(sourceText, {
        fileName: testFile,
        resources: {
            repositories: {
                self: {
                    location: __dirname, // Use the tests directory as the location for 'self' repository
                },
            },
        },
    });
    const expandedYaml = result;
    const expandedObj = YAML.parse(expandedYaml);

    // Validation checks
    let testsPassed = 0;
    let testsFailed = 0;

    // Test 1: Check that stages exist
    if (!expandedObj.stages || expandedObj.stages.length === 0) {
        console.error('✗ Test 1 FAILED: No stages found in expanded output');
        testsFailed++;
    } else {
        console.log('✓ Test 1 PASSED: Stages exist');
        testsPassed++;
    }

    // Test 2: Check that Build stage exists
    const buildStage = expandedObj.stages.find((s) => s.stage === 'Build');
    if (!buildStage) {
        console.error('✗ Test 2 FAILED: Build stage not found');
        testsFailed++;
    } else {
        console.log('✓ Test 2 PASSED: Build stage exists');
        testsPassed++;
    }

    // Test 3: Check that jobs exist in Build stage
    if (!buildStage || !buildStage.jobs || buildStage.jobs.length === 0) {
        console.error('✗ Test 3 FAILED: No jobs found in Build stage');
        testsFailed++;
    } else {
        console.log('✓ Test 3 PASSED: Jobs exist in Build stage');
        testsPassed++;
    }

    // Test 4: Check that ${{ insert }} worked - stageName should be present
    if (!buildStage || !buildStage.stageName) {
        console.error('✗ Test 4 FAILED: ${{ insert }} did not merge stageName property');
        testsFailed++;
    } else {
        console.log('✓ Test 4 PASSED: ${{ insert }} directive worked (stageName property present)');
        testsPassed++;
    }

    // Test 5: Check that job template reference exists with parameters
    const jobTemplate = buildStage?.jobs?.[0];
    if (!jobTemplate || !jobTemplate.template || jobTemplate.template !== 'job-template.yml') {
        console.error('✗ Test 5 FAILED: Job template reference not found');
        testsFailed++;
    } else {
        console.log('✓ Test 5 PASSED: Job template reference exists');
        testsPassed++;
    }

    // Test 6: Check that preSteps parameter was preserved
    if (!jobTemplate?.parameters?.preSteps) {
        console.error('✗ Test 6 FAILED: preSteps parameter not found in job template');
        testsFailed++;
    } else {
        console.log('✓ Test 6 PASSED: preSteps parameter preserved');
        testsPassed++;
    }

    // Test 7: Check that preSteps contains template references to pre-steps-template.yml@self
    const preSteps = jobTemplate?.parameters?.preSteps;
    if (!Array.isArray(preSteps) || preSteps.length < 2) {
        console.error('✗ Test 7 FAILED: preSteps should be array with 2 items');
        testsFailed++;
    } else {
        console.log(`✓ Test 7 PASSED: preSteps is array with ${preSteps.length} items`);
        testsPassed++;
    }

    // Test 8: Check that first preStep has correct template reference
    const preStep1 = preSteps?.[0];
    if (!preStep1 || !preStep1.template || !preStep1.template.includes('pre-steps-template.yml@self')) {
        console.error('✗ Test 8 FAILED: First preStep template reference incorrect');
        testsFailed++;
    } else {
        console.log('✓ Test 8 PASSED: First preStep template reference correct');
        testsPassed++;
    }

    // Test 9: Check that first preStep has parameters
    if (!preStep1?.parameters || preStep1.parameters.message !== 'Pre-step 1') {
        console.error('✗ Test 9 FAILED: First preStep parameters incorrect');
        testsFailed++;
    } else {
        console.log('✓ Test 9 PASSED: First preStep parameters correct');
        testsPassed++;
    }

    // Test 10: Check that second preStep has correct parameters
    const preStep2 = preSteps?.[1];
    if (!preStep2?.parameters || preStep2.parameters.message !== 'Pre-step 2') {
        console.error('✗ Test 10 FAILED: Second preStep parameters incorrect');
        testsFailed++;
    } else {
        console.log('✓ Test 10 PASSED: Second preStep parameters correct');
        testsPassed++;
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log(`Tests passed: ${testsPassed}/${testsPassed + testsFailed}`);

    if (testsFailed > 0) {
        console.error(`FAIL: ${testsFailed} test(s) failed`);
        process.exit(1);
    } else {
        console.log('PASS: All tests passed ✓');
        process.exit(0);
    }
} catch (err) {
    console.error('FAIL: Error during test execution');
    console.error(err);
    process.exit(1);
}
