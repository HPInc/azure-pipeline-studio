#!/usr/bin/env node

/**
 * Test quote preservation through template expansion
 *
 * This test validates that:
 * 1. Single quotes are preserved when present in source
 * 2. Double quotes are preserved when present in source
 * 3. Empty strings preserve their quote style (prefer single)
 * 4. Quotes in bash script literals are preserved
 * 5. No unwanted quotes are added to unquoted values
 * 6. Boolean marker quotes are preserved in Microsoft compatibility mode
 */

const assert = require('assert');
const { AzurePipelineParser } = require('../parser.js');

console.log('Testing quote preservation...');

// Test 1: Single quotes preserved for patterns
const test1Yaml = `
parameters:
- name: pattern
  type: string
  default: '**/test.dll'

steps:
- bash: echo
  env:
    PATTERN: '\${{ parameters.pattern }}'
`;

const parser1 = new AzurePipelineParser();
const formatted1 = parser1.expandPipelineToString(test1Yaml, {});

assert(formatted1.includes("PATTERN: '**/test.dll'"), 'Test 1 Failed: Single quotes should be preserved for patterns');
console.log('✓ Test 1 passed: Single quotes preserved for patterns');

// Test 2: Empty strings prefer single quotes
const test2Yaml = `
parameters:
- name: emptyValue
  type: string
  default: ''

steps:
- bash: echo
  env:
    EMPTY: '\${{ parameters.emptyValue }}'
`;

const parser2 = new AzurePipelineParser();
const formatted2 = parser2.expandPipelineToString(test2Yaml, {});

assert(formatted2.includes("EMPTY: ''"), 'Test 2 Failed: Empty strings should preserve single quotes');
console.log('✓ Test 2 passed: Empty strings preserve single quotes');

// Test 3: No quotes added to unquoted values
const test3Yaml = `
steps:
- bash: echo
  inputs:
    targetType: inline
`;

const parser3 = new AzurePipelineParser();
const formatted3 = parser3.expandPipelineToString(test3Yaml, {});

assert(formatted3.includes('targetType: inline'), 'Test 3 Failed: Should not add quotes to simple unquoted values');
assert(!formatted3.includes("targetType: 'inline'") && !formatted3.includes('targetType: "inline"'), 'Test 3 Failed: Should not add quotes to simple unquoted values');
console.log('✓ Test 3 passed: No unwanted quotes added to simple values');

// Test 4: Quotes in bash script literals preserved with Microsoft compatibility
const test4Yaml = `
parameters:
- name: enabled
  type: boolean
  default: true

steps:
- bash: |
    var="\${{ parameters.enabled }}"
  displayName: Test
`;

const parser4 = new AzurePipelineParser();
const formatted4 = parser4.expandPipelineToString(test4Yaml);

assert(formatted4.includes('var="True"'), 'Test 4 Failed: Quotes should be preserved around boolean in bash script with Microsoft compatibility');
console.log('✓ Test 4 passed: Bash script literal quotes preserved with capitalized boolean');

// Test 5: Quotes preserved when source has quotes, not added when source doesn't
const test5Yaml = `
parameters:
- name: value
  type: string
  default: test-value

steps:
- bash: echo
  env:
    WITH_QUOTES: '\${{ parameters.value }}'
    WITHOUT_QUOTES: \${{ parameters.value }}
`;

const parser5 = new AzurePipelineParser();
const formatted5 = parser5.expandPipelineToString(test5Yaml, {});

assert(formatted5.includes("WITH_QUOTES: 'test-value'"), 'Test 5 Failed: Should preserve quotes when present in source');
assert(formatted5.includes('WITHOUT_QUOTES: test-value'), 'Test 5 Failed: Should not add quotes when not present in source');
console.log('✓ Test 5 passed: Quotes only preserved when present in source');

// Test 6: Boolean values in quoted strings (Microsoft compatibility)
const test6Yaml = `
parameters:
- name: flag
  type: boolean
  default: false

steps:
- bash: echo
  env:
    QUOTED_BOOL: '\${{ parameters.flag }}'
`;

const parser6 = new AzurePipelineParser();
const formatted6 = parser6.expandPipelineToString(test6Yaml);

assert(formatted6.includes("QUOTED_BOOL: 'False'"), 'Test 6 Failed: Should preserve quotes around False with Microsoft compatibility');
console.log('✓ Test 6 passed: Boolean quotes preserved in Microsoft compatibility mode');

// Test 7: Values with hyphens/dots don't get unwanted quotes
const test7Yaml = `
parameters:
- name: poolName
  type: string
  default: codeway-aws-linux
- name: arch
  type: string
  default: x64
- name: version
  type: string
  default: 1.2.3

steps:
- bash: echo
  env:
    POOL: \${{ parameters.poolName }}
    ARCH: \${{ parameters.arch }}
    VERSION: \${{ parameters.version }}
`;

