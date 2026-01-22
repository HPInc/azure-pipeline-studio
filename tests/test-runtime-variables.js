#!/usr/bin/env node

/**
 * Test runtime variable handling
 *
 * This test validates that:
 * 1. Runtime variables like $(Agent.OS) are not quoted
 * 2. Runtime variables work in displayName, env, and scripts
 * 3. Mixed compile-time and runtime variables work correctly
 * 4. Runtime variables with colons are not quoted
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Runtime Variable Handling\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// Helper to run a test case
function runTestCase(name, yamlFile, params, azureCompatible, assertions) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');

    const output = parser.expandPipelineFromString(data, Object.assign({ azureCompatible }, params || {}));

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

// Test 1: Runtime variables are not quoted
const test1Pass = runTestCase(
    'Test 1: Runtime variables are not quoted',
    'runtime-variables.yaml',
    { parameters: { environment: 'production' } },
    false,
    (output) => {
        // Runtime variables in displayName should not be quoted
        if (output.includes("displayName: '$(Agent.OS)'") || output.includes('displayName: "$(Agent.OS)"')) {
            throw new Error('Runtime variable $(Agent.OS) should not be quoted in displayName');
        }
        if (!output.includes('displayName: Running on $(Agent.OS)')) {
            throw new Error('Expected unquoted runtime variable in displayName');
        }

        // Runtime variables in env should not be quoted
        if (output.includes("BRANCH: '$(Build.SourceBranch)'") || output.includes('BRANCH: "$(Build.SourceBranch)"')) {
            throw new Error('Runtime variable $(Build.SourceBranch) should not be quoted in env');
        }
        if (!output.includes('BRANCH: $(Build.SourceBranch)')) {
            throw new Error('Expected unquoted runtime variable in env');
        }

        // Check multiple runtime variables
        if (!output.includes('REASON: $(Build.Reason)')) {
            throw new Error('Runtime variable $(Build.Reason) should be unquoted');
        }
        if (!output.includes('OS: $(Agent.OS)')) {
            throw new Error('Runtime variable $(Agent.OS) in env should be unquoted');
        }
    }
);

// Test 2: Mixed compile-time and runtime variables
const test2Pass = runTestCase(
    'Test 2: Mixed compile-time and runtime variables',
    'runtime-variables.yaml',
    { parameters: { environment: 'staging' } },
    false,
    (output) => {
        // Compile-time variable should be expanded and quoted
        if (!output.includes("ENV: 'staging'") && !output.includes('ENV: staging')) {
            throw new Error('Compile-time variable should be expanded');
        }

        // Runtime variable should not be quoted (even in same context)
        if (!output.includes('OS: $(Agent.OS)')) {
            throw new Error('Runtime variable should remain unquoted');
        }
    }
);

// Test 3: Runtime variables in script blocks
const test3Pass = runTestCase(
    'Test 3: Runtime variables in script blocks',
    'runtime-variables.yaml',
    { parameters: { environment: 'production' } },
    false,
    (output) => {
        // Runtime variables in bash scripts should work
        if (!output.includes('Build ID: $(Build.BuildId)')) {
            throw new Error('Runtime variable in script not found');
        }
        if (!output.includes('Agent Name: $(Agent.Name)')) {
            throw new Error('Runtime variable $(Agent.Name) in script not found');
        }
        if (!output.includes('Source Branch: $(Build.SourceBranch)')) {
            throw new Error('Runtime variable $(Build.SourceBranch) in script not found');
        }
    }
);

// Test 4: Runtime variables with colons
const test4Pass = runTestCase(
    'Test 4: Runtime variables with colons are not quoted',
    'runtime-variables.yaml',
    { parameters: { environment: 'production' } },
    false,
    (output) => {
        // Even though it has a colon (URI), runtime variables should not be quoted
        if (
            output.includes("URI: '$(System.TeamFoundationCollectionUri)'") ||
            output.includes('URI: "$(System.TeamFoundationCollectionUri)"')
        ) {
            throw new Error('Runtime variable with colon should not be quoted');
        }
        if (!output.includes('URI: $(System.TeamFoundationCollectionUri)')) {
            throw new Error('Expected unquoted runtime variable with colon');
        }
    }
);

// Test 5: Azure compatible mode
const test5Pass = runTestCase(
    'Test 5: Runtime variables in Azure compatible mode',
    'runtime-variables.yaml',
    { parameters: { environment: 'production' } },
    true,
    (output) => {
        // Runtime variables should still not be quoted in Azure mode
        if (!output.includes('OS: $(Agent.OS)')) {
            throw new Error('Runtime variable should be unquoted in Azure mode');
        }
        if (!output.includes('BRANCH: $(Build.SourceBranch)')) {
            throw new Error('Runtime variable should be unquoted in Azure mode');
        }
    }
);

// Summary
const allPassed = test1Pass && test2Pass && test3Pass && test4Pass && test5Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All runtime variable tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
