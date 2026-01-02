#!/usr/bin/env node

const { formatYaml } = require('../extension.js');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

console.log('🧪 Testing YAML Formatting Features');
console.log('====================================\n');

let testCount = 0;
let passCount = 0;
let failCount = 0;

function runTest(testName, testFn) {
    testCount++;
    console.log(`📋 Test ${testCount}: ${testName}`);
    try {
        const result = testFn();
        if (result) {
            passCount++;
            console.log('✅ PASS\n');
        } else {
            failCount++;
            console.log('❌ FAIL\n');
        }
    } catch (error) {
        failCount++;
        console.log(`❌ FAIL - ${error.message}\n`);
    }
}

// Test 1: Comment Preservation
runTest('Comment Preservation', () => {
    const input = `# Main pipeline configuration
trigger:
  branches:
    include:
    - main
    - develop
# Variables section
variables:
  buildConfiguration: 'Release'
steps:
# Build step
- task: DotNetCoreCLI@2
  displayName: Build Project`;

    const result = formatYaml(input);
    const lines = result.text.split('\n');
    const commentLines = lines.filter((line) => line.trim().startsWith('#'));

    console.log(`   Found ${commentLines.length} comment lines`);
    return commentLines.length >= 3 && result.text.includes('# Main pipeline configuration');
});

// Test 2: Step Spacing (Default Enabled)
runTest('Step Spacing - Default Enabled', () => {
    const input = `steps:
- task: Task1@1
  displayName: First Task
- bash: echo "hello"
  displayName: Second Task
- task: Task2@1
  displayName: Third Task`;

    const result = formatYaml(input);
    const lines = result.text.split('\n');

    // Count blank lines between steps
    let blankCount = 0;
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].trim() === '' && lines[i + 1] && lines[i + 1].match(/^\s*-\s+(task|bash)/)) {
            blankCount++;
        }
    }

    console.log(`   Found ${blankCount} blank lines between steps`);
    return blankCount >= 2; // Should have spacing between 3 steps
});

// Test 3: Step Spacing Can Be Disabled
runTest('Step Spacing - Can Be Disabled', () => {
    const input = `steps:
- task: Task1@1
  displayName: First Task
- bash: echo "hello"
  displayName: Second Task`;

    const result = formatYaml(input, { stepSpacing: false });
    const lines = result.text.split('\n');

    let blankCount = 0;
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].trim() === '' && lines[i + 1] && lines[i + 1].match(/^\s*-\s+(task|bash)/)) {
            blankCount++;
        }
    }

    console.log(`   Found ${blankCount} blank lines between steps (should be 0)`);
    return blankCount === 0;
});

// Test 4: Long Line Preservation
runTest('Long Line Preservation', () => {
    const input = `steps:
- bash: |
    echo "This is a very long line that should not be wrapped by the YAML formatter because it would break the functionality"
    dotnet test --configuration Release --logger trx --collect:"XPlat Code Coverage" --results-directory TestResults/
  displayName: Run Tests`;

    const result = formatYaml(input);
    const longLines = result.text.split('\n').filter((line) => line.length > 80);

    console.log(`   Found ${longLines.length} long lines preserved`);
    return longLines.length > 0 && result.text.includes('XPlat Code Coverage');
});

// Test 5: Python Code Block Preservation
runTest('Python Code Block Preservation', () => {
    const input = `steps:
- task: PythonScript@0
  inputs:
    scriptSource: 'inline'
    script: |
      import os
      import sys
      def process_data(data_list):
          for item in data_list:
              if item.get('status') == 'active':
                  print(f"Processing {item['name']}")
      
      data = [{"name": "test1", "status": "active"}, {"name": "test2", "status": "inactive"}]
      process_data(data)
  displayName: 'Run Python Script'`;

    const result = formatYaml(input);

    const hasPythonKeywords =
        result.text.includes('import os') &&
        result.text.includes('def process_data') &&
        result.text.includes('for item in data_list');

    console.log(`   Python code preserved: ${hasPythonKeywords}`);
    return hasPythonKeywords && !result.error;
});

// Test 6: Bash Script Content Preservation
runTest('Bash Script Content Preservation', () => {
    const input = `steps:
- bash: |
    #!/bin/bash
    set -e
    
    # Build and test the application
    echo "Starting build process..."
    dotnet restore
    dotnet build --configuration Release --no-restore
    dotnet test --configuration Release --no-build --verbosity normal
    
    if [ $? -eq 0 ]; then
        echo "Build and tests completed successfully!"
    else
        echo "Build or tests failed!"
        exit 1
    fi
  displayName: 'Build and Test'`;

    const result = formatYaml(input);

    const hasBashContent =
        result.text.includes('#!/bin/bash') &&
        result.text.includes('set -e') &&
        result.text.includes('dotnet restore') &&
        result.text.includes('if [ $? -eq 0 ]');

    console.log(`   Bash script preserved: ${hasBashContent}`);
    return hasBashContent && !result.error;
});

