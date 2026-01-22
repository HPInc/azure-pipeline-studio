#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Non-Azure Compatible Mode Behavior\n');

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
        console.log(`❌ FAIL: ${error.message}\n`);
        passed = false;
    }

    return passed;
}

// Test 1: Non-compat mode - no >+ chomping for expressions
const test1Pass = runTestCase(
    'Test 1: Non-compat mode - no >+ chomping for expressions expanding to empty',
    'non-azure-compat-chomping.yaml',
    {},
    false,
    (output) => {
        const hasKeepChomping = /extraProperties:\s*>\+/.test(output);
        if (hasKeepChomping) {
            throw new Error('Should NOT use >+ chomping in non-compat mode');
        }

        const hasLiteral = /extraProperties:\s*\|/.test(output);
        if (!hasLiteral) {
            throw new Error('Should use | (literal) style');
        }
    }
);

// Test 2: Azure-compat mode - SHOULD use >+ chomping
const test2Pass = runTestCase(
    'Test 2: Azure-compat mode - SHOULD use >+ chomping',
    'non-azure-compat-chomping.yaml',
    {},
    true,
    (output) => {
        const hasKeepChomping = /extraProperties:\s*>\+/.test(output);
        if (!hasKeepChomping) {
            throw new Error('Should use >+ (folded keep) chomping in azure-compat mode');
        }
    }
);

// Test 3: Non-compat mode - no extra empty lines in heredoc
const test3Pass = runTestCase(
    'Test 3: Non-compat mode - no extra empty lines in heredoc',
    'non-azure-compat-heredoc.yaml',
    { parameters: { var: 'value' } },
    false,
    (output) => {
        const scriptMatch = output.match(/script:\s*[|>][\s\S]*?(?=\n[^\s]|\n\s*$)/);
        if (scriptMatch) {
            const scriptContent = scriptMatch[0];
            const blankLineCount = (scriptContent.match(/\n\s*\n/g) || []).length;
            if (blankLineCount > 2) {
                throw new Error(`Expected minimal blank lines (<=2), got ${blankLineCount}`);
            }
        }
    }
);

// Test 4: Azure-compat mode - SHOULD have extra empty lines in heredoc
const test4Pass = runTestCase(
    'Test 4: Azure-compat mode - SHOULD have extra empty lines in heredoc',
    'non-azure-compat-heredoc.yaml',
    { parameters: { var: 'value' } },
    true,
    (output) => {
        const scriptMatch = output.match(/script:\s*[|>][\s\S]*?(?=\n[^\s]|\n\s*$)/);
        if (scriptMatch) {
            const scriptContent = scriptMatch[0];
            const blankLineCount = (scriptContent.match(/\n\s*\n/g) || []).length;
            if (blankLineCount < 3) {
                throw new Error(`Expected extra blank lines (>=3), got ${blankLineCount}`);
            }
        }
    }
);

// Summary
const allPassed = test1Pass && test2Pass && test3Pass && test4Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All non-azure-compatible tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
