#!/usr/bin/envnode

/**
 * Test quote style preservation through nested template expansion
 *
 * Validates fixes for three bugs:
 * 1. remapStart for nested step templates used local result length instead of global
 *    step position, causing quote styles to map to wrong paths and be lost on output.
 * 2. jobs parentKey was absent from the remapStart formula; the unified idxMap approach
 *    now covers steps, jobs, and stages symmetrically.
 * 3. Runtime variables with trailing spaces were output as QUOTE_DOUBLE (double-escaped
 *    backslashes) instead of QUOTE_SINGLE, because yaml.js cannot serialize trailing
 *    spaces as PLAIN scalars.
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Nested Template Quote Style Remapping\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

function runTestCase(name, yamlFile, azureCompatible, assertions) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');
    const baseDir = path.join(__dirname, 'inputs');

    const output = parser.expandPipelineFromString(data, {
        azureCompatible,
        baseDir,
        fileName: filePath,
    });

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

// Test 1: Quote styles preserved in steps from a doubly-nested step template.
// The main pipeline has 2 explicit steps (global indices 0, 1), then references
// an outer template. The outer template has 1 step (index 2) then references an
// inner template. The inner template step (index 3) has single-quoted inputs.
// With the old buggy remapStart=0, the inner template's quote style was mapped to
// steps.0.* instead of steps.3.*, silently dropping the single quotes on output.
const test1Pass = runTestCase(
    'Test 1: Single quotes preserved in doubly-nested step template (remapStart fix)',
    'nested-step-quote-main.yaml',
    true,
    (output) => {
        if (!output.includes("jdkArchitectureOption: 'x64'")) {
            throw new Error(
                "Expected jdkArchitectureOption: 'x64' (single-quoted) from inner step template at global step index 3"
            );
        }
        if (!output.includes("jdkSourceOption: 'LocalDirectory'")) {
            throw new Error("Expected jdkSourceOption: 'LocalDirectory' (single-quoted) from inner step template");
        }
        if (!output.includes("jdkFile: '/tools/jdk.zip'")) {
            throw new Error("Expected jdkFile: '/tools/jdk.zip' (single-quoted) from inner step template");
        }
        if (!output.includes("displayName: 'Setup'")) {
            throw new Error("Expected displayName: 'Setup' (single-quoted) in explicit steps");
        }
        if (!output.includes("displayName: 'Install Java'")) {
            throw new Error("Expected displayName: 'Install Java' (single-quoted) in inner template step");
        }
    }
);

// Test 2: Quote styles preserved in a job template referenced from within a stage
// template (jobs parentKey coverage via the unified idxMap formula).
// The stage template has one explicit job then a job template reference. The job
// template's single-quoted inputs must survive the remapStart calculation.
const test2Pass = runTestCase(
    'Test 2: Single quotes preserved in job template (jobs parentKey coverage)',
    'nested-job-quote-main.yaml',
    true,
    (output) => {
        if (!output.includes("jdkArchitectureOption: 'x64'")) {
            throw new Error("Expected jdkArchitectureOption: 'x64' (single-quoted) from job template");
        }
        if (!output.includes("jdkSourceOption: 'PreInstalled'")) {
            throw new Error("Expected jdkSourceOption: 'PreInstalled' (single-quoted) from job template");
        }
        if (!output.includes('job: ExplicitJob')) {
            throw new Error('Expected ExplicitJob from explicit stage template job');
        }
        if (!output.includes('job: TemplateJob')) {
            throw new Error('Expected TemplateJob from job template reference');
        }
    }
);

// Test 3: A runtime variable ending with a trailing space must be serialized as
// QUOTE_SINGLE. YAML plain scalars forbid trailing spaces, so yaml.js would fall
// back to QUOTE_DOUBLE, which double-escapes Windows backslashes (\\), whereas
// QUOTE_SINGLE preserves them literally (\).
const test3Pass = runTestCase(
    'Test 3: Runtime variable with trailing space uses single quotes (not double)',
    'trailing-space-runtime-var-main.yaml',
    true,
    (output) => {
        const backslash = '\\';
        const expected = `msbuildArgs: '/p:RestorePackagesPath=$(Agent.TempDirectory)${backslash}nuget${backslash}packages '`;
        const notExpected = `msbuildArgs: "/p:RestorePackagesPath=$(Agent.TempDirectory)${backslash}${backslash}nuget${backslash}${backslash}packages "`;
        if (output.includes(notExpected)) {
            throw new Error('msbuildArgs must not be double-quoted with escaped backslashes');
        }
        if (!output.includes(expected)) {
            throw new Error('Expected msbuildArgs to be single-quoted with literal backslashes');
        }
    }
);

const allPassed = test1Pass && test2Pass && test3Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All nested quote remapping tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
