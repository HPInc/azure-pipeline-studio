#!/usr/bin/env node
/**
 * Test cases for bash/script/pwsh/checkout shorthand conversion to task format
 */

const assert = require('assert');
const { AzurePipelineParser } = require('../extension.js');

const parser = new AzurePipelineParser();
parser.printTree = false;

let passCount = 0;
let failCount = 0;

function test(name, yamlContent, expectedChecks) {
    try {
        const { document } = parser.expandPipeline(yamlContent, { fileName: 'test-file.yaml' });

        // Check if document was parsed
        if (!document) {
            throw new Error('Failed to parse YAML document');
        }

        // Run expected checks
        expectedChecks(document);

        passCount++;
        console.log(`✅ PASS ${name}`);
    } catch (err) {
        failCount++;
        console.log(`❌ FAIL ${name} - ${err.message}`);
    }
}

// Test 1: Script shorthand conversion
test(
    'script shorthand to CmdLine@2',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
      - script: echo "Hello World"
        displayName: 'Test Script'
`,
    (result) => {
        const job = result.jobs[0];
        const step = job.steps[1]; // Second step after checkout
        assert.strictEqual(step.task, 'CmdLine@2', 'Task type should be CmdLine@2');
        assert.strictEqual(step.displayName, 'Test Script', 'Display name should be preserved');
        assert.ok(step.inputs, 'Should have inputs object');
        // targetType: inline is not included (it's the default)
        assert.strictEqual(step.inputs.script, 'echo "Hello World"', 'Script should be in inputs.script');
    },
);

// Test 2: Bash shorthand conversion
test(
    'bash shorthand to Bash@3',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
      - bash: npm install
        displayName: 'Install packages'
        workingDirectory: '$(Build.SourcesDirectory)'
`,
    (result) => {
        const step = result.jobs[0].steps[1]; // Second step after checkout
        assert.strictEqual(step.task, 'Bash@3', 'Task type should be Bash@3');
        assert.strictEqual(step.displayName, 'Install packages', 'Display name should be preserved');
        assert.ok(step.inputs, 'Should have inputs object');
        assert.strictEqual(
            step.inputs.workingDirectory,
            '$(Build.SourcesDirectory)',
            'workingDirectory should be inside inputs',
        );
        assert.strictEqual(step.inputs.script, 'npm install', 'Script should be in inputs.script');
    },
);

// Test 3: PowerShell shorthand conversion
test(
    'pwsh shorthand to PowerShell@2',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
      - pwsh: Get-Date
        displayName: 'Get current date'
        failOnStderr: true
`,
    (result) => {
        const step = result.jobs[0].steps[1]; // Second step after checkout
        assert.strictEqual(step.task, 'PowerShell@2', 'Task type should be PowerShell@2');
        assert.strictEqual(step.displayName, 'Get current date', 'Display name should be preserved');
        assert.strictEqual(step.failOnStderr, true, 'failOnStderr should be at task level');
        assert.ok(step.inputs, 'Should have inputs object');
        // targetType: inline is not included (it's the default)
        assert.strictEqual(step.inputs.script, 'Get-Date', 'Script should be in inputs.script');
    },
);

// Test 4: Checkout shorthand conversion
test(
    'checkout shorthand to checkout task',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
        fetchDepth: 1
        clean: true
`,
    (result) => {
        const step = result.jobs[0].steps[0];
        assert.strictEqual(
            step.task,
            '6d15af64-176c-496d-b583-fd2ae21d4df4@1',
            'Task type should be checkout task GUID',
        );
        assert.ok(step.inputs, 'Should have inputs object');
        assert.strictEqual(step.inputs.repository, 'self', 'Repository should be in inputs.repository');
        assert.strictEqual(step.inputs.fetchDepth, 1, 'fetchDepth should be in inputs');
        assert.strictEqual(step.inputs.clean, true, 'clean should be in inputs');
    },
);

