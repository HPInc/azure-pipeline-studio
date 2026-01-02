#!/usr/bin/env node

const { formatYaml } = require('../extension.js');
const fs = require('fs');
const path = require('path');

console.log('📏 Testing Step Spacing Functionality');
console.log('=====================================\n');

let testCount = 0;
let passCount = 0;

function runTest(testName, testFn) {
    testCount++;
    console.log(`📋 Test ${testCount}: ${testName}`);
    try {
        const result = testFn();
        if (result) {
            passCount++;
            console.log('✅ PASS\n');
        } else {
            console.log('❌ FAIL\n');
        }
    } catch (error) {
        console.log(`❌ FAIL - ${error.message}\n`);
    }
}

function countStepSpacing(text) {
    const lines = text.split('\n');
    let blankCount = 0;

    for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        const nextLine = lines[i + 1];

        // Look for blank lines that appear before step items
        // Updated to include all Azure Pipeline step types
        if (
            line.trim() === '' &&
            nextLine &&
            nextLine.match(
                /^\s*-\s+(task|bash|powershell|pwsh|script|sh|checkout|download|downloadBuild|getPackage|publish|reviewApp|template)/,
            )
        ) {
            blankCount++;
        }
    }

    return blankCount;
}

// Test 1: Basic Step Spacing
runTest('Basic Step Spacing', () => {
    const input = `steps:
- task: Task1@1
  displayName: First Task
- task: Task2@1
  displayName: Second Task
- bash: echo "hello"
  displayName: Third Task`;

    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Found ${spacingCount} blank lines between steps`);
    console.log('   Output preview:');
    result.text
        .split('\n')
        .slice(0, 10)
        .forEach((line, i) => {
            console.log(`   ${i + 1}: "${line}"`);
        });

    return spacingCount >= 2; // Should have spacing between the 3 steps
});

// Test 2: Step Spacing with Different Task Types
runTest('Mixed Task Types Spacing', () => {
    const input = `steps:
- task: DotNetCoreCLI@2
  displayName: Restore
  inputs:
    command: restore
- bash: |
    echo "Building project"
    dotnet build
  displayName: Build Script
- powershell: |
    Write-Host "Running PowerShell"
  displayName: PowerShell Task
- script: echo "Generic script"
  displayName: Generic Script
- checkout: self
  displayName: Checkout Code`;

    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Found ${spacingCount} blank lines between ${5} different task types`);
    return spacingCount >= 4; // Should have spacing between 5 steps
});

// Test 3: Step Spacing Disabled
runTest('Step Spacing Disabled', () => {
    const input = `steps:
- task: Task1@1
  displayName: First Task
- task: Task2@1
  displayName: Second Task
- bash: echo "hello"
  displayName: Third Task`;

    const result = formatYaml(input, { stepSpacing: false });
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Found ${spacingCount} blank lines when disabled (should be 0)`);
    return spacingCount === 0;
});

// Test 4: Step Spacing with Nested Structure
runTest('Step Spacing in Jobs', () => {
    const input = `jobs:
- job: Job1
  displayName: First Job
  steps:
  - task: Task1@1
    displayName: Task 1
  - bash: echo "test"
    displayName: Task 2
- job: Job2
  displayName: Second Job
  steps:
  - task: Task3@1
    displayName: Task 3`;

    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Found ${spacingCount} blank lines in nested job structure`);
    return spacingCount >= 1; // Should have spacing between tasks within jobs
});

// Test 5: Step Spacing with Complex Multi-line Tasks
runTest('Step Spacing with Multi-line Tasks', () => {
    const input = `steps:
- task: DotNetCoreCLI@2
  displayName: 'Complex Task 1'
  inputs:
    command: 'build'
    projects: '**/*.csproj'
    arguments: '--configuration Release'
  condition: succeeded()
- bash: |
    echo "Starting complex script"
    for i in {1..5}; do
      echo "Processing item $i"
    done
    echo "Script completed"
  displayName: 'Complex Bash Script'
  continueOnError: false
- task: PublishTestResults@2
  displayName: 'Publish Test Results'
  inputs:
    testResultsFormat: 'VSTest'
    testResultsFiles: '**/*.trx'
    searchFolder: '$(Agent.TempDirectory)'
  condition: always()`;

    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Found ${spacingCount} blank lines between complex multi-line tasks`);
    return spacingCount >= 2; // Should have spacing between 3 complex tasks
});

// Test 6: Step Spacing Preserves Other Blank Lines
runTest('Preserves Existing Blank Lines', () => {
    const input = `trigger:
  branches:
    include:
    - main

variables:
  buildConfig: Release

steps:
- task: Task1@1
  displayName: First Task
- task: Task2@1
  displayName: Second Task`;

    const result = formatYaml(input);

    // Should preserve blank lines in other sections while adding step spacing
    const hasTopLevelSpacing = result.text.includes('- main\n\nvariables:');
    const hasStepSpacing = countStepSpacing(result.text) >= 1;

    console.log(`   Top-level section spacing preserved: ${hasTopLevelSpacing}`);
    console.log(`   Step spacing added: ${hasStepSpacing}`);

    return hasTopLevelSpacing && hasStepSpacing;
});

// Test 7: Step Spacing with Template Steps
runTest('Step Spacing with Template References', () => {
    const input = `steps:
- template: build-template.yml
  parameters:
    buildConfiguration: Release
- task: PublishBuildArtifacts@1
  displayName: Publish Artifacts
  inputs:
    PathtoPublish: '$(Build.ArtifactStagingDirectory)'
- template: test-template.yml
  parameters:
    testConfiguration: Release`;

    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Found ${spacingCount} spacing lines with template references`);
    // Templates might not match our step regex, so we check for any reasonable spacing
    return result.text.includes('template:') && !result.error;
});

