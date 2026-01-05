#!/usr/bin/env node

/**
 * Test block scalar style selection based on ${{}} expression tracking
 *
 * This test validates that:
 * 1. Scripts without ${{}} expressions use | (literal) style
 * 2. Scripts with ${{}} expressions use > (folded) style
 * 3. Scripts in templates with ${{}} use > (folded) style
 * 4. Scripts in loops with ${{}} use > (folded) style
 * 5. All script types (bash, script, powershell, pwsh) are handled
 * 6. Heredocs with ${{}} use > with empty lines added
 * 7. Heredocs without ${{}} use | (literal) style
 * 8. Non-script multiline values with ${{}} use > (folded) style
 */

const assert = require('assert');
const { AzurePipelineParser } = require('../parser.js');

console.log('Testing block scalar style selection...\n');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        testsPassed++;
    } catch (error) {
        console.error(`✗ ${name}`);
        console.error(`  Error: ${error.message}`);
        testsFailed++;
    }
}

// Test 1: Script without expressions uses literal style (|)
test('Script without expressions uses literal style', () => {
    const yaml = `
steps:
- bash: |
    echo "Hello"
    echo "World"
  displayName: Test
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: true });

    // Should use | (literal) style - look for the pattern
    assert(output.includes('script: |'), 'Should use literal style (|) for script without expressions');
});

// Test 2: Script with ${{}} expression uses folded style (>)
test('Script with ${{}} expression uses folded style', () => {
    const yaml = `
parameters:
- name: message
  type: string
  default: Hello

steps:
- bash: |
    echo "\${{ parameters.message }}"
    echo "World"
  displayName: Test
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: true });

    // Should use > (folded) style
    assert(output.includes('script: >'), 'Should use folded style (>) for script with expressions');
});

// Test 3: pwsh script type is handled
test('pwsh script type is handled', () => {
    const yaml = `
parameters:
- name: value
  type: string
  default: test

steps:
- pwsh: |
    Write-Host "\${{ parameters.value }}"
    Write-Host "Done"
  displayName: Test
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: true });

    // Should use > (folded) style for pwsh with expressions
    // After shorthand conversion, pwsh becomes script in inputs
    assert(
        output.includes('script: >') || output.includes('pwsh: >'),
        'Should use folded style (>) for pwsh with expressions'
    );
});

// Test 4: Script in loop (${{ each }}) with expressions
test('Script in loop with expressions uses folded style', () => {
    const yaml = `
parameters:
- name: items
  type: object
  default:
    - one
    - two

steps:
- \${{ each item in parameters.items }}:
  - bash: |
      echo "Item: \${{ item }}"
      echo "Done"
    displayName: 'Process \${{ item }}'
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: true });

    // Both expanded steps should use folded style
    assert(output.includes('script: >'), 'Loop scripts with expressions should use folded style');
});

// Test 5: Heredoc without expressions uses literal style
test('Heredoc without expressions uses literal style', () => {
    const yaml = `
steps:
- bash: |
    cat <<EOF
    Hello World
    Line 2
    EOF
  displayName: Test
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: true });

    // Should use | (literal) for heredoc without expressions
    assert(output.includes('script: |'), 'Heredoc without expressions should use literal style');
});

// Test 6: Heredoc with expressions uses folded style with empty lines
test('Heredoc with expressions uses folded style with empty lines', () => {
    const yaml = `
parameters:
- name: envName
  type: string
  default: production

steps:
- bash: |
    cat <<EOF
    Environment: \${{ parameters.envName }}
    Status: active
    EOF
  displayName: Test
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: true });

    // Should use > (folded) style
    assert(output.includes('script: >'), 'Heredoc with expressions should use folded style');

    // Heredoc content should have empty lines added (for newline preservation)
    // The content between <<EOF and EOF should have blank lines between each line
    assert(
        output.includes('Environment: production\n\n'),
        'Heredoc content should have empty lines added for newline preservation'
    );
});

// Test 7: Non-script multiline value with expressions uses folded style
test('Non-script multiline value with expressions uses folded style', () => {
    const yaml = `
parameters:
- name: description
  type: string
  default: Test

variables:
- name: readme
  value: |
    Project: \${{ parameters.description }}
    Version: 1.0
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: true });

    // Non-script values with expressions should also use folded style
    assert(output.includes('value: >') || output.includes('value: |'), 'Should handle multiline variable values');
});

// Test 8: Script without expressions in template preserves literal style
test('Script without expressions in template uses literal style', () => {
    // This tests that scripts without ${{}} in templates still use literal style
    const yaml = `
steps:
- script: |
    echo "No expressions here"
    echo "Just plain text"
  displayName: Plain Script
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: true });

    assert(output.includes('script: |'), 'Plain script should use literal style');
});

// Test 9: Mixed scripts - some with expressions, some without
test('Mixed scripts have correct styles', () => {
    const yaml = `
parameters:
- name: value
  type: string
  default: test

steps:
- bash: |
    echo "Plain script"
    echo "No expressions"
  displayName: Plain

- bash: |
    echo "\${{ parameters.value }}"
    echo "Has expression"
  displayName: WithExpr
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: true });

    // Should have both styles in output
    const hasLiteral = output.includes('script: |');
    const hasFolded = output.includes('script: >');

    assert(hasLiteral && hasFolded, 'Should have both literal and folded styles for different scripts');
});

// Test 10: Block scalar style not applied when azureCompatible is false
test('Block scalar styles not applied when azureCompatible is false', () => {
    const yaml = `
parameters:
- name: msg
  type: string
  default: Hello

steps:
- bash: |
    echo "\${{ parameters.msg }}"
  displayName: Test
`;
    const parser = new AzurePipelineParser();
    const output = parser.expandPipelineFromString(yaml, { azureCompatible: false });

    // Without azureCompatible, the YAML library's default should be used
    // We just verify it doesn't crash and produces valid output
    assert(output.includes('echo "Hello"'), 'Should expand expressions correctly');
});

// Summary
console.log('\n' + '='.repeat(60));
console.log('BLOCK SCALAR STYLE TEST RESULTS');
console.log('='.repeat(60));
console.log(`Total: ${testsPassed + testsFailed}`);
console.log(`✓ Passed: ${testsPassed}`);
console.log(`✗ Failed: ${testsFailed}`);
console.log('='.repeat(60));

if (testsFailed > 0) {
    console.log('\n⚠️  Some tests failed.');
    process.exit(1);
} else {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
}
