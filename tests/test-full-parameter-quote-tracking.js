#!/usr/bin/env node

/**
 * Test full parameter expression quote tracking
 *
 * This test validates the recent improvements to quote handling:
 * 1. Full parameter expressions (e.g., ${{ parameters.patterns }}) are tracked
 * 2. Quotes for full expressions respect original parameter quotes
 * 3. Glob patterns in full expressions are quoted correctly
 * 4. Colons in full expressions force single quotes
 * 5. Empty strings from full expressions use single quotes (Azure normalized)
 * 6. Mixed expressions (parameter + literal) are not treated as full expressions
 * 7. Definition sections (parameters/variables) preserve original quotes
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();
const INPUTS_DIR = path.join(__dirname, 'inputs');
const QUOTE_FIXTURE = 'quote-preservation.yaml';

console.log('Testing Full Parameter Expression Quote Tracking\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

let testsPassed = 0;
let testsFailed = 0;

function loadYaml(fileName) {
    const filePath = path.join(INPUTS_DIR, fileName);
    return fs.readFileSync(filePath, 'utf8');
}

// Helper to run a test case
function runTestCase(name, params = {}, azureCompatible = false, assertions) {
    console.log(`=== ${name} ===`);

    const yaml = loadYaml(QUOTE_FIXTURE);

    const output = parser.expandPipelineFromString(yaml, {
        azureCompatible,
        ...params,
    });

    if (verbose) {
        console.log('\n--- Parser output ---');
        console.log(output);
        console.log('--- end output ---\n');
    }

    try {
        assertions(output);
        console.log('✅ PASS\n');
        testsPassed++;
        return true;
    } catch (error) {
        console.log('❌ FAIL: ' + error.message + '\n');
        testsFailed++;
        return false;
    }
}

// Test 1: Full parameter expression with glob pattern - should be quoted
runTestCase(
    'Test 1: Full parameter expression with glob pattern',
    { parameters: { patternsGlob: '**/Logging.dll' } },
    true,
    (output) => {
        // Glob pattern from full parameter expression should be quoted
        if (!output.includes("PATTERNS: '**/Logging.dll'")) {
            throw new Error('Expected glob pattern to be single-quoted from full parameter expression');
        }
    }
);

// Test 2: Full parameter expression with colon - should be quoted
runTestCase(
    'Test 2: Full parameter expression with colon',
    { parameters: { urlWithColon: 'http://example.com' } },
    true,
    (output) => {
        // URL with colon from full parameter expression should be quoted
        if (!output.includes("URL: 'http://example.com'")) {
            throw new Error('Expected URL with colon to be single-quoted from full parameter expression');
        }
    }
);

// Test 3: Full parameter expression with plain value - no quotes needed
runTestCase(
    'Test 3: Full parameter expression with plain value',
    { parameters: { plainVersion: '1.2.3' } },
    true,
    (output) => {
        // Plain value from full parameter expression should not need quotes
        if (output.includes("VERSION_SIMPLE: '1.2.3'") || output.includes('VERSION_SIMPLE: "1.2.3"')) {
            throw new Error('Plain version number should not be quoted');
        }
        if (!output.includes('VERSION_SIMPLE: 1.2.3')) {
            throw new Error('Expected VERSION_SIMPLE to have plain unquoted value');
        }
    }
);

// Test 4: Full parameter expression with empty string - should be single-quoted
runTestCase(
    'Test 4: Full parameter expression with empty string',
    { parameters: { emptyParam: '' } },
    true,
    (output) => {
        // Empty string from full parameter expression should be single-quoted (Azure normalized)
        if (!output.includes("EMPTY_PARAM: ''")) {
            throw new Error('Expected empty string to be single-quoted');
        }
    }
);

// Test 5: Mixed expression (parameter + literal) - should NOT be treated as full expression
runTestCase(
    'Test 5: Mixed expression (parameter + literal)',
    { parameters: { patternMixed: '*.dll' } },
    true,
    (output) => {
        // Mixed expression should be plain (no quotes for concatenated content)
        if (output.includes("MIXED: 'prefix-*.dll-suffix'") || output.includes('MIXED: "prefix-*.dll-suffix"')) {
            throw new Error('Mixed expression should not be quoted');
        }
        if (!output.includes('MIXED: prefix-*.dll-suffix')) {
            throw new Error('Expected MIXED to have plain unquoted value');
        }
    }
);

// Test 6: Definition section parameters preserve original quotes
runTestCase('Test 6: Definition section parameters preserve original quotes', {}, true, (output) => {
    // Parameter definitions should preserve their original quote styles
    if (!output.includes('- name: patternDef1') || !output.includes("default: '**/test.dll'")) {
        throw new Error('Parameter definition should preserve single quotes');
    }
    if (!output.includes('- name: patternDef2') || !output.includes('default: "*.exe"')) {
        throw new Error('Parameter definition should preserve double quotes');
    }
});

// Test 7: Variable values preserve quotes when NOT from full parameter expansion
runTestCase('Test 7: Variable values preserve original quotes', {}, true, (output) => {
    // Variable values should preserve their original quote styles
    if (!output.includes('- name: var1') || !output.includes("value: 'single-quoted'")) {
        throw new Error('Variable definition should preserve single quotes');
    }
    if (!output.includes('- name: var2') || !output.includes('value: "double-quoted"')) {
        throw new Error('Variable definition should preserve double quotes');
    }
});

// Test 8: Glob pattern detection with various patterns
runTestCase(
    'Test 8: Glob pattern detection with various patterns',
    {
        parameters: {
            glob1: '**/Logging.dll',
            glob2: '**/*.dll',
            glob3: '**/src/**/*.ts',
        },
    },
    true,
    (output) => {
        // All glob patterns should be single-quoted
        if (!output.includes("PAT1: '**/Logging.dll'")) {
            throw new Error('Pattern1 should be single-quoted');
        }
        if (!output.includes("PAT2: '**/*.dll'")) {
            throw new Error('Pattern2 should be single-quoted');
        }
        if (!output.includes("PAT3: '**/src/**/*.ts'")) {
            throw new Error('Pattern3 should be single-quoted');
        }
    }
);

// Test 9: Full expression with function call - should track and quote properly
runTestCase(
    'Test 9: Full expression with function that produces glob pattern',
    { parameters: { trimPattern: '**/test.dll' } },
    true,
    (output) => {
        // Result of function call on parameter should be quoted if it's a glob pattern
        if (!output.includes("TRIMMED: '**/test.dll'") && !output.includes('TRIMMED: "')) {
            throw new Error('Function result with glob pattern should be quoted');
        }
    }
);

// Test 10: Plain literal glob patterns (not from parameters) use original quote style
runTestCase('Test 10: Literal glob pattern in YAML preserves quote style', {}, true, (output) => {
    // Literal glob pattern in source YAML should preserve its quotes
    if (!output.includes("LITERAL: '**/test.dll'")) {
        throw new Error('Literal glob pattern should preserve single quotes');
    }
});

// Print summary
console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`Passed: ${testsPassed}`);
console.log(`Failed: ${testsFailed}`);
console.log(`Total:  ${testsPassed + testsFailed}`);
console.log('='.repeat(70));

if (testsFailed === 0) {
    console.log('✅ All tests passed!\n');
    process.exit(0);
} else {
    console.log(`❌ ${testsFailed} test(s) failed!\n`);
    process.exit(1);
}
