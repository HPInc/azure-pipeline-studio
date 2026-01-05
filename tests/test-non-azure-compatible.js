const { AzurePipelineParser } = require('../parser.js');

console.log('Testing Non-Azure Compatible Mode Behavior\n');

// Test 1: Expression expanding to empty should NOT add >+ chomping in non-compat mode
const input1 = `
parameters:
- name: properties
  type: string
  default: ''

stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    - task: SonarQubeAnalyze@4
      inputs:
        extraProperties: |
          sonar.projectKey=test
          \${{ parameters.properties }}
`;

console.log('Test 1: Non-compat mode - no >+ chomping for expressions expanding to empty');
console.log('Input:');
console.log(input1);

const parser = new AzurePipelineParser();
const expanded1 = parser.expandPipelineFromString(input1, {
    azureCompatible: false,
});

console.log('Expanded output (non-compat mode):');
console.log(expanded1);

// Check that it doesn't use >+ (folded with keep chomping)
const hasKeepChomping = /extraProperties:\s*>\+/.test(expanded1);
console.log('\nDoes NOT use >+ chomping:', !hasKeepChomping ? '✅' : '❌');

// Should use |+ (literal with keep chomping) - default YAML behavior
const hasLiteralKeep = /extraProperties:\s*\|\+/.test(expanded1);
console.log('Uses |+ (literal keep) chomping:', hasLiteralKeep ? '✅' : '❌');

// Test 2: Compare with azureCompatible mode
console.log('\n\nTest 2: Azure-compat mode - SHOULD use >+ chomping');
const expanded2 = parser.expandPipelineFromString(input1, {
    azureCompatible: true,
});

console.log('Expanded output (azure-compat mode):');
console.log(expanded2);

const hasKeepChomping2 = /extraProperties:\s*>\+/.test(expanded2);
console.log('\nUses >+ (folded keep) chomping:', hasKeepChomping2 ? '✅' : '❌');

// Test 3: Heredoc with expressions - no empty lines in non-compat mode
const input3 = `
steps:
- bash: |
    cat <<EOF
    Line 1 \${{ parameters.var }}
    Line 2
    EOF
`;

console.log('\n\nTest 3: Non-compat mode - no extra empty lines in heredoc');
console.log('Input:');
console.log(input3);

const expanded3 = parser.expandPipelineFromString(input3, {
    azureCompatible: false,
    parameters: { var: 'value' },
});

console.log('Expanded output (non-compat mode):');
console.log(expanded3);

// Count blank lines in the script section
const scriptMatch3 = expanded3.match(/script:\s*[|>][\s\S]*?(?=\n\s*\n\s*\n|\n\s*$)/);
if (scriptMatch3) {
    const scriptContent = scriptMatch3[0];
    const blankLineCount = (scriptContent.match(/\n\s*\n/g) || []).length;
    console.log('\nNumber of blank lines in script:', blankLineCount);
    console.log('Has minimal blank lines (expected 1-2):', blankLineCount <= 2 ? '✅' : '❌');
}

// Test 4: Compare with azureCompatible mode for heredoc
console.log('\n\nTest 4: Azure-compat mode - SHOULD have extra empty lines in heredoc');
const expanded4 = parser.expandPipelineFromString(input3, {
    azureCompatible: true,
    parameters: { var: 'value' },
});

console.log('Expanded output (azure-compat mode):');
console.log(expanded4);

const scriptMatch4 = expanded4.match(/script:\s*[|>][\s\S]*?(?=\n\s*\n\s*\n|\n\s*$)/);
if (scriptMatch4) {
    const scriptContent = scriptMatch4[0];
    const blankLineCount = (scriptContent.match(/\n\s*\n/g) || []).length;
    console.log('\nNumber of blank lines in script:', blankLineCount);
    console.log('Has extra blank lines (expected 3+):', blankLineCount >= 3 ? '✅' : '❌');
}

console.log('\n\nAll tests completed!');
