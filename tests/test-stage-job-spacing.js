#!/usr/bin/env node

/**
 * Test suite for stage and job list spacing in Azure Pipeline formatting
 *
 * Tests verify that blank lines are correctly inserted between:
 * - Stage items in stages: lists
 * - Job items in jobs: lists
 * - Step items in steps: lists (controlled by stepSpacing option)
 *
 * Key behaviors tested:
 * - Blank lines added between sibling list items at the same indent level
 * - No duplicate blanks when one already exists immediately before next sibling
 * - Spacing works correctly with conditional expressions (${{ if }})
 * - Spacing works with template calls
 * - Internal blank lines within nested content don't interfere with sibling spacing
 */

const fs = require('fs');
const path = require('path');
const { formatYaml } = require('../formatter.js');
const minimist = require('minimist');

console.log('Testing Stage and Job List Spacing\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

let totalTests = 0;
let passedTests = 0;

// Read and parse the single test file with multiple YAML documents
const testFilePath = path.join(__dirname, 'inputs', 'spacing-tests.yaml');
const testFileContent = fs.readFileSync(testFilePath, 'utf8');
// Split by document separator and filter out empty documents
const testDocuments = testFileContent
    .split(/\n---\n/)
    .map((doc) => {
        // Remove leading comment line (the test name comment)
        const lines = doc.trim().split('\n');
        if (lines[0] && lines[0].startsWith('#')) {
            lines.shift();
        }
        return lines.join('\n').trim();
    })
    .filter((doc) => doc.length > 0);

function runTestCase(name, testIndex, expectedCheck) {
    totalTests++;
    console.log(`=== ${name} ===`);

    const input = testDocuments[testIndex];

    if (verbose) {
        console.log('\n--- Input ---');
        console.log(input);
        console.log('--- end input ---\n');
    }

    try {
        const result = formatYaml(input, { stepSpacing: true });

        if (verbose) {
            console.log('\n--- Output ---');
            console.log(result.text);
            console.log('--- end output ---\n');
        }

        expectedCheck(result.text);
        console.log('✅ PASS\n');
        passedTests++;
        return true;
    } catch (error) {
        console.log('❌ FAIL: ' + error.message + '\n');
        return false;
    }
}

// Test 1: Blank lines between stage items
runTestCase('Test 1: Blank lines between stage items', 0, (output) => {
    const lines = output.split('\n');
    let foundBlankBetweenStages = false;

    for (let i = 0; i < lines.length - 1; i++) {
        const currentLine = lines[i].trim();
        const nextLine = lines[i + 1].trim();

        // Look for blank line pattern: after Build stage content, before Test stage
        if (currentLine === '- script: echo Build' && lines[i + 1].trim() === '') {
            // Check if the line after the blank is the Test stage
            for (let j = i + 2; j < lines.length; j++) {
                if (lines[j].trim() !== '') {
                    if (lines[j].trim() === '- stage: Test') {
                        foundBlankBetweenStages = true;
                    }
                    break;
                }
            }
        }
    }

    if (!foundBlankBetweenStages) {
        throw new Error('Expected blank line between stage items');
    }
});

// Test 2: Blank lines between job items
runTestCase('Test 2: Blank lines between job items', 1, (output) => {
    const lines = output.split('\n');
    let foundBlankBetweenJobs = false;

    for (let i = 0; i < lines.length - 1; i++) {
        const currentLine = lines[i].trim();

        // Look for blank line pattern: after Build job content, before Test job
        if (currentLine === '- script: echo Build' && lines[i + 1].trim() === '') {
            // Check if Test job comes after the blank
            for (let j = i + 2; j < lines.length; j++) {
                if (lines[j].trim() !== '') {
                    if (lines[j].trim() === '- job: TestJob') {
                        foundBlankBetweenJobs = true;
                    }
                    break;
                }
            }
        }
    }

    if (!foundBlankBetweenJobs) {
        throw new Error('Expected blank line between job items');
    }
});

// Test 3: No duplicate blank lines when one exists
runTestCase('Test 3: No duplicate blank lines when one already exists', 2, (output) => {
    const lines = output.split('\n');
    let consecutiveBlankCount = 0;
    let maxConsecutiveBlank = 0;

    for (const line of lines) {
        if (line.trim() === '') {
            consecutiveBlankCount++;
            maxConsecutiveBlank = Math.max(maxConsecutiveBlank, consecutiveBlankCount);
        } else {
            consecutiveBlankCount = 0;
        }
    }

    if (maxConsecutiveBlank > 1) {
        throw new Error(`Expected no more than 1 consecutive blank line, found ${maxConsecutiveBlankCount}`);
    }
});

// Test 4: Stage items with conditional expressions
runTestCase('Test 4: Blank lines with conditional stage items', 3, (output) => {
    const lines = output.split('\n');
    let foundBlankBeforeTest = false;

    // Look for the Test conditional directive and check if there's a blank before it
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].trim().includes('if eq(parameters.test, true)')) {
            // Check backwards for a blank line
            for (let j = i - 1; j >= 0; j--) {
                if (lines[j].trim() === '') {
                    foundBlankBeforeTest = true;
                    break;
                }
                if (lines[j].trim() !== '') {
                    // Found non-blank content before finding a blank
                    break;
                }
            }
            break;
        }
    }

    if (!foundBlankBeforeTest) {
        throw new Error('Expected blank line before Test stage');
    }
});

