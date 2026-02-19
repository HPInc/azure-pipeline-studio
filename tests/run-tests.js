#!/usr/bin/env node

/**
 * Master test runner for Azure Pipeline Studio template expansion tests
 *
 * Runs all converted tests that use external YAML files and reports overall status.
 * Usage:
 *   node tests/run-tests.js       # Run all tests
 *   node tests/run-tests.js -v    # Run with verbose output
 */

const { execSync } = require('child_process');
const path = require('path');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

// List of tests to run (in order)
const tests = [
    'test-heredoc.js',
    'test-quote-preservation.js',
    'test-full-parameter-quote-tracking.js',
    'test-microsoft-boolean-compatibility.js',
    'test-non-azure-compatible.js',
    'test-expressions.js',
    'test-block-scalar-chomping.js',
    'test-conditional-steps.js',
    'test-trailing-newlines.js',
    'test-runtime-variables.js',
    'test-multilevel-templates.js',
    'test-parameter-scoping.js',
    'test-variable-scoping.js',
    'test-variable-template.js',
    'test-file-scoped-variables.js',
    'test-template-call-stack.js',
    'test-formatting.js',
    'test-comprehensive-spacing.js',
    'test-pipeline-diagram.js',
    'test-resources.js',
];

console.log('='.repeat(70));
console.log('Running Azure Pipeline Tests');
console.log('='.repeat(70));
console.log();

const results = [];
let totalPassed = 0;
let totalFailed = 0;

tests.forEach((testFile, index) => {
    const testName = testFile.replace('.js', '');
    console.log(`[${index + 1}/${tests.length}] Running ${testName}...`);

    try {
        const testPath = path.join(__dirname, testFile);
        const verboseFlag = verbose ? ' -v' : '';
        const output = execSync(`node ${testPath}${verboseFlag}`, {
            encoding: 'utf8',
            stdio: verbose ? 'inherit' : 'pipe',
        });

        if (!verbose) {
            // Show summary line from test output
            const lines = output.split('\n');
            const summaryLine = lines.find((line) => line.includes('passed ✅') || line.includes('failed ❌'));
            if (summaryLine) {
                console.log('  ' + summaryLine.trim());
            }
        }

        results.push({ test: testName, passed: true });
        totalPassed++;
    } catch (error) {
        console.log(`  ❌ ${testName} FAILED`);

        if (!verbose && error.stdout) {
            // Show error details
            console.log('  Error output:');
            const lines = error.stdout.toString().split('\n');
            lines.slice(-10).forEach((line) => console.log('    ' + line));
        }

        results.push({ test: testName, passed: false, error: error.message });
        totalFailed++;
    }

    console.log();
});

// Print final summary
console.log('='.repeat(70));
console.log('FINAL SUMMARY');
console.log('='.repeat(70));
console.log();

results.forEach((result) => {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${status} - ${result.test}`);
});

console.log();
console.log('-'.repeat(70));
console.log(`Total: ${tests.length} tests`);
console.log(`Passed: ${totalPassed}`);
console.log(`Failed: ${totalFailed}`);
console.log('-'.repeat(70));

if (totalFailed === 0) {
    console.log();
    console.log('🎉 All template expansion tests passed! 🎉');
    console.log();
    process.exit(0);
} else {
    console.log();
    console.log('❌ Some tests failed. Please review the output above.');
    console.log();
    process.exit(1);
}
