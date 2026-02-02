#!/usr/bin/env node

/**
 * Tests for expression validation (missing brackets, unbalanced parentheses, undefined parameters)
 */

const path = require('path');
const minimist = require('minimist');
const { formatYaml } = require('../formatter.js');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();
const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

function runTestCase(name, testFunc) {
    console.log(`=== ${name} ===`);
    try {
        testFunc();
        console.log('✅ PASS\n');
        return true;
    } catch (error) {
        console.log(`❌ FAIL: ${error.message}\n`);
        if (verbose) {
            console.log(error.stack);
        }
        return false;
    }
}

function expectError(fn, expectedMessagePart) {
    let errorThrown = false;
    try {
        fn();
    } catch (error) {
        errorThrown = true;
        if (!error.message.includes(expectedMessagePart)) {
            throw new Error(`Expected error containing "${expectedMessagePart}", but got: ${error.message}`);
        }
    }
    if (!errorThrown) {
        throw new Error(`Expected an error containing "${expectedMessagePart}" but none was thrown`);
    }
}

let passed = 0;
let failed = 0;

// Test: Missing closing }} in template expression
if (
    runTestCase('Missing closing }} in template expression', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ if eq(parameters.test, 'true')
`;
        expectError(() => formatYaml(yaml), "Missing closing '}}'");
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Missing }} on line with multiple expressions
if (
    runTestCase('Missing }} on line with multiple expressions', () => {
        const yaml = `
steps:
  - script: \${{ parameters.value }} and \${{ if eq(parameters.test, 'true')
`;
        expectError(() => formatYaml(yaml), "Missing closing '}}'");
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Extra closing parenthesis
if (
    runTestCase('Extra closing parenthesis', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ if ne(parameters.test, 'value')) }}
`;
        expectError(() => formatYaml(yaml), 'Unbalanced parentheses');
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Missing closing parenthesis
if (
    runTestCase('Missing closing parenthesis', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ if eq(parameters.test, 'value' }}
`;
        expectError(() => formatYaml(yaml), 'Unbalanced parentheses');
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Handle nested parentheses correctly
if (
    runTestCase('Handle nested parentheses correctly', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ and(eq(parameters.a, 'x'), ne(parameters.b, 'y')) }}
`;
        const result = formatYaml(yaml);
        if (typeof result !== 'object' || !result.text || !result.text.includes('condition:')) {
            throw new Error('Expected result to include "condition:"');
        }
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Not count parentheses in strings
if (
    runTestCase('Not count parentheses in strings', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ eq(parameters.test, 'value (with parens)') }}
`;
        const result = formatYaml(yaml);
        if (typeof result !== 'object' || !result.text || !result.text.includes('condition:')) {
            throw new Error('Expected result to include "condition:"');
        }
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Extra closing bracket
if (
    runTestCase('Extra closing bracket', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ variables['test']] }}
`;
        expectError(() => formatYaml(yaml), 'Unbalanced brackets');
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Missing closing bracket
if (
    runTestCase('Missing closing bracket', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ variables['test' }}
`;
        expectError(() => formatYaml(yaml), 'Unbalanced brackets');
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Undefined parameter in expansion
if (
    runTestCase('Undefined parameter in expansion', () => {
        const yaml = `
parameters:
  - name: definedParam
    default: value

steps:
  - script: echo \${{ parameters.undefinedParam }}
`;
        expectError(() => parser.expandPipelineFromString(yaml, {}), 'undefinedParam');
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Undefined parameter in condition
if (
    runTestCase('Undefined parameter in condition', () => {
        const yaml = `
parameters:
  - name: definedParam
    default: value

steps:
  - script: echo test
    condition: \${{ if eq(parameters.missingParam, 'test') }}:
`;
        expectError(() => parser.expandPipelineFromString(yaml, {}), 'missingParam');
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Not throw for defined parameters
if (
    runTestCase('Not throw for defined parameters', () => {
        const yaml = `
parameters:
  - name: myParam
    default: testValue

steps:
  - script: echo \${{ parameters.myParam }}
`;
        const result = parser.expandPipelineFromString(yaml, {});
        if (!result.includes('testValue')) {
            throw new Error('Expected result to include "testValue"');
        }
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Expression with internal braces (regex improvement)
if (
    runTestCase('Expression with internal curly braces', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ coalesce(variables['obj'], '') }}
`;
        const result = formatYaml(yaml);
        if (typeof result !== 'object' || !result.text || !result.text.includes('condition:')) {
            throw new Error('Expected result to include "condition:"');
        }
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Missing closing brace in object access
if (
    runTestCase('Missing closing brace in object literal', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ variables['key' }}
`;
        expectError(() => formatYaml(yaml), 'Unbalanced');
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Extra closing brace in object access
if (
    runTestCase('Extra closing brace in object access', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ json(object)} }}
`;
        expectError(() => formatYaml(yaml), 'Unbalanced');
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Escaped single quote in string (backslash counting)
if (
    runTestCase('Escaped single quote in string parameter', () => {
        const yaml = `
parameters:
  - name: testParam
    default: value

steps:
  - script: echo test
    condition: \${{ eq(parameters.testParam, 'it\\'s') }}
`;
        const result = formatYaml(yaml);
        if (typeof result !== 'object' || !result.text || !result.text.includes('condition:')) {
            throw new Error('Expected result to include "condition:"');
        }
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Double backslash followed by quote (quote not escaped)
if (
    runTestCase('Double backslash followed by quote', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ eq(parameters.test, 'path\\\\') }}
`;
        const result = formatYaml(yaml);
        if (typeof result !== 'object' || !result.text || !result.text.includes('condition:')) {
            throw new Error('Expected result to include "condition:"');
        }
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Brackets and parentheses in quoted string together
if (
    runTestCase('Mixed brackets and parens in quoted string', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ eq(parameters.pattern, 'test[0](*.cpp)') }}
`;
        const result = formatYaml(yaml);
        if (typeof result !== 'object' || !result.text || !result.text.includes('condition:')) {
            throw new Error('Expected result to include "condition:"');
        }
    })
) {
    passed++;
} else {
    failed++;
}

// Test: Nested function calls with quoted parameters
if (
    runTestCase('Nested function calls with complex quotes', () => {
        const yaml = `
steps:
  - script: echo test
    condition: \${{ and(eq(parameters.a, 'value'), contains(variables.b, '(test)')) }}
`;
        const result = formatYaml(yaml);
        if (typeof result !== 'object' || !result.text || !result.text.includes('condition:')) {
            throw new Error('Expected result to include "condition:"');
        }
    })
) {
    passed++;
} else {
    failed++;
}

// Summary
console.log('='.repeat(50));
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);
