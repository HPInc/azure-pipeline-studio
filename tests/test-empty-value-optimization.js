/**
 * Test suite for empty value optimization in protectEmptyValues function.
 *
 * This suite verifies that the optimization using regex pattern matching
 * (/^(\s*)([^:]+):\s*$/) correctly identifies empty value keys and:
 * 1. Preserves empty values with comments on separate lines
 * 2. Distinguishes between empty values and section headers with children
 * 3. Maintains idempotency across multiple formatting passes
 * 4. Handles edge cases like special characters, unicode, and large files
 *
 * The optimization reduces unnecessary string operations by:
 * - Early exit for comments, blank lines, and list items
 * - Single regex match instead of multiple trim/check operations
 * - Cleaner control flow with explicit pattern matching
 */

const assert = require('assert');
const { formatYaml } = require('../extension');

function testEmptyValueOptimization() {
    console.log('Testing empty value optimization...');

    // Test 1: Basic empty value with comment
    const test1Input = `default:
  # This is a comment for the empty value
next: value`;

    const test1Result = formatYaml(test1Input);
    assert.strictEqual(test1Result.error, undefined, 'Test 1 should not have errors');
    assert(test1Result.text.includes('default:\n  # This is a comment'), 'Test 1: Comment should be on separate line');
    assert(!test1Result.text.includes('default: #'), 'Test 1: Comment should not be inline');

    // Test 2: Idempotency - format twice should give same result
    const test2Result1 = formatYaml(test1Input);
    const test2Result2 = formatYaml(test2Result1.text);
    assert.strictEqual(test2Result1.text, test2Result2.text, 'Test 2: Formatting should be idempotent');

    // Test 3: Empty value without comment
    const test3Input = `empty:
next: value`;

    const test3Result = formatYaml(test3Input);
    assert.strictEqual(test3Result.error, undefined, 'Test 3 should not have errors');
    assert(test3Result.text.includes('empty:\n'), 'Test 3: Empty value should remain on own line');

    // Test 4: Section header with children (should NOT be protected)
    const test4Input = `steps:
  - task: Something@1`;

    const test4Result = formatYaml(test4Input);
    assert.strictEqual(test4Result.error, undefined, 'Test 4 should not have errors');
    assert(test4Result.text.includes('steps:\n'), 'Test 4: Section header should remain');
    assert(!test4Result.text.includes('__EMPTY_VALUE_PLACEHOLDER__'), 'Test 4: Should not contain placeholder');

    // Test 5: Multiple empty values with comments
    const test5Input = `first:
  # Comment for first
second:
  # Comment for second
third: actualValue`;

    const test5Result = formatYaml(test5Input);
    assert.strictEqual(test5Result.error, undefined, 'Test 5 should not have errors');
    assert(test5Result.text.includes('first:\n  # Comment for first'), 'Test 5: First comment preserved');
    assert(test5Result.text.includes('second:\n  # Comment for second'), 'Test 5: Second comment preserved');
    assert(!test5Result.text.includes('__EMPTY_VALUE_PLACEHOLDER__'), 'Test 5: No placeholders in output');

    // Test 6: Empty value with multiple comments
    const test6Input = `default:
  # First comment
  # Second comment
  # Third comment
next: value`;

    const test6Result = formatYaml(test6Input);
    assert.strictEqual(test6Result.error, undefined, 'Test 6 should not have errors');
    assert(test6Result.text.includes('# First comment'), 'Test 6: First comment preserved');
    assert(test6Result.text.includes('# Second comment'), 'Test 6: Second comment preserved');
    assert(test6Result.text.includes('# Third comment'), 'Test 6: Third comment preserved');

    // Test 7: Nested empty value
    const test7Input = `parent:
  child:
    # Nested comment
  sibling: value`;

    const test7Result = formatYaml(test7Input);
    assert.strictEqual(test7Result.error, undefined, 'Test 7 should not have errors');
    assert(test7Result.text.includes('child:\n'), 'Test 7: Nested empty value preserved');
    assert(test7Result.text.includes('# Nested comment'), 'Test 7: Nested comment preserved');

    // Test 8: Empty value at end of file
    const test8Input = `someKey: value
empty:
  # Comment at end`;

    const test8Result = formatYaml(test8Input);
    assert.strictEqual(test8Result.error, undefined, 'Test 8 should not have errors');
    assert(
        test8Result.text.includes('empty:') && test8Result.text.includes('# Comment at end'),
        'Test 8: End comment preserved',
    );

    // Test 9: Empty value with blank lines
    const test9Input = `default:

  # Comment after blank

next: value`;

    const test9Result = formatYaml(test9Input);
    assert.strictEqual(test9Result.error, undefined, 'Test 9 should not have errors');
    assert(test9Result.text.includes('default:\n'), 'Test 9: Empty value preserved');

    // Test 10: List item should NOT be treated as empty value
    const test10Input = `items:
  - name: first
  - name: second`;

    const test10Result = formatYaml(test10Input);
    assert.strictEqual(test10Result.error, undefined, 'Test 10 should not have errors');
    assert(test10Result.text.includes('items:\n'), 'Test 10: List preserved');
    assert(!test10Result.text.includes('__EMPTY_VALUE_PLACEHOLDER__'), 'Test 10: No placeholders for lists');

    // Test 11: Complex idempotency test
    const test11Input = `parameters:
  - name: environment
    type: string
    default:
      # Default environment

stages:
  - stage: Build`;

    const test11Result1 = formatYaml(test11Input);
    const test11Result2 = formatYaml(test11Result1.text);
    const test11Result3 = formatYaml(test11Result2.text);
    assert.strictEqual(test11Result1.text, test11Result2.text, 'Test 11: First format should match second');
    assert.strictEqual(test11Result2.text, test11Result3.text, 'Test 11: Second format should match third');

    // Test 12: Regex pattern optimization - keys with special characters
    const test12Input = `my-key-with-dashes:
  # Comment
my_key_with_underscores:
  # Another comment
my.key.with.dots:
  # Yet another comment
next: value`;

    const test12Result = formatYaml(test12Input);
    assert.strictEqual(test12Result.error, undefined, 'Test 12 should not have errors');
    assert(test12Result.text.includes('my-key-with-dashes:\n  # Comment'), 'Test 12: Dashed key preserved');
    assert(
        test12Result.text.includes('my_key_with_underscores:\n  # Another comment'),
        'Test 12: Underscored key preserved',
    );
    assert(test12Result.text.includes('my.key.with.dots:\n  # Yet another comment'), 'Test 12: Dotted key preserved');

    // Test 13: Key with value should not be affected
    const test13Input = `key: value
  # This comment is after the value`;

    const test13Result = formatYaml(test13Input);
    assert.strictEqual(test13Result.error, undefined, 'Test 13 should not have errors');
    assert(!test13Result.text.includes('__EMPTY_VALUE_PLACEHOLDER__'), 'Test 13: Keys with values not affected');

    // Test 14: Mixed indentation levels
    const test14Input = `root:
  level1:
    # Level 1 comment
  level1b:
    level2:
      # Level 2 comment
    level2b: value`;

    const test14Result = formatYaml(test14Input);
    assert.strictEqual(test14Result.error, undefined, 'Test 14 should not have errors');
    assert(test14Result.text.includes('level1:\n'), 'Test 14: Level 1 preserved');
    assert(test14Result.text.includes('level2:\n'), 'Test 14: Level 2 preserved');

    // Test 15: Performance test - should handle large files efficiently
    let largeInput = 'parameters:\n';
    for (let i = 0; i < 100; i++) {
        largeInput += `  param${i}:\n    # Comment ${i}\n`;
    }
    largeInput += 'stages:\n  - stage: Build';

    const startTime = Date.now();
    const test15Result = formatYaml(largeInput);
    const endTime = Date.now();
    assert.strictEqual(test15Result.error, undefined, 'Test 15 should not have errors');
    assert(endTime - startTime < 1000, `Test 15: Should complete in under 1 second (took ${endTime - startTime}ms)`);

    console.log('✅ PASS Empty value optimization tests');
    return true;
}

