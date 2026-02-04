#!/usr/bin/env node

const { formatYaml } = require('../formatter.js');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Testing multiline sibling spacing and control structures\n');

// Read test cases from YAML file
const testFile = path.join(__dirname, 'inputs', 'multiline-sibling-spacing.yaml');
const testContent = fs.readFileSync(testFile, 'utf8').replace(/\r\n/g, '\n');
const testCases = testContent.split('\n---\n').map((tc) => tc.trim());

// Test 1: Sibling templates inside conditionals (original bug)
const test1Expected = `steps:
- \${{ if parameters.enableMsixSigning }}:
  - template: /steps/template-one.yaml
    parameters:
      param1: value1

  - template: /steps/template-two.yaml
    parameters:
      param2: value2

  - template: /steps/template-three.yaml
    parameters:
      param3: value3

- bash: echo "After conditional block"`;
const test1Result = formatYaml(testCases[0], { stepSpacing: true });
assert.strictEqual(
    test1Result.text.trimEnd(),
    test1Expected,
    'Test 1 failed: Should add blank lines between sibling templates inside conditionals'
);
console.log('  ✅ Test 1 passed: Sibling templates inside conditionals have blank lines');

// Test 2: Bash with multiline script followed by control structure (the key fix)
const test2Expected = `steps:
- \${{ if parameters.publishArtifacts }}:
  - bash: |
      echo "Publishing artifacts"
      zip_dir="$(pwd)/artifacts"
      mkdir -p "\${zip_dir}"
      cp *.zip "\${zip_dir}/"
    displayName: Stage Artifacts

  - \${{ each connection in split(parameters.connections, ',') }}:
    - \${{ if ne(trim(connection), '') }}:
      - task: PublishTask@0
        inputs:
          connection: \${{ connection }}

- bash: echo "Final step"`;
const test2Result = formatYaml(testCases[1], { stepSpacing: true });
assert.strictEqual(
    test2Result.text.trimEnd(),
    test2Expected,
    'Test 2 failed: Should add blank line after bash multiline block before control structure'
);
console.log('  ✅ Test 2 passed: Bash multiline followed by control structure has blank line');

// Test 3: Control structures (if/elseif/each) as siblings
const test3Expected = `steps:
- task: Setup@1
  displayName: Setup

- \${{ if eq(parameters.option, 'A') }}:
  - bash: echo "Option A"

- \${{ elseif eq(parameters.option, 'B') }}:
  - bash: echo "Option B"

- \${{ each config in parameters.configurations }}:
  - task: Process@1
    inputs:
      config: \${{ config }}

- bash: echo "Cleanup"`;
const test3Result = formatYaml(testCases[2], { stepSpacing: true });
assert.strictEqual(
    test3Result.text.trimEnd(),
    test3Expected,
    'Test 3 failed: Should add blank lines before all control structures'
);
console.log('  ✅ Test 3 passed: Control structures (if/elseif/each) have blank lines as siblings');

// Test 4: Nested parent-child conditionals should NOT have blanks between them
const test4Expected = `stages:
- \${{ if eq(parameters.enableBuild, true) }}:
  - \${{ if eq(parameters.enableTests, true) }}:
    - stage: BuildAndTest
      jobs:
      - job: Test

- \${{ if eq(parameters.enableDeploy, true) }}:
  - \${{ if eq(parameters.environment, 'prod') }}:
    - stage: ProdDeploy

- stage: AlwaysRun`;
const test4Result = formatYaml(testCases[3], { stepSpacing: true });
assert.strictEqual(
    test4Result.text.trimEnd(),
    test4Expected,
    'Test 4 failed: Parent-child conditionals should NOT have blanks between them'
);
console.log('  ✅ Test 4 passed: Nested parent-child conditionals do NOT have blanks between them');

// Test 5: Nested mappings (parameters, variables) should NOT have blanks
const test5Expected = `parameters:
- name: param1
  type: string
  default: value1
- name: param2
  type: string
  default: value2
- name: param3
  type: string
  default: value3
variables:
- name: var1
  value: val1
- name: var2
  value: val2
- name: var3
  value: val3`;
const test5Result = formatYaml(testCases[4], { stepSpacing: true });
assert.strictEqual(
    test5Result.text.trimEnd(),
    test5Expected,
    'Test 5 failed: Nested mappings should NOT have blanks between items'
);
console.log('  ✅ Test 5 passed: Nested mappings (parameters, variables) do NOT have blanks');

// Test 6: Regular step siblings
const test6Expected = `steps:
- task: NodeTool@0
  inputs:
    versionSpec: '18.x'

- bash: npm install

- bash: npm test`;
const test6Result = formatYaml(testCases[5], { stepSpacing: true });
assert.strictEqual(
    test6Result.text.trimEnd(),
    test6Expected,
    'Test 6 failed: Should add blank lines between regular steps'
);
console.log('  ✅ Test 6 passed: Regular step siblings have blank lines');

// Test 7: Multiline bash followed by regular step
const test7Expected = `steps:
- bash: |
    echo "Multi-line"
    echo "script"
  displayName: Run Script

- bash: echo "Next step"`;
const test7Result = formatYaml(testCases[6], { stepSpacing: true });
assert.strictEqual(
    test7Result.text.trimEnd(),
    test7Expected,
    'Test 7 failed: Should add blank line after multiline bash'
);
console.log('  ✅ Test 7 passed: Multiline bash followed by regular step has blank line');

// Test 8: Elseif control structure as sibling
const test8Expected = `steps:
- task: Setup@1

- \${{ if eq(parameters.mode, 'build') }}:
  - bash: echo "Building"

- \${{ elseif eq(parameters.mode, 'test') }}:
  - bash: echo "Testing"

- bash: echo "Done"`;
const test8Result = formatYaml(testCases[7], { stepSpacing: true });
assert.strictEqual(test8Result.text.trimEnd(), test8Expected, 'Test 8 failed: Should add blank line before elseif');
console.log('  ✅ Test 8 passed: Elseif control structure has blank line as sibling');

console.log('\n🎉 All multiline sibling spacing tests passed!');