// Test 5: Checkout with conditional fetchDepth
test(
    'checkout with conditional fetchDepth',
    `
parameters:
  - name: fullFetch
    type: boolean
    default: false

jobs:
  - job: TestJob
    steps:
      - checkout: self
        \${{ if eq(parameters.fullFetch, true) }}:
          fetchDepth: 0
        \${{ else }}:
          fetchDepth: 1
`,
    (result) => {
        const step = result.jobs[0].steps[0];
        assert.strictEqual(
            step.task,
            '6d15af64-176c-496d-b583-fd2ae21d4df4@1',
            'Task type should be checkout task GUID',
        );
        assert.ok(step.inputs, 'Should have inputs object');
        assert.strictEqual(step.inputs.repository, 'self', 'Repository should be in inputs.repository');
        // fetchDepth should be resolved to 1 (because fullFetch defaults to false)
        assert.strictEqual(step.inputs.fetchDepth, 1, 'fetchDepth should resolve to 1');
        assert.ok(!step.inputs[''], 'Should not have empty string keys');
    },
);

// Test 6: Multiple shorthand steps
test(
    'multiple shorthand steps in same job',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
        fetchDepth: 1
      - bash: echo "Building..."
        displayName: 'Build'
      - script: echo "Testing..."
        displayName: 'Test'
      - pwsh: Write-Host "Deploying..."
        displayName: 'Deploy'
`,
    (result) => {
        const steps = result.jobs[0].steps;
        assert.strictEqual(steps.length, 4, 'Should have 4 steps');
        assert.strictEqual(steps[0].task, '6d15af64-176c-496d-b583-fd2ae21d4df4@1', 'First step should be checkout');
        assert.strictEqual(steps[1].task, 'Bash@3', 'Second step should be Bash@3');
        assert.strictEqual(steps[2].task, 'CmdLine@2', 'Third step should be CmdLine@2');
        assert.strictEqual(steps[3].task, 'PowerShell@2', 'Fourth step should be PowerShell@2');
    },
);

// Test 7: Guard condition - already has task property
test(
    'guard: should not convert if already has task property',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
      - task: CmdLine@2
        inputs:
          script: echo "Hello"
          targetType: inline
`,
    (result) => {
        const step = result.jobs[0].steps[1]; // Second step after checkout
        assert.strictEqual(step.task, 'CmdLine@2', 'Task should remain CmdLine@2');
        assert.ok(step.inputs, 'Should have inputs');
        assert.strictEqual(step.inputs.script, 'echo "Hello"', 'Script should be preserved');
        // Ensure no nested inputs
        assert.ok(!step.inputs.inputs, 'Should not have nested inputs');
    },
);

// Test 8: Guard condition - already has inputs property
test(
    'guard: should not convert object with inputs property',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
      - task: MyCustomTask@1
        inputs:
          script: echo "test"
          customParam: value
`,
    (result) => {
        const step = result.jobs[0].steps[1]; // Second step after checkout
        assert.strictEqual(step.task, 'MyCustomTask@1', 'Task should remain MyCustomTask@1');
        assert.ok(step.inputs, 'Should have inputs');
        assert.strictEqual(step.inputs.script, 'echo "test"', 'Script should be preserved in inputs');
        assert.strictEqual(step.inputs.customParam, 'value', 'Custom param should be preserved');
        assert.ok(!step.inputs.inputs, 'Should not have nested inputs');
    },
);

// Test 9: Pool string to object conversion
test(
    'pool string conversion to object',
    `
jobs:
  - job: TestJob
    pool: 'my-agent-pool'
    steps:
      - script: echo "test"
`,
    (result) => {
        const job = result.jobs[0];
        assert.ok(typeof job.pool === 'object', 'Pool should be converted to object');
        assert.strictEqual(job.pool.name, 'my-agent-pool', 'Pool name should be preserved');
    },
);

// Test 10: No default checkout injection (feature removed - checkout must be explicit)
test(
    'no default checkout injection when no checkout present',
    `
jobs:
  - job: TestJob
    steps:
      - script: echo "Building..."
        displayName: 'Build'
`,
    (result) => {
        const steps = result.jobs[0].steps;
        assert.strictEqual(steps.length, 1, 'Should have only 1 step (no auto-injected checkout)');
        assert.strictEqual(steps[0].task, 'CmdLine@2', 'First step should be the script step');
    },
);

// Test 11: Explicit checkout: none is converted to task
test(
    'explicit checkout: none converted to task',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: none
      - script: echo "Building..."
`,
    (result) => {
        const steps = result.jobs[0].steps;
        assert.strictEqual(steps.length, 2, 'Should have exactly 2 steps');
        assert.strictEqual(
            steps[0].task,
            '6d15af64-176c-496d-b583-fd2ae21d4df4@1',
            'First step should be checkout task',
        );
        assert.strictEqual(steps[0].inputs.repository, 'none', 'Checkout should be none');
    },
);

