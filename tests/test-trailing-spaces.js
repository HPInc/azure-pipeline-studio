const { AzurePipelineParser } = require('../parser.js');

console.log('Testing Multi-line Scalars with Trailing Spaces\n');

// Test 1: Script with trailing spaces should use double-quoted format
const input1 = `
steps:
- task: PythonScript@0
  inputs:
    script: |
      line1  
      line2
      line3  
`;

console.log('Test 1: Multi-line scalar with trailing spaces uses double-quoted format');
console.log('Input (lines 1 and 3 have trailing spaces):');
console.log(input1);

const parser = new AzurePipelineParser();
const expanded1 = parser.expandPipelineFromString(input1, {
    azureCompatible: true,
});

console.log('Expanded output:');
console.log(expanded1);

// Check for double-quoted format
const usesDoubleQuoted = expanded1.includes('script: "');
console.log('\nUses double-quoted format:', usesDoubleQuoted ? '✅' : '❌');

// Verify trailing spaces are preserved
const scriptMatch = expanded1.match(/script: "(.*?)"/s);
if (scriptMatch) {
    const scriptContent = scriptMatch[1];
    // The content should have escaped newlines and preserve spaces
    const hasPreservedSpaces = scriptContent.includes(' \\');
    console.log('Trailing spaces preserved:', hasPreservedSpaces ? '✅' : '❌');
}

// Test 2: Script without trailing spaces should use block format
const input2 = `
steps:
- task: PythonScript@0
  inputs:
    script: |
      line1
      line2
      line3
`;

console.log('\n\nTest 2: Multi-line scalar without trailing spaces uses block format');
console.log('Input (no trailing spaces):');
console.log(input2);

const expanded2 = parser.expandPipelineFromString(input2, {
    azureCompatible: true,
});

console.log('Expanded output:');
console.log(expanded2);

// Check for block format
const usesBlockFormat = expanded2.includes('script: |') || expanded2.includes('script: >');
console.log('\nUses block format (| or >):', usesBlockFormat ? '✅' : '❌');

// Test 3: Non-script key with trailing spaces
const input3 = `
variables:
  myVar: |
    value1  
    value2
`;

console.log('\n\nTest 3: Non-script key with trailing spaces uses double-quoted format');
console.log('Input:');
console.log(input3);

const expanded3 = parser.expandPipelineFromString(input3, {
    azureCompatible: true,
});

console.log('Expanded output:');
console.log(expanded3);

const varUsesDoubleQuoted = expanded3.includes('myVar: "');
console.log('\nUses double-quoted format:', varUsesDoubleQuoted ? '✅' : '❌');

// Test 4: Mixed - some lines with trailing spaces, some without
const input4 = `
steps:
- bash: |
    echo "start"  
    echo "middle"
    echo "end"  
`;

console.log('\n\nTest 4: Mixed trailing spaces (lines 1 and 3 have spaces)');
console.log('Input:');
console.log(input4);

const expanded4 = parser.expandPipelineFromString(input4, {
    azureCompatible: true,
});

console.log('Expanded output:');
console.log(expanded4);

const mixedUsesDoubleQuoted = expanded4.match(/script: "/);
console.log('\nUses double-quoted format:', mixedUsesDoubleQuoted ? '✅' : '❌');

console.log('\n\nAll tests completed!');