// Test 5: Job items with template calls
runTestCase('Test 5: Blank lines between job items with templates', 4, (output) => {
    const lines = output.split('\n');
    let foundBlankBetweenJobs = false;

    for (let i = 0; i < lines.length - 1; i++) {
        const currentLine = lines[i].trim();

        // Look for blank between build template and Test job
        if (currentLine.includes('build-template') && lines[i + 1].trim() === '') {
            // Check if Test job comes after
            for (let j = i + 2; j < lines.length; j++) {
                if (lines[j].trim() !== '') {
                    if (lines[j].trim() === '- job: TestJob') {
                        foundBlankBetweenJobs = true;
                    }
                    break;
                }
            }
        }
    }

    if (!foundBlankBetweenJobs) {
        throw new Error('Expected blank line between job items with templates');
    }
});

// Test 6: No spacing added between steps (only between stages/jobs)
runTestCase('Test 6: Steps have spacing but are under stepSpacing control', 5, (output) => {
    const lines = output.split('\n');
    let stepCount = 0;
    let blanksBetweenSteps = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('- script:')) {
            stepCount++;
            // Check if there's a blank before the next step
            if (i + 1 < lines.length && lines[i + 1].trim() === '') {
                if (i + 2 < lines.length && lines[i + 2].trim().startsWith('- script:')) {
                    blanksBetweenSteps++;
                }
            }
        }
    }

    if (verbose) {
        console.log(`Found ${stepCount} steps with ${blanksBetweenSteps} blank lines between them`);
    }

    // Steps should have spacing when stepSpacing is true
    if (stepCount === 3 && blanksBetweenSteps === 0) {
        throw new Error('Expected blank lines between steps when stepSpacing is enabled');
    }
});

// Test 7: Nested stages with blank lines already present internally
runTestCase('Test 7: Blank lines added correctly despite internal blanks', 6, (output) => {
    const lines = output.split('\n');
    let foundBlankBeforeTest = false;

    // Find the Test stage line
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '- stage: Test') {
            // Check if the previous non-blank line is from Build stage
            for (let j = i - 1; j >= 0; j--) {
                if (lines[j].trim() === '') {
                    // Found a blank, continue looking back
                    continue;
                } else if (lines[j].trim() === '- script: echo Build') {
                    // Found the last line of Build stage content, there should be a blank before Test
                    foundBlankBeforeTest = i - j > 1; // There's at least one blank between them
                    break;
                } else if (lines[j].trim() !== '') {
                    break;
                }
            }
            break;
        }
    }

    if (!foundBlankBeforeTest) {
        throw new Error('Expected blank line before Test stage even when Build stage has internal blanks');
    }
});

// Test 8: Multiple stages with mixed conditionals
runTestCase('Test 8: Multiple stages with conditionals', 7, (output) => {
    const lines = output.split('\n');

    // Find the conditional list items and Deploy stage
    let testConditionalLine = -1;
    let deployStage = -1;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.includes('if eq(parameters.test, true)')) {
            testConditionalLine = i;
        }
        if (trimmed === '- stage: Deploy') {
            deployStage = i;
        }
    }

    // Check that there's a blank before the Test conditional
    let hasBlankBeforeTest = false;
    if (testConditionalLine > 0) {
        for (let j = testConditionalLine - 1; j >= 0; j--) {
            if (lines[j].trim() === '') {
                hasBlankBeforeTest = true;
                break;
            }
            if (lines[j].trim() !== '') {
                break;
            }
        }
    }

    // Check that there's a blank before Deploy stage
    let hasBlankBeforeDeploy = false;
    if (deployStage > 0) {
        for (let j = deployStage - 1; j >= 0; j--) {
            if (lines[j].trim() === '') {
                hasBlankBeforeDeploy = true;
                break;
            }
            if (lines[j].trim() !== '') {
                break;
            }
        }
    }

    if (!hasBlankBeforeTest) {
        throw new Error('Expected blank line before Test conditional');
    }
    if (!hasBlankBeforeDeploy) {
        throw new Error('Expected blank line before Deploy stage');
    }
});

// Summary
console.log('='.repeat(50));
console.log(`Tests passed: ${passedTests}/${totalTests}`);
if (passedTests === totalTests) {
    console.log('✅ All tests passed!');
    process.exit(0);
} else {
    console.log('❌ Some tests failed');
    process.exit(1);
}
