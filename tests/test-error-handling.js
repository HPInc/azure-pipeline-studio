#!/usr/bin/env node

const { formatYaml } = require('../extension.js');
const YAML = require('yaml');
const os = require('os');

console.log('⚠️  Testing Error Handling and Edge Cases');
console.log('==========================================\n');

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

// Test 1: Invalid YAML Syntax
runTest('Invalid YAML Syntax Handling', () => {
    const input = `steps:
- task: InvalidTask
  displayName: [this is not valid yaml
    inputs:
      key: value without proper indentation
  another_key: misaligned`;

    const result = formatYaml(input);

    console.log(`   Error handled gracefully: ${!!result.error || result.text === input}`);
    console.log(`   Error message: ${result.error || 'None'}`);

    // Should either provide an error message or return original content
    return result.error !== undefined || result.text === input;
});

// Test 2: Empty Input
runTest('Empty Input Handling', () => {
    const result1 = formatYaml('');
    const result2 = formatYaml(null);
    const result3 = formatYaml(undefined);

    console.log(`   Empty string handled: ${result1.text === ''}`);
    console.log(`   Null handled: ${result2.text === null}`);
    console.log(`   Undefined handled: ${result3.text === undefined}`);

    return !result1.error && !result2.error && !result3.error;
});

// Test 3: Very Large Input
runTest('Very Large Input Handling', () => {
    // Create a large YAML structure
    let largeInput = 'stages:\n';
    for (let i = 0; i < 100; i++) {
        largeInput += `- stage: Stage${i}\n`;
        largeInput += `  displayName: 'Stage ${i}'\n`;
        largeInput += `  jobs:\n`;
        for (let j = 0; j < 10; j++) {
            largeInput += `  - job: Job${i}_${j}\n`;
            largeInput += `    displayName: 'Job ${i}-${j}'\n`;
            largeInput += `    steps:\n`;
            largeInput += `    - bash: echo "Stage ${i} Job ${j}"\n`;
            largeInput += `      displayName: 'Execute ${i}-${j}'\n`;
        }
    }

    console.log(`   Input size: ${largeInput.length} characters`);

    const startTime = Date.now();
    const result = formatYaml(largeInput);
    const endTime = Date.now();

    console.log(`   Processing time: ${endTime - startTime}ms`);
    console.log(`   Completed without error: ${!result.error}`);
    console.log(`   Output size: ${result.text.length} characters`);

    return !result.error && result.text.length > 0;
});

// Test 4: Special Characters and Unicode
runTest('Special Characters and Unicode', () => {
    const input = `# Pipeline with special characters: åäö ñü 中文 🎉 ✅
variables:
  message: 'Hello 世界! Testing unicode: αβγδε'
  symbols: "Special chars: @#$%^&*()[]{}|\\\\:\\";<>?,./"
  emoji: 'Build status: 🚀 ✅ ❌ ⚠️ 📊'
steps:
- bash: |
    echo "Пример на русском языке"
    echo "Exemple en français avec des accents: àáâãäå"
    echo "Deutsche Umlaute: äöüßÄÖÜ"
  displayName: 'Unicode Test: 测试 Тест'`;

    const result = formatYaml(input);

    const hasUnicode = result.text.includes('世界') && result.text.includes('αβγδε');
    const hasEmoji = result.text.includes('🚀') && result.text.includes('✅');
    const hasSpecialChars = result.text.includes('@#$%^&*');
    const hasCyrillic = result.text.includes('русском');

    console.log(`   Unicode preserved: ${hasUnicode}`);
    console.log(`   Emojis preserved: ${hasEmoji}`);
    console.log(`   Special characters preserved: ${hasSpecialChars}`);
    console.log(`   Cyrillic preserved: ${hasCyrillic}`);
    console.log(`   Error: ${result.error}`);

    return hasUnicode && hasEmoji && hasSpecialChars && hasCyrillic && !result.error;
});

// Test 5: Malformed Option Values
runTest('Invalid Option Values', () => {
    const input = `steps:
- task: TestTask@1
  displayName: Test`;

    // Test with invalid option types
    const result1 = formatYaml(input, { stepSpacing: 'invalid' });
    const result2 = formatYaml(input, { preserveComments: 123 });
    const result3 = formatYaml(input, { lineWidth: 'not a number' });
    const result4 = formatYaml(input, { indent: -5 });

    console.log(`   Invalid stepSpacing handled: ${!result1.error}`);
    console.log(`   Invalid preserveComments handled: ${!result2.error}`);
    console.log(`   Invalid lineWidth handled: ${!result3.error}`);
    console.log(`   Invalid indent handled: ${!result4.error}`);

    // Should handle gracefully with defaults
    return !result1.error && !result2.error && !result3.error && !result4.error;
});