function testIdempotency() {
    console.log('Testing idempotency...');

    const testCases = [
        {
            name: 'Empty values with comments',
            input: `default:
  # Nexus comment
repository:
  # Repository comment
stages:
  - stage: Build`,
        },
        {
            name: 'Complex pipeline',
            input: `parameters:
  - name: env
    default:
      # Default env

stages:
  - stage: Deploy
    jobs:
      - job: Deploy
        steps:
          - task: Deploy@1
            inputs:
              target:
                # Target comment`,
        },
        {
            name: 'Nested empty values',
            input: `level1:
  level2:
    level3:
      # Deep comment
    level3b: value
  level2b:
    # Another comment`,
        },
    ];

    testCases.forEach((testCase, index) => {
        const result1 = formatYaml(testCase.input);
        assert.strictEqual(
            result1.error,
            undefined,
            `Idempotency test ${index + 1} (${testCase.name}): First format should not error`,
        );

        const result2 = formatYaml(result1.text);
        assert.strictEqual(
            result2.error,
            undefined,
            `Idempotency test ${index + 1} (${testCase.name}): Second format should not error`,
        );

        const result3 = formatYaml(result2.text);
        assert.strictEqual(
            result3.error,
            undefined,
            `Idempotency test ${index + 1} (${testCase.name}): Third format should not error`,
        );

        // Check that all results are identical
        assert.strictEqual(
            result1.text,
            result2.text,
            `Idempotency test ${index + 1} (${testCase.name}): First and second format should match`,
        );
        assert.strictEqual(
            result2.text,
            result3.text,
            `Idempotency test ${index + 1} (${testCase.name}): Second and third format should match`,
        );

        // Verify no placeholders remain
        assert(
            !result1.text.includes('__EMPTY_VALUE_PLACEHOLDER__'),
            `Idempotency test ${index + 1} (${testCase.name}): No placeholders should remain in output`,
        );
        assert(
            !result1.text.includes('__COMMENT_'),
            `Idempotency test ${index + 1} (${testCase.name}): No comment IDs should remain in output`,
        );
    });

    console.log('✅ PASS Idempotency tests');
    return true;
}

