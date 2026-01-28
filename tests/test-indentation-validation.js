#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { AzurePipelineParser } = require('../parser');

console.log('Testing YAML Structure Validation (Steps Indentation)\n');

const parser = new AzurePipelineParser();

// Test case 1: Incorrect indentation (steps too far left)
console.log('=== Test 1: Incorrect steps indentation ===');
const incorrectYaml = `parameters:
  - name: testConfigurations
    type: object
  - name: pool
    type: string

jobs:
- \${{ each cfg in parameters.testConfigurations }}:
  - job: Run_\${{ replace(cfg.agentName, '-', '_') }}
    displayName: 'Run : \${{ cfg.agentName }}'
    workspace:
      clean: all
    pool:
      name: \${{ parameters.pool }}
   steps:
    - script: echo "Test"
`;

try {
    parser.expandPipelineFromString(incorrectYaml, {});
    console.log('❌ FAIL: Expected validation error but got none\n');
} catch (error) {
    if (error.message.includes('steps:') && error.message.includes('indented')) {
        console.log('✅ PASS: Correctly detected indentation error');
        console.log(`   Error message: ${error.message.split('\\n')[0]}\n`);
    } else {
        console.log('❌ FAIL: Got error but wrong message');
        console.log(`   Error: ${error.message}\n`);
    }
}

// Test case 2: Correct indentation
console.log('=== Test 2: Correct steps indentation ===');
const correctYaml = `parameters:
  - name: testConfigurations
    type: object
  - name: pool
    type: string

jobs:
- \${{ each cfg in parameters.testConfigurations }}:
  - job: Run_\${{ replace(cfg.agentName, '-', '_') }}
    displayName: 'Run : \${{ cfg.agentName }}'
    workspace:
      clean: all
    pool:
      name: \${{ parameters.pool }}
    steps:
    - script: echo "Test"
`;

try {
    const output = parser.expandPipelineFromString(correctYaml, {
        parameters: {
            testConfigurations: [{ agentName: 'test-agent-1' }],
            pool: 'TestPool',
        },
    });
    console.log('✅ PASS: No validation error for correct indentation\n');
} catch (error) {
    console.log('❌ FAIL: Unexpected error for correct YAML');
    console.log(`   Error: ${error.message}\n`);
}

// Test case 3: Simple job without each loop
console.log('=== Test 3: Simple job with correct indentation ===');
const simpleJobYaml = `jobs:
- job: TestJob
  displayName: 'Test Job'
  pool:
    name: TestPool
  steps:
  - script: echo "Test"
`;

try {
    const output = parser.expandPipelineFromString(simpleJobYaml, {});
    console.log('✅ PASS: No validation error for simple job\n');
} catch (error) {
    console.log('❌ FAIL: Unexpected error for simple job');
    console.log(`   Error: ${error.message}\n`);
}

// Test case 4: Simple job with incorrect indentation
console.log('=== Test 4: Simple job with incorrect indentation ===');
const simpleJobIncorrectYaml = `jobs:
- job: TestJob
  displayName: 'Test Job'
  pool:
    name: TestPool
 steps:
  - script: echo "Test"
`;

try {
    parser.expandPipelineFromString(simpleJobIncorrectYaml, {});
    console.log('❌ FAIL: Expected validation error but got none\n');
} catch (error) {
    if (error.message.includes('steps:') && error.message.includes('indented')) {
        console.log('✅ PASS: Correctly detected indentation error in simple job');
        console.log(`   Error message: ${error.message.split('\\n')[0]}\n`);
    } else {
        console.log('❌ FAIL: Got error but wrong message');
        console.log(`   Error: ${error.message}\n`);
    }
}

// Test case 5: Implicit step items with incorrect indentation
console.log('=== Test 5: Implicit step items (no steps:) with incorrect indentation ===');
const implicitStepsIncorrectYaml = `jobs:
- \${{ each cfg in parameters.testConfigurations }}:
  - job: Run_\${{ replace(cfg.agentName, '-', '_') }}
    displayName: 'Run : \${{ cfg.agentName }}'
    workspace:
      clean: all
    pool:
      name: \${{ parameters.pool }}
   - script: echo "Test"
     displayName: 'Run test'
`;

try {
    parser.expandPipelineFromString(implicitStepsIncorrectYaml, {});
    console.log('❌ FAIL: Expected validation error for implicit step items\n');
} catch (error) {
    if (error.message.includes('Step item') && error.message.includes('indented')) {
        console.log('✅ PASS: Correctly detected implicit step item indentation error');
        console.log(`   Error message: ${error.message.split('\\n')[0]}\n`);
    } else {
        console.log('❌ FAIL: Got error but wrong message');
        console.log(`   Error: ${error.message}\n`);
    }
}

// Test case 6: Implicit step items with correct indentation
console.log('=== Test 6: Implicit step items (no steps:) with correct indentation ===');
const implicitStepsCorrectYaml = `jobs:
- \${{ each cfg in parameters.testConfigurations }}:
  - job: Run_\${{ replace(cfg.agentName, '-', '_') }}
    displayName: 'Run : \${{ cfg.agentName }}'
    workspace:
      clean: all
    pool:
      name: \${{ parameters.pool }}
    - script: echo "Test"
      displayName: 'Run test'
`;

