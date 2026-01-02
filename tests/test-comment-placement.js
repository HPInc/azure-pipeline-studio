const { formatYaml } = require('../extension');
const assert = require('assert');

console.log('🧪 Testing Comment Placement Logic');
console.log('==================================\n');

let passCount = 0;
let failCount = 0;

function runTest(name, input, expected) {
    console.log(`📋 Test: ${name}`);
    try {
        const result = formatYaml(input);
        const actual = result.text.trim();
        const expectedTrimmed = expected.trim();

        if (actual === expectedTrimmed) {
            console.log('✅ PASS\n');
            passCount++;
        } else {
            console.log('❌ FAIL');
            console.log('Expected:');
            console.log(expectedTrimmed);
            console.log('Actual:');
            console.log(actual);
            console.log('\n');
            failCount++;
        }
    } catch (e) {
        console.log(`❌ ERROR: ${e.message}\n`);
        failCount++;
    }
}

// Test 1: Comments before list items stay at column 0 with noArrayIndent (yaml library default)
runTest(
    'Comments before list items at column 0',
    'jobs:\n# Comment describing the job\n- job: A',
    'jobs:\n# Comment describing the job\n- job: A',
);

// Test 2: Inline comment after empty key moves to separate line (yaml library behavior)
runTest(
    'Inline comment after empty key moves to separate line',
    'jobs: # Inline comment\n- job: A',
    'jobs:\n# Inline comment\n- job: A',
);

// Test 3: Nested keys with comments at matching indent
runTest(
    'Nested keys with comments',
    'stages:\n- stage: A\n  jobs:\n  # Job list\n  - job: Build',
    'stages:\n- stage: A\n\n  jobs:\n  # Job list\n  - job: Build',
);

// Test 4: Nested inline comments move to separate line (yaml library behavior)
runTest(
    'Nested inline comments move to separate line',
    'stages:\n- stage: A\n  jobs: # Job list\n  - job: Build',
    'stages:\n- stage: A\n\n  jobs:\n  # Job list\n  - job: Build',
);

// Test 5: Mixed comments - inline comments move to separate line (yaml library behavior)
runTest(
    'Mixed comments with formatting',
    'variables: # Global vars\n  foo: bar\n\njobs:\n# Main job\n- job: Main',
    'variables:\n  # Global vars\n  foo: bar\n\njobs:\n# Main job\n- job: Main',
);

// Test 6: Verify round-trip idempotency
runTest('Round-trip idempotency', 'jobs:\n# Comment\n- job: A', 'jobs:\n# Comment\n- job: A');

console.log('🏁 TEST RESULTS');
console.log(`Passed: ${passCount}`);
console.log(`Failed: ${failCount}`);

if (failCount > 0) {
    process.exit(1);
}