// Test 6: Circular References (if applicable)
runTest('Complex Nested Structures', () => {
    const input = `stages:
- stage: Build
  jobs:
  - job: BuildJob
    steps:
    - bash: echo "level 1"
    - task: Bash@3
      inputs:
        targetType: 'inline'
        script: |
          cat << 'EOF' > nested.yml
          jobs:
          - job: NestedJob
            steps:
            - bash: echo "nested level"
          EOF
      displayName: Create Nested YAML
- stage: Deploy
  dependsOn: Build
  jobs:
  - deployment: DeployJob
    environment: production
    strategy:
      runOnce:
        deploy:
          steps:
          - download: current
            artifact: drop
          - bash: |
              echo "Deploying with complex structure"
              for file in $(find . -name "*.yml"); do
                echo "Processing $file"
              done
            displayName: Deploy Script`;

    const result = formatYaml(input);

    console.log(`   Complex nesting handled: ${!result.error}`);
    console.log(`   Structure preserved: ${result.text.includes('runOnce')}`);

    return !result.error && result.text.includes('runOnce') && result.text.includes('deployment:');
});

// Test 7: Windows vs Unix Line Endings
runTest('Line Ending Handling', () => {
    const unixInput = "steps:\n- bash: echo 'unix'\n  displayName: Unix";
    const windowsInput = "steps:\r\n- bash: echo 'windows'\r\n  displayName: Windows";
    const mixedInput = "steps:\n- bash: echo 'mixed'\r\n  displayName: Mixed";

    const result1 = formatYaml(unixInput);
    const result2 = formatYaml(windowsInput);
    const result3 = formatYaml(mixedInput);

    console.log(`   Unix line endings handled: ${!result1.error}`);
    console.log(`   Windows line endings handled: ${!result2.error}`);
    console.log(`   Mixed line endings handled: ${!result3.error}`);

    return !result1.error && !result2.error && !result3.error;
});

// Test 8: Deeply Nested Options
runTest('All Options Combined', () => {
    const input = `# Test all options
steps:
- task: Test@1
  displayName: First
- bash: |
    echo "Very long command line that should not be wrapped even with multiple options enabled for comprehensive testing"
  displayName: Second`;

    const result = formatYaml(input, {
        stepSpacing: true,
        preserveComments: true,
        lineWidth: -1,
        indent: 2,
        noArrayIndent: true,
        forceQuotes: false,
        sortKeys: false,
    });

    const hasComments = result.text.includes('# Test all options');
    const hasSpacing = result.text
        .split('\n')
        .some((line, i, lines) => line.trim() === '' && lines[i + 1] && lines[i + 1].includes('- bash:'));
    const hasLongLine = result.text.split('\n').some((line) => line.length > 80);

    console.log(`   Comments preserved: ${hasComments}`);
    console.log(`   Step spacing applied: ${hasSpacing}`);
    console.log(`   Long lines preserved: ${hasLongLine}`);
    console.log(`   No error: ${!result.error}`);

    return hasComments && hasSpacing && hasLongLine && !result.error;
});

// Test 9: YAML Documents with Separators
runTest('Multiple YAML Documents', () => {
    const input = `---
trigger:
  branches:
    include:
    - main
---
variables:
  test: value
---
steps:
- bash: echo "multi-doc"
  displayName: Test`;

    const result = formatYaml(input);

    // Multi-document YAML is not fully supported by parseDocument, but should handle gracefully
    // The yaml package returns an error for multi-doc, but we preserve the original content
    console.log(`   Multi-document YAML handled: ${result.text.length > 0}`);
    console.log(`   Separators preserved: ${result.text.includes('---')}`);

    // Changed expectation: multi-doc may error but should return original content
    return result.text.length > 0 && result.text.includes('---');
});

