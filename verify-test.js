#!/usr/bin/env node
// Simple test verification script
const { formatYaml } = require('./formatter.js');

console.log('Verifying comment spacing test...\n');

// Test 8: Comment positioned between steps (blank before, none after)
const test8Input = `steps:
- task: PowerShell@2
  inputs:
    script: echo "previous step"
  # Download Artifacts NCE.win-svc-device-control
- task: DownloadPipelineArtifact@2
  displayName: Download Artifacts NCE.win-svc-device-control
`;

const test8Expected = `steps:
- task: PowerShell@2
  inputs:
    script: echo "previous step"

# Download Artifacts NCE.win-svc-device-control
- task: DownloadPipelineArtifact@2
  displayName: Download Artifacts NCE.win-svc-device-control
`;

console.log('Input:');
console.log(test8Input);
console.log('\n---\n');

const test8Result = formatYaml(test8Input, { stepSpacing: true });

console.log('Expected:');
console.log(test8Expected);
console.log('\n---\n');

console.log('Actual:');
console.log(test8Result.text);
console.log('\n---\n');

if (test8Result.text === test8Expected) {
    console.log('✅ TEST PASSED!');
    process.exit(0);
} else {
    console.log('❌ TEST FAILED!');
    console.log('\nDifferences:');
    const expectedLines = test8Expected.split('\n');
    const actualLines = test8Result.text.split('\n');

    for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i++) {
        if (expectedLines[i] !== actualLines[i]) {
            console.log(`Line ${i + 1}:`);
            console.log(`  Expected: ${JSON.stringify(expectedLines[i])}`);
            console.log(`  Actual:   ${JSON.stringify(actualLines[i])}`);
        }
    }
    process.exit(1);
}
