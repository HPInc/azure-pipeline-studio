#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser');

const parser = new AzurePipelineParser();

console.log('Testing Azure DevOps Expression Functions\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// Helper to run a test case
function runTestCase(name, yamlFile, params, assertions) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');

    const output = parser.expandPipelineFromString(data, params || {});

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

// Test individual expression functions without YAML
console.log('=== Unit Tests: Expression Functions ===');
const unitTests = [
    // Comparison functions
    () => {
        const result = parser.evaluateFunction('eq', [5, 5]);
        if (result !== true && result !== '__TRUE__') throw new Error(`eq(5,5) failed, got ${result}`);
        return 'eq(5, 5): true';
    },
    () => {
        const result = parser.evaluateFunction('gt', [5, 3]);
        if (result !== true && result !== '__TRUE__') throw new Error(`gt(5,3) failed, got ${result}`);
        return 'gt(5, 3): true';
    },
    // Logical functions
    () => {
        const result = parser.evaluateFunction('and', [true, true]);
        if (result !== true && result !== '__TRUE__') throw new Error(`and(true,true) failed, got ${result}`);
        return 'and(true, true): true';
    },
    () => {
        const result = parser.evaluateFunction('xor', [true, false]);
        if (result !== true && result !== '__TRUE__') throw new Error(`xor(true,false) failed, got ${result}`);
        return 'xor(true, false): true';
    },
    // String functions
    () => {
        const result = parser.evaluateFunction('upper', ['azure']);
        if (result !== 'AZURE') throw new Error(`upper('azure') expected 'AZURE', got ${result}`);
        return 'upper("azure"): AZURE';
    },
    () => {
        const result = parser.evaluateFunction('replace', ['test.txt', '.txt', '.md']);
        if (result !== 'test.md') throw new Error(`replace expected 'test.md', got ${result}`);
        return 'replace("test.txt", ".txt", ".md"): test.md';
    },
];

let unitTestsPassed = true;
unitTests.forEach((test) => {
    try {
        console.log('  ' + test());
    } catch (error) {
        console.log(`  ❌ ${error.message}`);
        unitTestsPassed = false;
    }
});
console.log(unitTestsPassed ? '✅ All unit tests passed\n' : '❌ Some unit tests failed\n');

// Test 1: Basic expressions in YAML
const test1Pass = runTestCase(
    'Test 1: Basic expressions in YAML context',
    'expressions-basic.yaml',
    { parameters: { a: 10, b: 5, result: 'Success' } },
    (output) => {
        // Variables are now in array format with name/value
        if (!(output.includes('name: greater') && output.includes('value: True'))) {
            throw new Error('Expected name: greater with value: True');
        }
        if (!(output.includes('name: combined') && output.includes('value: Success'))) {
            throw new Error('Expected name: combined with value: Success');
        }
    }
);

// Test 2: Conditional expressions
const test2Pass = runTestCase(
    'Test 2: Conditional expressions with eq() and ne()',
    'expressions-conditional.yaml',
    { parameters: { environment: 'prod' } },
    (output) => {
        if (!output.includes('Production deployment')) {
            throw new Error('Expected Production deployment in output');
        }
        if (output.includes('Non-production deployment')) {
            throw new Error('Should not include Non-production deployment');
        }
    }
);

// Test 3: String manipulation functions
const test3Pass = runTestCase(
    'Test 3: String manipulation functions',
    'expressions-strings.yaml',
    { parameters: { file: 'readme.txt', name: 'azure', csv: 'a,b,c' } },
    (output) => {
        // Variables are now in array format with name/value
        if (!(output.includes('name: filename') && output.includes('value: readme.md'))) {
            throw new Error('Expected name: filename with value: readme.md');
        }
        if (!(output.includes('name: uppercase') && output.includes('value: AZURE'))) {
            throw new Error('Expected name: uppercase with value: AZURE');
        }
    }
);

// Summary
const allPassed = unitTestsPassed && test1Pass && test2Pass && test3Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All expression tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