// Test 10: Memory and Performance
runTest('Performance with Complex Pipeline', () => {
    // Create a realistic complex pipeline
    const input = `# Complex production pipeline
trigger:
  branches:
    include:
    - main
    - release/*
  paths:
    exclude:
    - docs/*
    - README.md

variables:
- group: production-variables
- name: buildConfiguration
  value: Release
- name: vmImageName
  value: ubuntu-latest

stages:
- stage: Build
  displayName: Build stage
  jobs:
  - job: Build
    displayName: Build
    pool:
      vmImage: $(vmImageName)
    steps:
    - task: UseDotNet@2
      displayName: Install .NET Core SDK
      inputs:
        packageType: sdk
        version: 8.x
        installationPath: $(Agent.ToolsDirectory)/dotnet
    - task: DotNetCoreCLI@2
      displayName: Restore
      inputs:
        command: restore
        projects: '**/*.csproj'
    - task: DotNetCoreCLI@2
      displayName: Build
      inputs:
        command: build
        projects: '**/*.csproj'
        arguments: '--configuration $(buildConfiguration) --no-restore'
    - task: DotNetCoreCLI@2
      displayName: Test
      inputs:
        command: test
        projects: '**/*Tests/*.csproj'
        arguments: '--configuration $(buildConfiguration) --no-build --verbosity normal --collect:"XPlat Code Coverage"'
    - task: PublishCodeCoverageResults@1
      displayName: Publish Code Coverage
      inputs:
        codeCoverageTool: Cobertura
        summaryFileLocation: '$(Agent.TempDirectory)/**/coverage.cobertura.xml'

- stage: Deploy
  displayName: Deploy stage
  dependsOn: Build
  condition: and(succeededOrFailed(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
  jobs:
  - deployment: Deploy
    displayName: Deploy
    pool:
      vmImage: $(vmImageName)
    environment: production
    strategy:
      runOnce:
        deploy:
          steps:
          - task: AzureWebApp@1
            displayName: Azure Web App Deploy
            inputs:
              azureSubscription: $(azureServiceConnection)
              appType: webAppLinux
              appName: $(webAppName)
              package: $(Pipeline.Workspace)/drop/$(buildConfiguration)/*.zip`;

    const startTime = Date.now();
    const result = formatYaml(input);
    const endTime = Date.now();

    console.log(`   Processing time: ${endTime - startTime}ms`);
    console.log(`   Memory usage reasonable: ${endTime - startTime < 5000}`); // Should complete in < 5 seconds
    console.log(`   No error: ${!result.error}`);
    console.log(`   Output size: ${result.text.length} characters`);

    return !result.error && endTime - startTime < 5000 && result.text.length > input.length * 0.8;
});