// Test 12: Script with multiline content
test(
    'script with multiline content',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
      - script: |
          echo "Line 1"
          echo "Line 2"
          echo "Line 3"
        displayName: 'Multi-line script'
`,
    (result) => {
        const step = result.jobs[0].steps[1]; // Second step after checkout
        assert.strictEqual(step.task, 'CmdLine@2', 'Task should be CmdLine@2');
        assert.ok(step.inputs.script.includes('Line 1'), 'Should preserve line 1');
        assert.ok(step.inputs.script.includes('Line 2'), 'Should preserve line 2');
        assert.ok(step.inputs.script.includes('Line 3'), 'Should preserve line 3');
    },
);

// Test 13: Number formatting - matches Microsoft's behavior (trailing zeros dropped)
test(
    'number formatting - decimals normalized like Microsoft',
    `
variables:
  count: 42
  version: 17.0
  price: 19.99
  ratio: 3.10
  factor: 1.50

jobs:
  - job: TestJob
    steps:
      - checkout: self
`,
    (result) => {
        // Numbers are normalized - trailing zeros after decimal are dropped (Microsoft behavior)
        assert.strictEqual(result.variables.count, 42, 'Integer should remain unquoted');
        assert.strictEqual(result.variables.version, 17, 'Decimal 17.0 becomes 17 (Microsoft behavior)');
        assert.strictEqual(result.variables.price, 19.99, 'Regular decimal should be correct');
        assert.strictEqual(result.variables.ratio, 3.1, 'Decimal 3.10 becomes 3.1');
        assert.strictEqual(result.variables.factor, 1.5, 'Decimal 1.50 becomes 1.5');

        // Convert to string to verify formatting
        const yamlStr = parser.expandPipelineToString(
            `
variables:
  count: 42
  version: 17.0
  price: 19.99
  ratio: 3.10
  factor: 1.50
`,
            { fileName: 'test.yaml' },
        );

        assert.ok(yamlStr.includes('count: 42'), 'Integer should be unquoted in output');
        assert.ok(yamlStr.includes('version: 17'), 'Decimal 17.0 becomes 17 in output');
        assert.ok(yamlStr.includes('price: 19.99'), 'Regular decimal should remain');
        assert.ok(yamlStr.includes('ratio: 3.1'), 'Decimal 3.10 becomes 3.1 in output');
        assert.ok(yamlStr.includes('factor: 1.5'), 'Decimal 1.50 becomes 1.5 in output');
    },
);

// Test 14: JSON in PowerShell script with numbers
test(
    'JSON in PowerShell with numeric values preserved',
    `
jobs:
  - job: TestJob
    steps:
      - checkout: self
      - pwsh: |
          $json = @"
          {
            "name": "test",
            "version": "17.0",
            "count": 42,
            "config": {
              "timeout": 30,
              "retries": 3,
              "factor": 1.5
            }
          }
          "@
          Write-Host $json
        displayName: 'Test JSON handling'
`,
    (result) => {
        const step = result.jobs[0].steps[1];
        assert.strictEqual(step.task, 'PowerShell@2', 'Should be PowerShell task');

        // Convert to YAML string to check formatting
        const yamlStr = parser.expandPipelineToString(
            `
jobs:
  - job: TestJob
    steps:
      - checkout: self
      - pwsh: |
          $json = @"
          {
            "name": "test",
            "version": "17.0",
            "count": 42,
            "config": {
              "timeout": 30,
              "retries": 3,
              "factor": 1.5
            }
          }
          "@
          Write-Host $json
        displayName: 'Test JSON handling'
`,
            { fileName: 'test.yaml' },
        );

        // JSON numbers should remain as-is in the string content
        assert.ok(
            yamlStr.includes('"count": 42') || yamlStr.includes('"count":42'),
            'JSON number should be preserved in script block',
        );
        assert.ok(
            yamlStr.includes('"timeout": 30') || yamlStr.includes('"timeout":30'),
            'JSON timeout should be preserved',
        );
    },
);

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