// Test 7: Complex Pipeline Structure
runTest('Complex Pipeline Structure', () => {
    const input = `# Complete pipeline with all features
trigger:
  branches:
    include:
    - main
    - develop
    - feature/*

variables:
  buildConfiguration: 'Release'
  solution: '**/*.sln'

stages:
- stage: Build
  displayName: 'Build Stage'
  jobs:
  - job: BuildJob
    displayName: 'Build and Test Job'
    pool:
      vmImage: 'ubuntu-latest'
    steps:
    - task: UseDotNet@2
      displayName: 'Install .NET SDK'
      inputs:
        packageType: 'sdk'
        version: '8.x'
    - bash: |
        echo "Restoring packages..."
        dotnet restore $(solution)
      displayName: 'Restore Packages'
    - task: DotNetCoreCLI@2
      displayName: 'Build Solution'
      inputs:
        command: 'build'
        projects: $(solution)
        arguments: '--configuration $(buildConfiguration) --no-restore'
- stage: Deploy
  displayName: 'Deploy Stage'
  dependsOn: Build
  condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
  jobs:
  - deployment: DeployJob
    displayName: 'Deploy to Production'
    environment: 'production'
    strategy:
      runOnce:
        deploy:
          steps:
          - task: AzureWebApp@1
            displayName: 'Deploy to Azure'
            inputs:
              azureSubscription: 'production-connection'
              appName: $(webAppName)`;

    const result = formatYaml(input);

    // Validate YAML structure
    let isValidYaml = false;
    try {
        YAML.parse(result.text);
        isValidYaml = true;
    } catch (e) {
        console.log(`   YAML validation error: ${e.message}`);
    }

    const hasComments = result.text.includes('# Complete pipeline');
    const hasStages = result.text.includes('stages:');
    const hasJobs = result.text.includes('jobs:');
    const hasSteps = result.text.includes('steps:');
    const hasBashScript = result.text.includes('dotnet restore');

    console.log(`   Valid YAML: ${isValidYaml}`);
    console.log(`   Comments preserved: ${hasComments}`);
    console.log(`   Structure maintained: ${hasStages && hasJobs && hasSteps}`);
    console.log(`   Bash script preserved: ${hasBashScript}`);

    return isValidYaml && hasComments && hasStages && hasJobs && hasSteps && hasBashScript;
});

// Test 8: DisplayName and Property Preservation
runTest('DisplayName and Property Preservation', () => {
    const input = `steps:
- task: PublishBuildArtifacts@1
  displayName: 'Publish Build Artifacts'
  inputs:
    PathtoPublish: '$(Build.ArtifactStagingDirectory)'
    ArtifactName: 'drop'
    publishLocation: 'Container'
  condition: succeeded()
  continueOnError: false`;

    const result = formatYaml(input);

    const hasDisplayName = result.text.includes('displayName:');
    const hasInputs = result.text.includes('inputs:');
    const hasCondition = result.text.includes('condition:');
    const hasContinueOnError = result.text.includes('continueOnError:');

    console.log(`   DisplayName preserved: ${hasDisplayName}`);
    console.log(`   Inputs section preserved: ${hasInputs}`);
    console.log(`   Properties preserved: ${hasCondition && hasContinueOnError}`);

    return hasDisplayName && hasInputs && hasCondition && hasContinueOnError;
});

// Test 9: Error Handling
runTest('Error Handling - Invalid YAML', () => {
    const input = `steps:
- task: InvalidTask
  displayName: [this is invalid yaml structure
    inputs:
      key: value without proper indentation`;

    const result = formatYaml(input);

    console.log(`   Has error: ${!!result.error}`);
    console.log(`   Error message: ${result.error || 'None'}`);

    // Should handle gracefully and return original content or provide meaningful error
    return result.error !== undefined || result.text === input;
});

// Test 10: Mixed Features Test
runTest('Mixed Features - Comments, Spacing, Long Lines', () => {
    const input = `# Pipeline with mixed features
steps:
# First step
- bash: |
    echo "This is a very long command that tests whether the formatter preserves long lines without wrapping them inappropriately"
  displayName: Long Command Test
# Second step  
- task: DotNetCoreCLI@2
  displayName: Build
  inputs:
    command: build
# Third step
- bash: echo "short command"
  displayName: Short Command`;

    const result = formatYaml(input, { preserveComments: true, stepSpacing: true });

    const hasComments = result.text.includes('# Pipeline with mixed features');
    const hasLongLine = result.text.split('\n').some((line) => line.length > 80);

    // Count spacing - blank lines before step blocks (including comments that precede steps)
    const lines = result.text.split('\n');
    let spacingCount = 0;
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].trim() === '') {
            const nextLine = lines[i + 1];
            // Check if next line is a step or a comment before a step
            if (nextLine && (nextLine.match(/^\s*-\s+(task|bash)/) || nextLine.match(/^#\s/))) {
                spacingCount++;
            }
        }
    }

    console.log(`   Comments preserved: ${hasComments}`);
    console.log(`   Long lines preserved: ${hasLongLine}`);
    console.log(`   Step spacing applied: ${spacingCount > 0}`);

    return hasComments && hasLongLine && spacingCount > 0;
});

// Final Results
console.log('🏁 TEST RESULTS');
console.log('===============');
console.log(`Total Tests: ${testCount}`);
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${failCount}`);
console.log(`📊 Success Rate: ${Math.round((passCount / testCount) * 100)}%\n`);

if (failCount === 0) {
    console.log('🎉 ALL TESTS PASSED! Formatting functionality is working correctly.');
    process.exit(0);
} else {
    console.log('❌ Some tests failed. Please review the formatting implementation.');
    process.exit(1);
}
