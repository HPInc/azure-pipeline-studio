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

let unitTestsPassed = true;
let unitTestCount = 0;
let unitTestFailCount = 0;

function runUnitTest(testFn) {
    unitTestCount++;
    try {
        const result = testFn();
        console.log('  ✅ ' + result);
    } catch (error) {
        console.log(`  ❌ ${error.message}`);
        unitTestsPassed = false;
        unitTestFailCount++;
    }
}

// Comparison Functions (6 functions)
console.log('\nComparison Functions:');
runUnitTest(() => {
    const result = parser.evaluateFunction('eq', [5, 5]);
    if (result !== true && result !== '__TRUE__') throw new Error(`eq(5,5) failed, got ${result}`);
    return 'eq(5, 5): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('ne', [5, 3]);
    if (result !== true && result !== '__TRUE__') throw new Error(`ne(5,3) failed, got ${result}`);
    return 'ne(5, 3): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('gt', [5, 3]);
    if (result !== true && result !== '__TRUE__') throw new Error(`gt(5,3) failed, got ${result}`);
    return 'gt(5, 3): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('ge', [5, 5]);
    if (result !== true && result !== '__TRUE__') throw new Error(`ge(5,5) failed, got ${result}`);
    return 'ge(5, 5): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('lt', [3, 5]);
    if (result !== true && result !== '__TRUE__') throw new Error(`lt(3,5) failed, got ${result}`);
    return 'lt(3, 5): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('le', [3, 5]);
    if (result !== true && result !== '__TRUE__') throw new Error(`le(3,5) failed, got ${result}`);
    return 'le(3, 5): true';
});

// Logical Functions (4 functions)
console.log('\nLogical Functions:');
runUnitTest(() => {
    const result = parser.evaluateFunction('and', [true, true]);
    if (result !== true && result !== '__TRUE__') throw new Error(`and(true,true) failed, got ${result}`);
    return 'and(true, true): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('or', [false, true]);
    if (result !== true && result !== '__TRUE__') throw new Error(`or(false,true) failed, got ${result}`);
    return 'or(false, true): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('not', [false]);
    if (result !== true && result !== '__TRUE__') throw new Error(`not(false) failed, got ${result}`);
    return 'not(false): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('xor', [true, false]);
    if (result !== true && result !== '__TRUE__') throw new Error(`xor(true,false) failed, got ${result}`);
    return 'xor(true, false): true';
});

// Collection Functions (5 functions)
console.log('\nCollection Functions:');
runUnitTest(() => {
    const result = parser.evaluateFunction('coalesce', [null, undefined, '', 'value']);
    if (result !== 'value') throw new Error(`coalesce expected 'value', got ${result}`);
    return 'coalesce(null, undefined, "", "value"): value';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('contains', ['hello world', 'world']);
    if (result !== true && result !== '__TRUE__') throw new Error(`contains failed, got ${result}`);
    return 'contains("hello world", "world"): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('containsValue', [{ a: 1, b: 2, c: 3 }, 2]);
    if (result !== true && result !== '__TRUE__') throw new Error(`containsValue failed, got ${result}`);
    return 'containsValue({a:1, b:2, c:3}, 2): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('in', [2, 1, 2, 3]);
    if (result !== true && result !== '__TRUE__') throw new Error(`in failed, got ${result}`);
    return 'in(2, 1, 2, 3): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('notIn', [5, 1, 2, 3]);
    if (result !== true && result !== '__TRUE__') throw new Error(`notIn failed, got ${result}`);
    return 'notIn(5, 1, 2, 3): true';
});

// String Functions (10 functions)
console.log('\nString Functions:');
runUnitTest(() => {
    const result = parser.evaluateFunction('lower', ['AZURE']);
    if (result !== 'azure') throw new Error(`lower('AZURE') expected 'azure', got ${result}`);
    return 'lower("AZURE"): azure';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('upper', ['azure']);
    if (result !== 'AZURE') throw new Error(`upper('azure') expected 'AZURE', got ${result}`);
    return 'upper("azure"): AZURE';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('startsWith', ['hello world', 'hello']);
    if (result !== true && result !== '__TRUE__') throw new Error(`startsWith failed, got ${result}`);
    return 'startsWith("hello world", "hello"): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('endsWith', ['hello world', 'world']);
    if (result !== true && result !== '__TRUE__') throw new Error(`endsWith failed, got ${result}`);
    return 'endsWith("hello world", "world"): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('trim', ['  azure  ']);
    if (result !== 'azure') throw new Error(`trim expected 'azure', got '${result}'`);
    return 'trim("  azure  "): azure';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('replace', ['test.txt', '.txt', '.md']);
    if (result !== 'test.md') throw new Error(`replace expected 'test.md', got ${result}`);
    return 'replace("test.txt", ".txt", ".md"): test.md';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('split', ['a,b,c', ',']);
    if (!Array.isArray(result) || result.length !== 3) throw new Error(`split expected array of 3, got ${result}`);
    return 'split("a,b,c", ","): ["a","b","c"]';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('join', [',', ['a', 'b', 'c']]);
    if (result !== 'a,b,c') throw new Error(`join expected 'a,b,c', got ${result}`);
    return 'join(",", ["a","b","c"]): a,b,c';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('format', ['Hello {0}, you are {1} years old', 'Alice', 30]);
    if (!result.includes('Alice') || !result.includes('30')) throw new Error(`format failed, got ${result}`);
    return 'format("Hello {0}, you are {1} years old", "Alice", 30): Hello Alice, you are 30 years old';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('length', ['hello']);
    if (result !== 5) throw new Error(`length expected 5, got ${result}`);
    return 'length("hello"): 5';
});

