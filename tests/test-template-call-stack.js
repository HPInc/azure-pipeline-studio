#!/usr/bin/env node

/**
 * Test template call stack error formatting
 *
 * This test validates that:
 * 1. Template-not-found errors include formatted call stack
 * 2. Repository-missing errors include formatted call stack
 * 3. Parse-failure errors include formatted call stack
 * 4. Parameter validation errors include formatted call stack
 * 5. Call stack shows proper nesting with Unicode formatting
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');
const { _formatErrorDetails } = require('../error-webview.js');
const assert = require('node:assert/strict');

const parser = new AzurePipelineParser();

console.log('Testing Template Call Stack Error Formatting\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// Helper to run an error test case
function runErrorTestCase(name, yamlFile, params, expectedError, stackAssertions) {
    console.log(`=== ${name} ===`);
    const filePath = path.join(__dirname, 'inputs', yamlFile);
    const data = fs.readFileSync(filePath, 'utf8');
    const baseDir = path.join(__dirname, 'inputs');

    const options = {
        baseDir,
        fileName: filePath,
        ...params,
    };

    let passed = true;
    try {
        const output = parser.expandPipelineFromString(data, options);
        console.log('❌ FAIL: Expected error but expansion succeeded\n');
        if (verbose) {
            console.log('Unexpected output:', output);
        }
        passed = false;
    } catch (error) {
        const errorMsg = error.message;

        if (verbose) {
            console.log('\n--- Error message ---');
            console.log(errorMsg);
            console.log('--- end error message ---\n');
        }

        try {
            // Check expected error message
            if (!errorMsg.includes(expectedError)) {
                throw new Error(`Expected error message to contain "${expectedError}" but got: ${errorMsg}`);
            }

            // Check for call stack presence
            if (!errorMsg.includes('Template call stack:')) {
                throw new Error('Error message missing "Template call stack:"');
            }

            // Run additional stack assertions
            if (stackAssertions) {
                stackAssertions(errorMsg);
            }

            console.log('✅ PASS\n');
        } catch (assertError) {
            console.log('❌ FAIL: ' + assertError.message + '\n');
            passed = false;
        }
    }

    return passed;
}

// Test 1: Template-not-found error with call stack
const test1Pass = runErrorTestCase(
    'Test 1: Template-not-found shows call stack',
    'error-template-not-found.yaml',
    {},
    'Template file not found',
    (errorMsg) => {
        // Should show the root file in the stack with line number 2
        if (!errorMsg.includes('error-template-not-found.yaml:2')) {
            throw new Error('Call stack missing root file line number (expected :2)');
        }

        // Should show the missing template reference
        if (!errorMsg.includes('missing-template.yaml')) {
            throw new Error('Error message missing template reference');
        }
    }
);

// Test 2: Repository-missing error with call stack
const test2Pass = runErrorTestCase(
    'Test 2: Repository-missing shows call stack',
    'error-repo-missing.yaml',
    {
        resources: {
            repositories: [{ repository: 'self', type: 'git' }],
        },
    },
    "Repository resource 'unknownrepo' is not defined",
    (errorMsg) => {
        // Should show the root file in the stack with line number 2
        // calls template at line 2 in error-repo-missing.yaml
        if (!errorMsg.includes('error-repo-missing.yaml:2')) {
            throw new Error('Call stack missing root file line number (expected :2)');
        }
    }
);

// Test 3: Parse-failure error with call stack
const test3Pass = runErrorTestCase(
    'Test 3: Parse-failure shows call stack',
    'error-parse-failure-root.yaml',
    {},
    'Failed to parse template',
    (errorMsg) => {
        // Should show the root file in the stack with line number 2
        if (!errorMsg.includes('error-parse-failure-root.yaml:2')) {
            throw new Error('Call stack missing root file line number (expected :2)');
        }

        // Should mention the bad template
        if (!errorMsg.includes('bad-yaml-template.yaml')) {
            throw new Error('Error message missing bad template reference');
        }
    }
);

// Test 4: Parameter validation error with nested call stack
const test4Pass = runErrorTestCase(
    'Test 4: Parameter validation shows nested call stack',
    'error-param-validation-nested.yaml',
    {},
    'Unknown parameter(s) for template',
    (errorMsg) => {
        // Should show the root file
        if (!errorMsg.includes('error-param-validation-nested.yaml')) {
            throw new Error('Call stack missing root file');
        }

        // Should show intermediate template
        if (!errorMsg.includes('intermediate-template.yaml')) {
            throw new Error('Call stack missing intermediate template');
        }

        // Should show final template with the error
        if (!errorMsg.includes('final-template.yaml')) {
            throw new Error('Call stack missing final template');
        }

        // Check for Unicode formatting (└──)
        if (!errorMsg.includes('└──')) {
            throw new Error('Call stack missing Unicode formatting');
        }
    }
);

// Test 5: Multi-level template call stack ordering
const test5Pass = runErrorTestCase(
    'Test 5: Call stack shows correct ordering',
    'error-multilevel-stack.yaml',
    {},
    'Template file not found',
    (errorMsg) => {
        // Extract the call stack section
        const stackMatch = errorMsg.match(/Template call stack:([\s\S]*?)(?:\n\n|$)/);
        if (!stackMatch) {
            throw new Error('Could not extract call stack section');
        }

        const stackSection = stackMatch[1];
        const lines = stackSection.split('\n').filter((line) => line.trim());

        // Should have 3 levels: root -> level1 -> level2 (missing)
        if (lines.length < 2) {
            throw new Error('Call stack should have at least 2 entries');
        }

        // First line should be the root
        if (!lines[0].includes('error-multilevel-stack.yaml')) {
            throw new Error('First stack entry should be root file');
        }

        // Second line should be indented and show intermediate template
        if (!lines[1].includes('└──') || !lines[1].includes('level1-template.yaml')) {
            throw new Error('Second stack entry should show level1 template with indentation');
        }
    }
);

// Test 6: Root file undefined parameter with line number
const test6Pass = runErrorTestCase(
    'Test 6: Root file undefined parameter shows line number',
    'error-root-param-undefined.yaml',
    {},
    "Undefined template parameter 'missing'",
    (errorMsg) => {
        // Should show the root file with line number
        if (!errorMsg.includes('error-root-param-undefined.yaml:11')) {
            throw new Error('Call stack missing root file line number (expected :11)');
        }
    }
);

// Test 7: Nested file undefined parameter with line numbers
const test7Pass = runErrorTestCase(
    'Test 7: Nested file undefined parameter shows line numbers',
    'error-nested-param-undefined.yaml',
    {},
    "Undefined template parameter 'thisDoesNotExist'",
    (errorMsg) => {
        // Root calls nested at line 2
        if (!errorMsg.includes('error-nested-param-undefined.yaml:2')) {
            throw new Error('Call stack missing root file line number (expected :2)');
        }

        // Nested file has error at line 4 (line number updated after formatter added blank line for step spacing)
        if (!errorMsg.includes('nested-param-template.yaml:4')) {
            throw new Error('Call stack missing nested file line number (expected :4)');
        }
    }
);

// Test 8: Nested missing template with line numbers in stack
const test8Pass = runErrorTestCase(
    'Test 8: Nested missing template shows line numbers',
    'error-nested-missing-template.yaml',
    {},
    'Template file not found: truly-missing-template.yaml',
    (errorMsg) => {
        // Root calls intermediate at line 2
        if (!errorMsg.includes('error-nested-missing-template.yaml:2')) {
            throw new Error('Call stack missing root file line number (expected :2)');
        }

        // Intermediate calls missing at line 4
        if (!errorMsg.includes('nested-missing-caller.yaml:4')) {
            throw new Error('Call stack missing intermediate file line number (expected :4)');
        }
    }
);

const test9Pass = (() => {
    console.log('=== Test 9: Syntax hints link to the failing template line ===');
    const hintParser = new AzurePipelineParser();
    const baseDir = path.join(__dirname, 'inputs');
    const intermediatePath = path.join(baseDir, 'intermediate-template.yaml');
    const failingPath = path.join(baseDir, 'final-template.yaml');
    hintParser.readFileContent = (filePath) => {
        if (filePath === intermediatePath) {
            return 'stages:\n\n  - template: final-template.yaml\n';
        }
        if (filePath === failingPath) {
            return 'stages:\n  - stage: Build\n    jobs:\n     - ${{ if true }}:\n        - job: Build\n      ${{ else }}:\n        - job: Other\n';
        }
        throw new Error(`Unexpected template path: ${filePath}`);
    };
    try {
        hintParser.expandPipelineFromString('stages:\n  - template: intermediate-template.yaml\n', {
            baseDir,
            fileName: path.join(baseDir, 'error-root.yaml'),
        });
        throw new Error('Expected a syntax hint error');
    } catch (error) {
        const message = error.message;
        if (
            !message.includes('potential issues:') ||
            !message.includes('error-root.yaml:2') ||
            !message.includes(`intermediate-template.yaml:3 (${intermediatePath})`) ||
            !message.includes(`final-template.yaml:6 (${failingPath})`)
        ) {
            console.log(`FAIL: Incorrect error navigation: ${message}\n`);
            return false;
        }
        console.log('PASS\n');
        return true;
    }
})();

// Summary
const test10Pass = (() => {
    console.log('=== Test 10: Error details follow the template stack without indentation ===');
    try {
        assert.equal(
            _formatErrorDetails(
                ['  Template expansion failed.', '    line 148: Invalid indentation.'],
                ['root.yaml:172', 'final-template.yaml:148 (/templates/final-template.yaml)']
            ),
            'Template call stack:\n  root.yaml:172\n  final-template.yaml:148 (/templates/final-template.yaml)\n\nline 148: Invalid indentation.'
        );
        const templateLines = ['root.yaml:172', 'final-template.yaml:146 (/templates/final-template.yaml)'];
        const diagnostic = 'line 146: Conditional list item is indented 5 spaces; expected 4.';
        const expected = `Template call stack:\n  ${templateLines.join('\n  ')}\n\n${diagnostic}`;
        const preamble =
            '[\\\\wsl.localhost\\Ubuntu-22.04\\root\\workspace\\codeway.yaml] Template(/stages/windows/unit-tests-v0.yaml) expansion failed. Potential issues:';
        assert.equal(_formatErrorDetails(['Error:', preamble, `  ${diagnostic}`], templateLines), expected);
        assert.equal(_formatErrorDetails([`${preamble} ${diagnostic}`], templateLines), expected);
        assert.equal(
            _formatErrorDetails(["Template 'final-template.yaml' potential issues:", diagnostic], templateLines),
            expected
        );
        assert.equal(_formatErrorDetails(['Potential template issues:', diagnostic], templateLines), expected);
        assert.equal(_formatErrorDetails([preamble], []), preamble);
        assert.equal(_formatErrorDetails(['  Invalid YAML.'], []), 'Invalid YAML.');
        assert.equal(_formatErrorDetails([], []), '');
        const rootParser = new AzurePipelineParser();
        rootParser.readFileContent = () => {
            throw new Error('Must not expand templates when root indentation is invalid');
        };
        assert.throws(
            () =>
                rootParser.expandPipelineFromString(
                    [
                        'stages:',
                        '- template: missing.yaml',
                        '  parameters:',
                        '    enableSonarScan: true',
                        '     sonarGate: true',
                    ].join('\n'),
                    { fileName: '/pipelines/codeway.yaml' }
                ),
            (error) =>
                error.message.includes('Failed to parse YAML:') &&
                error.message.includes('/pipelines/codeway.yaml:5') &&
                !error.message.includes('Must not expand templates') &&
                !error.message.includes('Template file not found')
        );
        console.log('PASS\n');
        return true;
    } catch (error) {
        console.log(`FAIL: ${error.message}\n`);
        return false;
    }
})();

console.log('='.repeat(70));
const totalTests = 10;
const passedTests = [
    test1Pass,
    test2Pass,
    test3Pass,
    test4Pass,
    test5Pass,
    test6Pass,
    test7Pass,
    test8Pass,
    test9Pass,
    test10Pass,
].filter(Boolean).length;
const failedTests = totalTests - passedTests;

console.log(`Total tests: ${totalTests}`);
console.log(`Passed: ${passedTests} ✅`);
console.log(`Failed: ${failedTests} ❌`);
console.log('='.repeat(70));

if (failedTests === 0) {
    console.log('\n🎉 All template call stack tests passed!\n');
    process.exit(0);
} else {
    console.log('\n❌ Some tests failed.\n');
    process.exit(1);
}
