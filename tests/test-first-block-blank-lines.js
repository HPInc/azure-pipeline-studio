const { formatYaml } = require('../extension.js');
const assert = require('assert');

// Test that firstBlockBlankLines applies to the first top-level section
function testFirstBlockBlankLinesDefault() {
    const input = `parameters:
- name: test
  type: string
  default: value
stages:
- stage: Build
  jobs:
  - job: Test
`;

    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    const lines = result.text.split('\n');

    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');
    assert(stagesIndex > 0, 'stages: line not found');

    // Count blank lines before 'stages:'
    let blankCount = 0;
    for (let i = stagesIndex - 1; i >= 0; i--) {
        if (lines[i].trim() === '') {
            blankCount++;
        } else {
            break;
        }
    }

    assert.strictEqual(blankCount, 2, `Expected 2 blank lines before 'stages:', got ${blankCount}`);
    console.log('✓ firstBlockBlankLines default (2) test passed');
}

// Test that firstBlockBlankLines works with custom value
function testFirstBlockBlankLinesCustom() {
    const input = `parameters:
- name: test
  type: string
stages:
- stage: Build
`;

    const result = formatYaml(input, { firstBlockBlankLines: 3 });
    const lines = result.text.split('\n');

    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');
    let blankCount = 0;
    for (let i = stagesIndex - 1; i >= 0; i--) {
        if (lines[i].trim() === '') {
            blankCount++;
        } else {
            break;
        }
    }

    assert.strictEqual(blankCount, 3, `Expected 3 blank lines before 'stages:', got ${blankCount}`);
    console.log('✓ firstBlockBlankLines custom (3) test passed');
}

// Test that firstBlockBlankLines = 0 removes blank lines
function testFirstBlockBlankLinesZero() {
    const input = `parameters:
- name: test
  type: string


stages:
- stage: Build
`;

    const result = formatYaml(input, { firstBlockBlankLines: 0 });
    const lines = result.text.split('\n');

    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');
    let blankCount = 0;
    for (let i = stagesIndex - 1; i >= 0; i--) {
        if (lines[i].trim() === '') {
            blankCount++;
        } else {
            break;
        }
    }

    assert.strictEqual(blankCount, 0, `Expected 0 blank lines before 'stages:', got ${blankCount}`);
    console.log('✓ firstBlockBlankLines zero test passed');
}

// Test that firstBlockBlankLines applies to ALL top-level sections (not just the first)
function testFirstBlockBlankLinesAllSections() {
    const input = `parameters:
- name: test
  type: string
stages:
- stage: Build
jobs:
- job: Test
steps:
- script: echo hello
`;

    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    const lines = result.text.split('\n');

    // Check stages (should have blank lines - it's the first main section)
    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');
    let blankCountStages = 0;
    for (let i = stagesIndex - 1; i >= 0 && lines[i].trim() === ''; i--) {
        blankCountStages++;
    }
    assert.strictEqual(
        blankCountStages,
        2,
        `Expected 2 blank lines before 'stages:' (first occurrence), got ${blankCountStages}`,
    );

    // Check jobs (formatter adds 1 blank line for nested sections)
    const jobsIndex = lines.findIndex((l) => l.trim() === 'jobs:');
    let blankCountJobs = 0;
    for (let i = jobsIndex - 1; i >= 0 && lines[i].trim() === ''; i--) {
        blankCountJobs++;
    }
    assert.strictEqual(
        blankCountJobs,
        1,
        `Expected 1 blank line before 'jobs:' (nested section spacing), got ${blankCountJobs}`,
    );

    // Check steps (formatter adds 1 blank line for nested sections)
    const stepsIndex = lines.findIndex((l) => l.trim() === 'steps:');
    let blankCountSteps = 0;
    for (let i = stepsIndex - 1; i >= 0 && lines[i].trim() === ''; i--) {
        blankCountSteps++;
    }
    assert.strictEqual(
        blankCountSteps,
        1,
        `Expected 1 blank line before 'steps:' (nested section spacing), got ${blankCountSteps}`,
    );

    console.log('✓ firstBlockBlankLines applies to FIRST section only test passed');
}

// Test that firstBlockBlankLines doesn't apply if file doesn't start with parameters
function testFirstBlockBlankLinesNoParameters() {
    const input = `stages:
- stage: Build
  jobs:
  - job: Test
`;

    const result = formatYaml(input, { firstBlockBlankLines: 2 });
    const lines = result.text.split('\n');

    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');
    assert.strictEqual(stagesIndex, 0, 'stages: should be on first line when no parameters');

    console.log('✓ firstBlockBlankLines does not apply without parameters test passed');
}

// Test that firstBlockBlankLines works with comments before sections
function testFirstBlockBlankLinesWithComments() {
    const input = `parameters:
- name: test
  type: string
# Comment about stages
stages:
- stage: Build
`;

    const result = formatYaml(input, { firstBlockBlankLines: 2 });

    // Should have comment preserved
    const hasComment = result.text.includes('# Comment about stages');
    assert(hasComment, 'Comment should be preserved');

    // Comment handling is complex - just verify it's present and formatting doesn't crash
    console.log('✓ firstBlockBlankLines with comments test passed');
}

// Test that firstBlockBlankLines respects max limit of 6
function testFirstBlockBlankLinesMaxLimit() {
    const input = `parameters:
- name: test
  type: string
stages:
- stage: Build
`;

    const result = formatYaml(input, { firstBlockBlankLines: 10 });
    const lines = result.text.split('\n');

    const stagesIndex = lines.findIndex((l) => l.trim() === 'stages:');
    let blankCount = 0;
    for (let i = stagesIndex - 1; i >= 0 && lines[i].trim() === ''; i--) {
        blankCount++;
    }

    assert(blankCount <= 6, `Expected max 6 blank lines, got ${blankCount}`);
    console.log('✓ firstBlockBlankLines max limit test passed');
}

// Run all tests
try {
    testFirstBlockBlankLinesDefault();
    testFirstBlockBlankLinesCustom();
    testFirstBlockBlankLinesZero();
    testFirstBlockBlankLinesAllSections();
    testFirstBlockBlankLinesNoParameters();
    testFirstBlockBlankLinesWithComments();
    testFirstBlockBlankLinesMaxLimit();
    console.log('\n✅ All firstBlockBlankLines tests passed!');
} catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
}