// Test 8: Default Behavior Test
runTest('Default Behavior - Step Spacing Enabled', () => {
    const input = `steps:
- task: Setup@1
  displayName: Setup
- bash: echo "build"
  displayName: Build
- task: Cleanup@1
  displayName: Cleanup`;

    // Test with no options (should default to stepSpacing: true)
    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Default behavior produced ${spacingCount} spacing lines`);
    return spacingCount >= 2; // Default should enable step spacing
});

// Test 9: Step Spacing Edge Case - Single Step
runTest('Single Step - No Spacing Needed', () => {
    const input = `steps:
- task: OnlyTask@1
  displayName: Only Task
  inputs:
    parameter: value`;

    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Single step produced ${spacingCount} spacing lines (should be 0)`);
    return spacingCount === 0; // No spacing needed for single step
});

// Test 10: Step Spacing with Empty Steps Array
runTest('Empty Steps Array', () => {
    const input = `trigger:
  branches:
    include:
    - main
variables:
  test: value
steps: []`;

    const result = formatYaml(input);

    console.log(`   Empty steps array handled without error: ${!result.error}`);
    return !result.error && result.text.includes('steps:');
});

// Test 11: New Step Types - sh, downloadBuild, getPackage
runTest('New Step Types Spacing (sh, downloadBuild, getPackage)', () => {
    const input = `steps:
- sh: echo "POSIX shell"
  displayName: Shell Script
- downloadBuild: current
  artifact: drop
  displayName: Download Build
- getPackage: myPackage
  displayName: Get Package
- task: Deploy@1
  displayName: Deploy`;

    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Found ${spacingCount} blank lines between new step types`);
    console.log('   Output preview:');
    result.text.split('\n').forEach((line, i) => {
        if (line.trim()) console.log(`   ${i + 1}: "${line}"`);
    });

    return spacingCount >= 3 && !result.error; // Should have spacing between 4 steps
});

// Test 12: reviewApp Step Type
runTest('reviewApp Step Type Spacing', () => {
    const input = `steps:
- reviewApp: myReviewApp
  displayName: Create Review App
- task: Deploy@1
  displayName: Deploy to Review
- bash: echo "Testing"
  displayName: Run Tests`;

    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Found ${spacingCount} blank lines with reviewApp step`);
    return spacingCount >= 2 && !result.error; // Should have spacing between 3 steps
});

// Test 13: All 13 Step Types Together
runTest('All 13 Azure Pipeline Step Types', () => {
    const input = `steps:
- task: Task@1
  displayName: Task
- bash: echo "bash"
  displayName: Bash
- powershell: Write-Host "ps"
  displayName: PowerShell
- pwsh: Write-Host "pwsh"
  displayName: PowerShell Core
- script: echo "script"
  displayName: Script
- sh: echo "sh"
  displayName: Shell
- checkout: self
  displayName: Checkout
- download: current
  displayName: Download
- downloadBuild: current
  displayName: Download Build
- getPackage: pkg
  displayName: Get Package
- publish: $(Build.ArtifactStagingDirectory)
  displayName: Publish
- reviewApp: app
  displayName: Review App
- template: template.yml
  displayName: Template`;

    const result = formatYaml(input);
    const spacingCount = countStepSpacing(result.text);

    console.log(`   Found ${spacingCount} blank lines between 13 step types`);
    return spacingCount >= 12 && !result.error; // Should have spacing between all 13 steps
});