const parser7 = new AzurePipelineParser();
const formatted7 = parser7.expandPipelineToString(test7Yaml, {});

assert(formatted7.includes('POOL: codeway-aws-linux') && !formatted7.includes("POOL: 'codeway-aws-linux'"), 'Test 7 Failed: Should not add quotes to values with hyphens when not in source');
assert(formatted7.includes('VERSION: 1.2.3') && !formatted7.includes("VERSION: '1.2.3'"), 'Test 7 Failed: Should not add quotes to version numbers when not in source');
console.log('✓ Test 7 passed: No unwanted quotes on values with hyphens/dots');

console.log('\n✅ All quote preservation tests passed!');

// Test 8: Context-aware quote preservation (displayName priority)
// Same key+value (scriptSource: inline) from different templates with different displayNames
// One template has quoted, one has unquoted - both should be preserved correctly
const test8Yaml = `
parameters:
- name: message1
  type: string
  default: 'Hello'
- name: message2
  type: string
  default: 'World'

steps:
# First task: has scriptSource: 'inline' (quoted in template)
- task: PythonScript@0
  displayName: Comment on Pull Request
  inputs:
    scriptSource: 'inline'
    script: |
      print('\${{ parameters.message1 }}')
# Second task: has scriptSource: inline (unquoted in template)
- task: PythonScript@0
  displayName: Post PR Comment or Trunk
  inputs:
    scriptSource: inline
    script: |
      print('\${{ parameters.message2 }}')
`;

const parser8 = new AzurePipelineParser();
const formatted8 = parser8.expandPipelineToString(test8Yaml, {});

// Both scriptSource values should preserve their original quoting
const lines8 = formatted8.split('\n');
const scriptSourceLines = lines8.filter((line) => line.includes('scriptSource:'));

assert(scriptSourceLines.length === 2, 'Test 8 Failed: Should have 2 scriptSource lines');
assert(scriptSourceLines[0].includes("scriptSource: 'inline'"), 'Test 8 Failed: First scriptSource should be quoted');
assert(scriptSourceLines[1].includes('scriptSource: inline') && !scriptSourceLines[1].includes("'inline'"), 'Test 8 Failed: Second scriptSource should NOT be quoted');
console.log('✓ Test 8 passed: Context-aware quote preservation with different displayNames');

// Test 9: Same task type but different displayNames - quote style preserved per context
const test9Yaml = `
steps:
- task: Bash@3
  displayName: Build App
  inputs:
    targetType: 'inline'
    script: echo build
- task: Bash@3
  displayName: Test App
  inputs:
    targetType: inline
    script: echo test
`;

const parser9 = new AzurePipelineParser();
const formatted9 = parser9.expandPipelineToString(test9Yaml, {});

// First should have quoted, second should be unquoted
assert(formatted9.includes('displayName: Build App') || formatted9.includes('displayName: "Build App"'), 'Test 9 Failed: Should have Build App displayName');
assert(formatted9.includes('displayName: Test App'), 'Test 9 Failed: Should have Test App displayName');

const targetTypeMatches = formatted9.match(/targetType:.*$/gm);
assert(targetTypeMatches && targetTypeMatches.length === 2, 'Test 9 Failed: Should have 2 targetType lines');
assert(targetTypeMatches[0].includes("'inline'"), 'Test 9 Failed: First targetType should be quoted');
assert(!targetTypeMatches[1].includes("'"), 'Test 9 Failed: Second targetType should NOT be quoted');
console.log('✓ Test 9 passed: Same task type with different displayNames preserves quote style');

// Test 10: displayName priority over task name for context
const test10Yaml = `
steps:
- task: SameTask@1
  displayName: Alpha
  inputs:
    mode: 'fast'
- task: SameTask@1
  displayName: Beta
  inputs:
    mode: slow
`;

const parser10 = new AzurePipelineParser();
const formatted10 = parser10.expandPipelineToString(test10Yaml, {});

const modeMatches = formatted10.match(/mode:.*$/gm);
assert(modeMatches && modeMatches.length === 2, 'Test 10 Failed: Should have 2 mode lines');
assert(modeMatches[0].includes("'fast'"), 'Test 10 Failed: First mode should be quoted');
assert(!modeMatches[1].includes("'"), 'Test 10 Failed: Second mode should NOT be quoted');
console.log('✓ Test 10 passed: displayName priority over task name for context');

console.log('\n✅ All context-aware quote preservation tests passed!');