// Utility Functions (3 functions)
console.log('\nUtility Functions:');
runUnitTest(() => {
    const result = parser.evaluateFunction('convertToJson', [{ name: 'test', value: 123 }]);
    if (!result.includes('name') || !result.includes('test')) throw new Error(`convertToJson failed, got ${result}`);
    return 'convertToJson({name:"test", value:123}): {"name":"test","value":123}';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('counter', ['myCounter', 100]);
    if (typeof result !== 'number' || result < 100) throw new Error(`counter expected number >= 100, got ${result}`);
    return `counter("myCounter", 100): ${result}`;
});
runUnitTest(() => {
    const result = parser.evaluateFunction('length', [[1, 2, 3, 4, 5]]);
    if (result !== 5) throw new Error(`length of array expected 5, got ${result}`);
    return 'length([1,2,3,4,5]): 5';
});

// Conditional Functions (3 functions)
console.log('\nConditional Functions:');
runUnitTest(() => {
    const result = parser.evaluateFunction('iif', [true, 'yes', 'no']);
    if (result !== 'yes') throw new Error(`iif expected 'yes', got ${result}`);
    return 'iif(true, "yes", "no"): yes';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('if', [false, 'yes', 'no']);
    if (result !== 'no') throw new Error(`if expected 'no', got ${result}`);
    return 'if(false, "yes", "no"): no';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('elseif', [true, 'branch1', 'branch2']);
    if (result !== 'branch1') throw new Error(`elseif expected 'branch1', got ${result}`);
    return 'elseif(true, "branch1", "branch2"): branch1';
});

// Status Functions (5 functions)
console.log('\nStatus Functions:');
runUnitTest(() => {
    const result = parser.evaluateFunction('always', []);
    if (result !== true && result !== '__TRUE__') throw new Error(`always expected true, got ${result}`);
    return 'always(): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('canceled', []);
    if (result !== false && result !== '__FALSE__') throw new Error(`canceled expected false, got ${result}`);
    return 'canceled(): false';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('failed', []);
    if (result !== false && result !== '__FALSE__') throw new Error(`failed expected false, got ${result}`);
    return 'failed(): false';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('succeeded', []);
    if (result !== true && result !== '__TRUE__') throw new Error(`succeeded expected true, got ${result}`);
    return 'succeeded(): true';
});
runUnitTest(() => {
    const result = parser.evaluateFunction('succeededOrFailed', []);
    if (result !== true && result !== '__TRUE__') throw new Error(`succeededOrFailed expected true, got ${result}`);
    return 'succeededOrFailed(): true';
});

console.log(`\n✅ Unit tests: ${unitTestCount - unitTestFailCount}/${unitTestCount} passed\n`);

// Test 1: Basic expressions in YAML
const test1Pass = runTestCase(
    'Test 1: Basic expressions in YAML context',
    'expressions-all-functions.yaml',
    { parameters: { numA: 10, numB: 5, text: 'Hello World' } },
    (output) => {
        // Check for comparison and logical results
        if (!output.includes('eq_result')) {
            throw new Error('Expected eq_result in output');
        }
        if (!output.includes('gt_result')) {
            throw new Error('Expected gt_result in output');
        }
    }
);

// Test 2: Conditional expressions
const test2Pass = runTestCase(
    'Test 2: Conditional expressions with eq() and ne()',
    'expressions-all-functions.yaml',
    { parameters: { numA: 10, isEnabled: true } },
    (output) => {
        // Check for conditional compilation
        if (!output.includes('Compile-time if: numA is 10') && !output.includes('ConditionalFunctions')) {
            throw new Error('Expected conditional content in output');
        }
    }
);

// Test 3: String manipulation functions
const test3Pass = runTestCase(
    'Test 3: String manipulation functions',
    'expressions-all-functions.yaml',
    { parameters: { text: 'Hello World', csv: 'red,green,blue' } },
    (output) => {
        // Check for string manipulation results
        if (!output.includes('replace_result')) {
            throw new Error('Expected replace_result in output');
        }
        if (!output.includes('upper_result')) {
            throw new Error('Expected upper_result in output');
        }
    }
);

// Test 4: Expression validation - malformed expressions should not crash
console.log('=== Test 4: Expression Validation ===');
let test4Pass = true;

const validationTests = [
    {
        name: 'Missing closing bracket',
        yaml: `variables:\n  value: \${{ parameters.test\nsteps:\n  - script: echo done`,
        shouldContain: 'parameters.test',
    },
    {
        name: 'Unbalanced parentheses',
        yaml: `variables:\n  value: \${{ eq(1, 2 }}\nsteps:\n  - script: echo done`,
        shouldContain: 'eq(1, 2',
    },
    {
        name: 'Undefined parameter reference',
        yaml: `variables:\n  value: \${{ parameters.nonexistent }}\nsteps:\n  - script: echo '\${{ variables.value }}'`,
        shouldContain: 'script:',
    },
];

validationTests.forEach((test) => {
    try {
        const output = parser.expandPipelineFromString(test.yaml, { parameters: {} });
        if (!output.includes(test.shouldContain)) {
            console.log(`  ❌ ${test.name}: Expected output to contain "${test.shouldContain}"`);
            test4Pass = false;
        } else {
            console.log(`  ✅ ${test.name}: Parser handled gracefully`);
        }
    } catch (error) {
        console.log(`  ✅ ${test.name}: Parser handled with error (acceptable)`);
    }
});

console.log(test4Pass ? '✅ All validation tests passed\n' : '❌ Some validation tests failed\n');

// Summary
const allPassed = unitTestsPassed && test1Pass && test2Pass && test3Pass && test4Pass;
console.log('=== Summary ===');
console.log(allPassed ? 'All expression tests passed ✅' : 'Some tests failed ❌');
process.exit(allPassed ? 0 : 1);