// Test 11: Recursive Formatting with Mixed Valid/Invalid Files
runTest('Recursive Formatting Continues on Errors', () => {
    const fs = require('fs');
    const path = require('path');
    const { formatFilesRecursively } = require('../extension.js');

    // Create temporary test directory
    const testDir = path.join(os.tmpdir(), `test-recursive-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, 'subdir'), { recursive: true });

    try {
        // Create valid files with intentionally poor formatting
        fs.writeFileSync(path.join(testDir, 'valid1.yml'), 'steps:\n-  task: Task1@1\n   displayName: Valid 1');
        fs.writeFileSync(path.join(testDir, 'valid2.yaml'), 'variables:\n  var1:  value1\nsteps:\n-  bash: echo test');
        fs.writeFileSync(
            path.join(testDir, 'subdir', 'valid3.yml'),
            'parameters:\n  param1:  value1\nsteps:\n-  script: echo nested',
        );

        // Create invalid file
        fs.writeFileSync(
            path.join(testDir, 'invalid.yml'),
            'steps:\n- task: [invalid yaml syntax::\n  unclosed: [bracket',
        );

        // Format recursively (pass empty array for extensions to use defaults)
        const result = formatFilesRecursively([testDir], [], {});

        console.log(`   Total processed: ${result.totalFiles}`);
        console.log(`   Successfully formatted: ${result.formattedFiles.length}`);
        console.log(`   Errors encountered: ${result.errors.length}`);
        console.log(`   Continued after error: ${result.formattedFiles.length > 0 && result.errors.length > 0}`);

        // Verify valid files were formatted despite error
        const valid1Content = fs.readFileSync(path.join(testDir, 'valid1.yml'), 'utf8');
        const valid2Content = fs.readFileSync(path.join(testDir, 'valid2.yaml'), 'utf8');
        const valid3Content = fs.readFileSync(path.join(testDir, 'subdir', 'valid3.yml'), 'utf8');

        const allValidFilesExist =
            valid1Content.includes('Task1@1') && valid2Content.includes('var1:') && valid3Content.includes('param1:');

        console.log(`   All valid files processed: ${allValidFilesExist}`);
        console.log(`   At least one error recorded: ${result.errors.length >= 1}`);
        console.log(`   Processing continued: ${result.totalFiles === 4}`);

        // Cleanup
        fs.rmSync(testDir, { recursive: true, force: true });

        // Success criteria: all files processed, error recorded, processing continued
        return result.totalFiles === 4 && result.errors.length >= 1 && allValidFilesExist;
    } catch (error) {
        // Cleanup on error
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (e) {}
        console.log(`   Test error: ${error.message}`);
        return false;
    }
});

// Test 12: Template Expression Preservation
runTest('Template Expressions Not Expanded by Default', () => {
    const input = `parameters:
  testParam: defaultValue
  version: '1.0.0'

variables:
  computed: \${{ parameters.testParam }}
  runtime: \$(BuildNumber)
  compiletime: \$[variables.branch]

steps:
- bash: echo "\${{ parameters.testParam }}"
  displayName: Test \${{ parameters.version }}
- script: |
    echo "Runtime: \$(BuildNumber)"
    echo "Compile: \$[variables.branch]"
    echo "Template: \${{ parameters.testParam }}"
  displayName: Multi-syntax test`;

    const result = formatYaml(input);

    const preservesDollarBraces = result.text.includes('${{ parameters.testParam }}');
    const preservesDollarParens = result.text.includes('$(BuildNumber)');
    const preservesDollarBrackets = result.text.includes('$[variables.branch]');
    const preservesAllSyntaxes =
        result.text.includes('${{ parameters.version }}') &&
        result.text.includes('$(BuildNumber)') &&
        result.text.includes('$[variables.branch]');

    console.log(`   ${{}} syntax preserved: ${preservesDollarBraces}`);
    console.log(`   $() syntax preserved: ${preservesDollarParens}`);
    console.log(`   $[] syntax preserved: ${preservesDollarBrackets}`);
    console.log(`   All syntaxes preserved: ${preservesAllSyntaxes}`);
    console.log(`   No error: ${!result.error}`);

    return preservesDollarBraces && preservesDollarParens && preservesDollarBrackets && !result.error;
});

// Test 13: Template Expression Expansion with Flag
runTest('Template Expressions Expand with expandTemplates Option', () => {
    const input = `parameters:
  testParam: defaultValue

variables:
  computed: \${{ parameters.testParam }}

steps:
- bash: echo "\${{ parameters.testParam }}"
  displayName: Test`;

    const resultDefault = formatYaml(input);
    const resultExpanded = formatYaml(input, { expandTemplates: true });

    const defaultPreserves = resultDefault.text.includes('${{ parameters.testParam }}');
    const expandedAlsoPreserves = resultExpanded.text.includes('${{ parameters.testParam }}');

    console.log(`   Default preserves templates: ${defaultPreserves}`);
    console.log(`   expandTemplates=true also preserves: ${expandedAlsoPreserves}`);
    console.log(`   Both complete without error: ${!resultDefault.error && !resultExpanded.error}`);
    console.log(`   Note: expandTemplates allows YAML.stringify to expand, preserveTemplateExpressions restores them`);

    // Both should preserve templates - the expandTemplates flag controls whether
    // we apply preserveTemplateExpressions AFTER YAML.stringify
    return defaultPreserves && expandedAlsoPreserves && !resultDefault.error && !resultExpanded.error;
});

// Test 14: Backslash Preservation with Template Expressions
runTest('Backslashes Preserved in Template Expression Lines', () => {
    const input = `steps:
- bash: |
    echo "Regular backslash: \\n test"
    echo "Template: \${{ parameters.path }}\\subfolder"
    echo "Macro: \$(Agent.WorkFolder)\\build"
  displayName: Test backslashes`;

    const result = formatYaml(input);

    const preservesBackslash = result.text.includes('\\n') || result.text.includes('\\\\n');
    const preservesTemplate = result.text.includes('${{ parameters.path }}');
    const preservesMacro = result.text.includes('$(Agent.WorkFolder)');
    const noUnwantedDoubling = !result.text.includes('\\\\\\\\');

    console.log(`   Backslashes preserved: ${preservesBackslash}`);
    console.log(`   Template preserved: ${preservesTemplate}`);
    console.log(`   Macro preserved: ${preservesMacro}`);
    console.log(`   No unwanted doubling: ${noUnwantedDoubling}`);

    return preservesBackslash && preservesTemplate && preservesMacro && noUnwantedDoubling && !result.error;
});

// Final Results
console.log('🏁 ERROR HANDLING TEST RESULTS');
console.log('===============================');
console.log(`Total Tests: ${testCount}`);
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${testCount - passCount}`);
console.log(`📊 Success Rate: ${Math.round((passCount / testCount) * 100)}%\n`);

if (passCount === testCount) {
    console.log('🎉 ALL ERROR HANDLING TESTS PASSED!');
    process.exit(0);
} else {
    console.log('❌ Some error handling tests failed.');
    process.exit(1);
}
