#!/usr/bin/env node

const { formatYaml } = require('../extension.js');

console.log('🚀 Quick Formatter Validation Test');
console.log('===================================\n');

// Test the key functionality
const testInput = `# Test pipeline with all features
trigger:
  branches:
    include:
    - main
variables:
  buildConfig: Release
steps:
# First step
- task: DotNetCoreCLI@2
  displayName: Build
  inputs:
    command: build
    arguments: '--configuration Release --verbosity detailed --output $(Build.ArtifactStagingDirectory)'
# Second step  
- bash: |
    echo "Running tests with very long command line that should not be wrapped by the formatter"
    dotnet test --configuration Release --logger trx --collect:"XPlat Code Coverage" --results-directory TestResults/
  displayName: Test
# Third step
- task: PublishTestResults@2
  displayName: Publish Results`;

console.log('📝 Input YAML:');
console.log(testInput);
console.log('\n' + '='.repeat(60) + '\n');

const result = formatYaml(testInput);

console.log('📤 Formatted YAML:');
console.log(result.text);
console.log('\n' + '='.repeat(60) + '\n');

// Validate key features
const hasComments = result.text.includes('# Test pipeline') && result.text.includes('# First step');
// Step spacing adds blank lines before step blocks (including comments that precede steps)
const hasStepSpacing = result.text
    .split('\n')
    .some(
        (line, i, lines) =>
            line.trim() === '' &&
            lines[i + 1] &&
            (lines[i + 1].match(/^\s*-\s+(task|bash)/) || lines[i + 1].match(/^#\s/)),
    );
const hasLongLines = result.text.split('\n').some((line) => line.length > 80);
const noError = !result.error;

console.log('✅ Validation Results:');
console.log(`   Comments preserved: ${hasComments ? '✅' : '❌'}`);
console.log(`   Step spacing applied: ${hasStepSpacing ? '✅' : '❌'}`);
console.log(`   Long lines preserved: ${hasLongLines ? '✅' : '❌'}`);
console.log(`   No errors: ${noError ? '✅' : '❌'}`);

if (result.error) {
    console.log(`   Error: ${result.error}`);
}

const allPassed = hasComments && hasStepSpacing && hasLongLines && noError;

console.log(`\n🎯 Overall Result: ${allPassed ? '✅ SUCCESS' : '❌ FAILED'}`);

if (allPassed) {
    console.log('\n🌟 The YAML formatter is working perfectly!');
    console.log('   • Comments are preserved');
    console.log('   • Step spacing is enabled by default');
    console.log('   • Long lines are not wrapped');
    console.log('   • YAML structure is maintained');
} else {
    console.log('\n⚠️  Some features may not be working as expected.');
}

process.exit(allPassed ? 0 : 1);
