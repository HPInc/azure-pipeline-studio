const { AzurePipelineParser } = require('../parser.js');

console.log('Testing Block Scalar Chomping Indicators\n');

const parser = new AzurePipelineParser();

// Test 1: Expression expanding to empty at end of block should trigger >+ chomping
const input1 = `parameters:
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
          sonar.projectKey=\${{ parameters.projectName }}
          sonar.verbose=true
          \${{ parameters.properties }}`;

console.log('Test 1: Expression expanding to empty at end should trigger >+ chomping');
console.log('Input (with expression at end):');
console.log(input1);

const expanded1 = parser.expandPipelineToString(input1, {
    variables: {
        projectName: 'MyProject',
    },
    parameters: {
        properties: '', // Empty parameter
    },
    azureCompatible: true,
});

console.log('\nExpanded output:');
console.log(expanded1);

// Check for >+ chomping indicator
const hasKeepChomping = /extraProperties:\s*>+/.test(expanded1);
console.log('\nHas >+ chomping indicator:', hasKeepChomping ? '✅' : '❌');

// Verify blank line is preserved in the block
const extraPropsLines = expanded1.split('\n');
const extraPropsIdx = extraPropsLines.findIndex((l) => l.includes('extraProperties:'));
if (extraPropsIdx >= 0) {
    // Check if there are blank lines in the content after the header
    const hasBlankLines = extraPropsLines
        .slice(extraPropsIdx + 1, extraPropsIdx + 10)
        .some((line) => line.trim() === '' || /^\s+$/.test(line));
    console.log('Content has blank lines (from empty expression):', hasBlankLines ? '✅' : '❌');
} else {
    console.log('Could not find extraProperties block:', '❌');
}

// Test 2: Expression in middle should use > (clip chomping)
const input2 = `parameters:
- name: projectName
  type: string

stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    - bash: |
        echo "Project: \${{ parameters.projectName }}"
        echo "Done"`;

console.log('\n\nTest 2: Expression in middle should use > (clip chomping)');
console.log('Input:');
console.log(input2);

const expanded2 = parser.expandPipelineToString(input2, {
    parameters: {
        projectName: 'MyProject',
    },
    azureCompatible: true,
});

console.log('\nExpanded output:');
console.log(expanded2);

// Check for > without + (clip chomping is default)
const scriptMatch = expanded2.match(/script:\s*>[^\+\-]/);
console.log('\nHas > (clip) chomping:', scriptMatch ? '✅' : '❌');

// Test 3: No expressions should use | (literal)
const input3 = `stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    - bash: |
        echo "line 1"
        echo "line 2"`;

console.log('\n\nTest 3: No expressions should use | (literal) style');
console.log('Input:');
console.log(input3);

const expanded3 = parser.expandPipelineToString(input3, {
    azureCompatible: true,
});

console.log('\nExpanded output:');
console.log(expanded3);

// Should still have | because no expressions
const hasLiteral = /script:\s*\|/.test(expanded3);
console.log('\nHas | (literal) style:', hasLiteral ? '✅' : '❌');

// Test 4: Multiple expressions with last one empty
const input4 = `parameters:
- name: extra
  type: string
  default: ''

stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    - task: Task@1
      inputs:
        config: |
          setting1=value1
          \${{ parameters.extra }}`;

console.log('\n\nTest 4: Multiple lines with last expression expanding to empty');
console.log('Input:');
console.log(input4);

const expanded4 = parser.expandPipelineToString(input4, {
    parameters: {
        extra: '',
    },
    azureCompatible: true,
});

console.log('\nExpanded output:');
console.log(expanded4);

// Check for >+ and blank line preservation
const configMatch = expanded4.match(/config:\s*>+/);
console.log('\nHas >+ chomping:', configMatch ? '✅' : '❌');

// Test 5: Whitespace-only expression result should be cleaned
const input5 = `parameters:
- name: spacing
  type: string
  default: '   '

stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    - bash: |
        echo "start"
        \${{ parameters.spacing }}
        echo "end"`;

console.log('\n\nTest 5: Whitespace-only expression should be cleaned but newline preserved');
console.log('Input:');
console.log(input5);

const expanded5 = parser.expandPipelineToString(input5, {
    parameters: {
        spacing: '   ', // Whitespace only
    },
    azureCompatible: true,
});

console.log('\nExpanded output:');
console.log(expanded5);

// Should have blank line between "start" and "end" (not whitespace-only line)
const scriptContent = expanded5.match(/script:\s*>\s*\n([\s\S]*?)(?:\n\s*\w+:|$)/);
if (scriptContent) {
    const lines = scriptContent[1].split('\n');
    const hasBlankLine = lines.some((line, idx) => idx > 0 && line.trim() === '' && lines[idx - 1].includes('start'));
    console.log('\nWhitespace-only line converted to blank line:', hasBlankLine ? '✅' : '❌');
}

console.log('\n\nAll tests completed!');