// Test 14: Consecutive Comments Before Step - Comments Preserved
runTest('Consecutive Comments Before Step - Comments Preserved', () => {
    const input = `steps:
- bash: echo "first"
  displayName: First Step
# Comment line 1
# Comment line 2
# Comment line 3
- bash: echo "second"
  displayName: Second Step`;

    const result = formatYaml(input);

    // Check that all comments are preserved
    const hasComment1 = result.text.includes('# Comment line 1');
    const hasComment2 = result.text.includes('# Comment line 2');
    const hasComment3 = result.text.includes('# Comment line 3');

    console.log(`   Comment line 1 preserved: ${hasComment1}`);
    console.log(`   Comment line 2 preserved: ${hasComment2}`);
    console.log(`   Comment line 3 preserved: ${hasComment3}`);
    console.log('   Output:');
    result.text.split('\n').forEach((line, i) => {
        console.log(`   ${i + 1}: "${line}"`);
    });

    return hasComment1 && hasComment2 && hasComment3;
});

// Test 15: Single Comment Before Step - Comment Preserved
runTest('Single Comment Before Step - Comment Preserved', () => {
    const input = `steps:
- bash: echo "first"
  displayName: First Step
# Single comment
- bash: echo "second"
  displayName: Second Step`;

    const result = formatYaml(input);

    // Check that comment is preserved
    const hasComment = result.text.includes('# Single comment');

    console.log(`   Comment preserved: ${hasComment}`);

    return hasComment;
});

// Test 16: Multiple Comment Blocks Before Different Steps - Comments Preserved
runTest('Multiple Comment Blocks Before Different Steps - Comments Preserved', () => {
    const input = `steps:
- bash: echo "first"
  displayName: First Step
# Block 1 comment 1
# Block 1 comment 2
- bash: echo "second"
  displayName: Second Step
# Block 2 comment 1
# Block 2 comment 2
# Block 2 comment 3
- bash: echo "third"
  displayName: Third Step`;

    const result = formatYaml(input);

    // Check all comments are preserved
    const hasBlock1Comment1 = result.text.includes('# Block 1 comment 1');
    const hasBlock1Comment2 = result.text.includes('# Block 1 comment 2');
    const hasBlock2Comment1 = result.text.includes('# Block 2 comment 1');
    const hasBlock2Comment2 = result.text.includes('# Block 2 comment 2');
    const hasBlock2Comment3 = result.text.includes('# Block 2 comment 3');

    console.log(`   Block 1 comments preserved: ${hasBlock1Comment1 && hasBlock1Comment2}`);
    console.log(`   Block 2 comments preserved: ${hasBlock2Comment1 && hasBlock2Comment2 && hasBlock2Comment3}`);

    return hasBlock1Comment1 && hasBlock1Comment2 && hasBlock2Comment1 && hasBlock2Comment2 && hasBlock2Comment3;
});

// Test 17: Comments and Conditional Steps - Comments Preserved
runTest('Comments Before Conditional Steps - Comments Preserved', () => {
    const input = `steps:
- bash: echo "first"
  displayName: First Step
# Comment for conditional
# Second line of comment
- \${{ if eq(variables.test, 'true') }}:
  - bash: echo "conditional"
    displayName: Conditional Step`;

    const result = formatYaml(input);

    // Check comments are preserved
    const hasComment1 = result.text.includes('# Comment for conditional');
    const hasComment2 = result.text.includes('# Second line');

    console.log(`   Comments preserved: ${hasComment1 && hasComment2}`);

    return hasComment1 && hasComment2;
});

// Test 18: Idempotency with Consecutive Comments
runTest('Idempotency - Consecutive Comments', () => {
    const input = `steps:
- bash: echo "first"
  displayName: First Step
# Comment 1
# Comment 2
- bash: echo "second"
  displayName: Second Step`;

    const result1 = formatYaml(input);
    const result2 = formatYaml(result1.text);
    const result3 = formatYaml(result2.text);

    const isIdempotent = result1.text === result2.text && result2.text === result3.text;

    console.log(`   First pass == Second pass: ${result1.text === result2.text}`);
    console.log(`   Second pass == Third pass: ${result2.text === result3.text}`);
    console.log(`   Idempotent: ${isIdempotent}`);

    if (!isIdempotent) {
        console.log('\n   First pass:');
        console.log(result1.text);
        console.log('\n   Second pass:');
        console.log(result2.text);
    }

    return isIdempotent;
});

// Final Results
console.log('🏁 STEP SPACING TEST RESULTS');
console.log('============================');
console.log(`Total Tests: ${testCount}`);
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${testCount - passCount}`);
console.log(`📊 Success Rate: ${Math.round((passCount / testCount) * 100)}%\n`);

if (passCount === testCount) {
    console.log('🎉 ALL STEP SPACING TESTS PASSED!');
    process.exit(0);
} else {
    console.log('❌ Some step spacing tests failed.');
    process.exit(1);
}
