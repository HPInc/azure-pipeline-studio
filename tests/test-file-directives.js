const { formatYaml } = require('../extension');
const assert = require('assert');

console.log('Running File Directive Tests...\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✅ PASS: ${name}`);
        passed++;
    } catch (error) {
        console.log(`❌ FAIL: ${name}`);
        console.log(`   ${error.message}`);
        failed++;
    }
}

// Test 1: Disable formatting with =false
test('Disable formatting with # aps-format=false', () => {
    const input = `# aps-format=false
parameters:
- name:    test
  default:   value
stages:
- stage:  Build`;

    const result = formatYaml(input);

    // Should return original unformatted content
    assert(result.text === input, 'Content should be unchanged');
    assert(result.text.includes('name:    test'), 'Extra spaces should be preserved');
});

// Test 2: Disable formatting with : false
test('Disable formatting with # aps-format: false', () => {
    const input = `# aps-format: false
parameters:
- name:    test`;

    const result = formatYaml(input);
    assert(result.text === input, 'Content should be unchanged');
});

// Test 3: Custom lineWidth directive
test('Custom lineWidth via directive', () => {
    const input = `# aps-format lineWidth=120
parameters:
  - name: test
    default: value`;

    const result = formatYaml(input);

    // Should format but with custom lineWidth
    assert(result.text.includes('parameters:'), 'Should format the content');
    assert(!result.error, 'Shouldnothaveerrors');
});

// Test 4: Multiple options in directive
test('Multiple options in directive', () => {
    const input = `# aps-format indent=4,lineWidth=100,forceQuotes=true
parameters:
  - name: test
    default: value`;

    const result = formatYaml(input);

    assert(result.text.includes('parameters:'), 'Should format the content');
    assert(!result.error, 'Shouldnothaveerrors');
});

// Test 5: Newline format directive
test('Newline format directive', () => {
    const input = `# aps-format newline=\\r\\n
parameters:
  - name: test`;

    const result = formatYaml(input);

    // Should use CRLF line endings
    assert(result.text.includes('\r\n'), 'Should have CRLF line endings');
});

// Test 6: Directive not in first 5 lines is ignored
test('Directive after 5 lines is ignored', () => {
    const input = `parameters:
  - name: test
    default: value

# Some comment
# Another comment
# aps-format=false
stages:
  - stage:   Build`;

    const result = formatYaml(input);

    // Should format normally (directive is too far down)
    assert(result.text !== input, 'Should format the content');
    assert(!result.text.includes('stage:Build'), 'Extraspacesshouldberemoved');
});

// Test 7: Preserve original with no directive
test('No directive - normal formatting', () => {
    const input = `parameters:
  - name:    test
    default:   value`;

    const result = formatYaml(input);

    // Should format normally
    assert(result.text !== input, 'Should format the content');
    assert(!result.text.includes('name:test'), 'Extraspacesshouldberemoved');
});

// Test 8: Boolean options in directive
test('Boolean options in directive', () => {
    const input = `# aps-format forceQuotes=true,sortKeys=true
parameters:
  b: second
  a: first`;

    const result = formatYaml(input);

    assert(result.text.includes('parameters:'), 'Should format the content');
    assert(!result.error, 'Shouldnothaveerrors');
});

// Test 9: Directive with comment before it
test('Directive after initial comment', () => {
    const input = `# This is my pipeline
# aps-format=false
parameters:
  - name:    test`;

    const result = formatYaml(input);

    // Should not format
    assert(result.text === input, 'Content should be unchanged');
    assert(result.text.includes('name:    test'), 'Extra spaces should be preserved');
});

// Test 10: Invalid directive is ignored
test('Invalid directive is ignored', () => {
    const input = `# aps-format invalidOption=xyz
parameters:
  - name:    test`;

    const result = formatYaml(input);

    // Should format normally
    assert(!result.error, 'Shouldnothaveerrors');
    assert(result.text.includes('parameters:'), 'Should format the content');
});

console.log('\n' + '='.repeat(50));
console.log('File Directive Test Results');
console.log('='.repeat(50));
console.log(`Total Tests: ${passed + failed}`);
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`📊 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);

if (failed === 0) {
    console.log('\n🎉 ALL FILE DIRECTIVE TESTS PASSED!');
} else {
    console.log(`\n❌ ${failed} test(s) failed`);
    process.exit(1);
}
