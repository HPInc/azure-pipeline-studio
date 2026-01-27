#!/usr/bin/env node

const { formatYaml } = require('./formatter.js');

// Test case: comment spacing between steps
const inputYaml = `steps:
- task: PowerShell@2
  inputs:
    script: echo "previous step"
  # Download Artifacts NCE.win-svc-device-control
- task: DownloadPipelineArtifact@2
  displayName: Download Artifacts NCE.win-svc-device-control
`;

const expectedOutput = `steps:
- task: PowerShell@2
  inputs:
    script: echo "previous step"

# Download Artifacts NCE.win-svc-device-control
- task: DownloadPipelineArtifact@2
  displayName: Download Artifacts NCE.win-svc-device-control
`;

console.log('Testing comment spacing between steps...\n');
console.log('Input YAML:');
console.log('---');
console.log(inputYaml);
console.log('---\n');

const result = formatYaml(inputYaml, { stepSpacing: true });

console.log('Actual Output:');
console.log('---');
console.log(result.text);
console.log('---\n');

console.log('Expected Output:');
console.log('---');
console.log(expectedOutput);
console.log('---\n');

// Normalize for comparison (both should have same line endings)
const actualLines = result.text
    .trim()
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
const expectedLines = expectedOutput
    .trim()
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));

console.log('Comparison:');
console.log('Actual lines:');
actualLines.forEach((line, idx) => {
    console.log(`  ${idx}: "${line}"`);
});

console.log('\nExpected lines:');
expectedLines.forEach((line, idx) => {
    console.log(`  ${idx}: "${line}"`);
});

// Compare line by line
let allMatch = true;
if (actualLines.length !== expectedLines.length) {
    console.log(`\n❌ Line count mismatch: actual ${actualLines.length} vs expected ${expectedLines.length}`);
    allMatch = false;
} else {
    for (let i = 0; i < actualLines.length; i++) {
        if (actualLines[i] !== expectedLines[i]) {
            console.log(`\n❌ Line ${i} mismatch:`);
            console.log(`  Actual:   "${actualLines[i]}"`);
            console.log(`  Expected: "${expectedLines[i]}"`);
            allMatch = false;
        }
    }
}

if (allMatch && actualLines.length === expectedLines.length) {
    console.log('\n✅ PASS: Output matches expected format');
    process.exit(0);
} else {
    console.log('\n❌ FAIL: Output does not match expected format');
    process.exit(1);
}