function testEdgeCases() {
    console.log('Testing edge cases...');

    // Test 1: Empty input
    const test1Result = formatYaml('');
    assert.strictEqual(test1Result.text, '', 'Edge case 1: Empty input should return empty');

    // Test 2: Only comments
    const test2Input = `# Just a comment
# Another comment`;
    const test2Result = formatYaml(test2Input);
    assert.strictEqual(test2Result.error, undefined, 'Edge case 2 should not error');

    // Test 3: Key with colon in value
    const test3Input = `url: "http://example.com"`;
    const test3Result = formatYaml(test3Input);
    assert.strictEqual(test3Result.error, undefined, 'Edge case 3 should not error');
    assert(test3Result.text.includes('http://example.com'), 'Edge case 3: URL should be preserved');

    // Test 4: Empty value followed immediately by next key (no comment)
    const test4Input = `empty:
next: value`;
    const test4Result = formatYaml(test4Input);
    assert.strictEqual(test4Result.error, undefined, 'Edge case 4 should not error');
    assert(test4Result.text.includes('empty:\n'), 'Edge case 4: Empty value preserved');

    // Test 5: Trailing whitespace after colon
    const test5Input = `key:   
next: value`;
    const test5Result = formatYaml(test5Input);
    assert.strictEqual(test5Result.error, undefined, 'Edge case 5 should not error');

    // Test 6: Comment at same level as key (not indented more)
    const test6Input = `key:
# Same level comment
next: value`;
    const test6Result = formatYaml(test6Input);
    assert.strictEqual(test6Result.error, undefined, 'Edge case 6 should not error');

    // Test 7: Very long key name
    const test7Input = `thisIsAVeryLongKeyNameWithManyCharactersThatShouldStillBeHandledCorrectly:
  # Comment
next: value`;
    const test7Result = formatYaml(test7Input);
    assert.strictEqual(test7Result.error, undefined, 'Edge case 7 should not error');

    // Test 8: Unicode characters in comments
    const test8Input = `key:
  # 这是中文注释 🚀
next: value`;
    const test8Result = formatYaml(test8Input);
    assert.strictEqual(test8Result.error, undefined, 'Edge case 8 should not error');
    assert(test8Result.text.includes('这是中文注释 🚀'), 'Edge case 8: Unicode preserved');

    console.log('✅ PASS Edge case tests');
    return true;
}

// Run all tests
try {
    testEmptyValueOptimization();
    testIdempotency();
    testEdgeCases();
    console.log('\n✅ PASS Empty value optimization test suite\n');
} catch (error) {
    console.error('\n❌ FAIL Empty value optimization test suite');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
}