try {
    const output = parser.expandPipelineFromString(implicitStepsCorrectYaml, {
        parameters: {
            testConfigurations: [{ agentName: 'test-agent-1' }],
            pool: 'TestPool',
        },
    });
    console.log('✅ PASS: No validation error for correctly indented implicit steps\n');
} catch (error) {
    console.log('❌ FAIL: Unexpected error for correct implicit steps');
    console.log(`   Error: ${error.message}\n`);
}

// Test case 7: Multiple step types with incorrect indentation
console.log('=== Test 7: Different step types (task, bash, pwsh) with incorrect indentation ===');
const multipleStepTypesYaml = `jobs:
- job: TestJob
  displayName: 'Test Job'
  pool:
    name: TestPool
 - task: SomeTask@1
   displayName: 'Task step'
  - bash: echo "bash"
    displayName: 'Bash step'
`;

try {
    parser.expandPipelineFromString(multipleStepTypesYaml, {});
    console.log('❌ FAIL: Expected validation error for task step\n');
} catch (error) {
    if (error.message.includes('Step item') && error.message.includes('task')) {
        console.log('✅ PASS: Correctly detected task step indentation error');
        console.log(`   Error message: ${error.message.split('\\n')[0]}\n`);
    } else {
        console.log('❌ FAIL: Got error but wrong message');
        console.log(`   Error: ${error.message}\n`);
    }
}

// Test case 8: PowerShell step with incorrect indentation
console.log('=== Test 8: PowerShell step with incorrect indentation ===');
const pwshStepYaml = `jobs:
- job: TestJob
  displayName: 'Test Job'
  pool:
    name: TestPool
 - pwsh: Write-Host "test"
   displayName: 'PowerShell step'
`;

try {
    parser.expandPipelineFromString(pwshStepYaml, {});
    console.log('❌ FAIL: Expected validation error for pwsh step\n');
} catch (error) {
    if (error.message.includes('Step item') && error.message.includes('pwsh')) {
        console.log('✅ PASS: Correctly detected pwsh step indentation error');
        console.log(`   Error message: ${error.message.split('\\n')[0]}\n`);
    } else {
        console.log('❌ FAIL: Got error but wrong message');
        console.log(`   Error: ${error.message}\n`);
    }
}

// Test case 9: Checkout step with incorrect indentation
console.log('=== Test 9: Checkout step with incorrect indentation ===');
const checkoutStepYaml = `jobs:
- job: TestJob
  displayName: 'Test Job'
  pool:
    name: TestPool
 - checkout: self
   displayName: 'Checkout'
`;

try {
    parser.expandPipelineFromString(checkoutStepYaml, {});
    console.log('❌ FAIL: Expected validation error for checkout step\n');
} catch (error) {
    if (error.message.includes('Step item') && error.message.includes('checkout')) {
        console.log('✅ PASS: Correctly detected checkout step indentation error');
        console.log(`   Error message: ${error.message.split('\\n')[0]}\n`);
    } else {
        console.log('❌ FAIL: Got error but wrong message');
        console.log(`   Error: ${error.message}\n`);
    }
}

// Test case 10: Mixed correct and incorrect - only flag incorrect
console.log('=== Test 10: Mix of correct explicit steps and incorrect implicit step ===');
const mixedYaml = `jobs:
- job: Job1
  displayName: 'Job 1'
  pool:
    name: TestPool
  steps:
  - script: echo "correct"
- job: Job2
  displayName: 'Job 2'
  pool:
    name: TestPool
 - script: echo "incorrect"
`;

try {
    parser.expandPipelineFromString(mixedYaml, {});
    console.log('❌ FAIL: Expected validation error for Job2\n');
} catch (error) {
    if (error.message.includes('Step item') && error.message.includes('script')) {
        console.log('✅ PASS: Correctly detected only the incorrectly indented step');
        console.log(`   Error message: ${error.message.split('\\n')[0]}\n`);
    } else {
        console.log('❌ FAIL: Got error but wrong message');
        console.log(`   Error: ${error.message}\n`);
    }
}

// Test case 11: Job with nested conditional - should not false trigger
console.log('=== Test 11: Job with nested ${{ if }} conditions (no false positives) ===');
const nestedConditionalYaml = `jobs:
- job: TestJob
  displayName: 'Test Job'
  \${{ if eq(parameters.useCustomPool, true) }}:
    pool:
      name: CustomPool
  \${{ else }}:
    pool: DefaultPool
  steps:
  - script: echo "Test"
`;

try {
    const output = parser.expandPipelineFromString(nestedConditionalYaml, {
        parameters: {
            useCustomPool: false,
        },
    });
    console.log('✅ PASS: No false positive for nested conditionals with correct indentation\n');
} catch (error) {
    console.log('❌ FAIL: Unexpected error for nested conditionals');
    console.log(`   Error: ${error.message}\n`);
}

console.log('Testing complete!');
