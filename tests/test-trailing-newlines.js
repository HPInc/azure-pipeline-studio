const { AzurePipelineParser } = require('../parser.js');

console.log('Testing Trailing Newlines in Microsoft Compatibility Mode\n');

const parser = new AzurePipelineParser();

// Test 1: Microsoft compatibility mode should add 2 blank lines at EOF
const input1 = `stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    - bash: echo "test"`;

console.log('Test 1: Microsoft compatibility mode adds 2 blank lines at EOF');
console.log('Input:');
console.log(input1);

const expanded1 = parser.expandPipelineToString(input1, {
    azureCompatible: true,
});

console.log('\nExpanded output (last 50 chars):');
console.log(JSON.stringify(expanded1.slice(-50)));

// Check for 3 trailing newlines (content + 2 blank lines)
const endsWithThreeNewlines = expanded1.endsWith('\n\n\n');
console.log('\nEnds with 3 newlines (2 blank lines):', endsWithThreeNewlines ? '✅' : '❌');

// Count trailing newlines
const trailingNewlines = expanded1.match(/\n+$/);
const newlineCount = trailingNewlines ? trailingNewlines[0].length : 0;
console.log('Trailing newline count:', newlineCount, newlineCount === 3 ? '✅' : '❌');

// Test 2: Normal mode (without Microsoft compatibility) should have single newline
const input2 = `stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    - bash: echo "test"`;

console.log('\n\nTest 2: Normal mode has single newline at EOF');

const expanded2 = parser.expandPipelineToString(input2, {
    azureCompatible: false,
});

console.log('Expanded output (last 50 chars):');
console.log(JSON.stringify(expanded2.slice(-50)));

const endsWithSingleNewline = expanded2.endsWith('\n') && !expanded2.endsWith('\n\n');
console.log('\nEnds with single newline:', endsWithSingleNewline ? '✅' : '❌');

const trailingNewlines2 = expanded2.match(/\n+$/);
const newlineCount2 = trailingNewlines2 ? trailingNewlines2[0].length : 0;
console.log('Trailing newline count:', newlineCount2, newlineCount2 === 1 ? '✅' : '❌');

// Test 3: Microsoft compatibility with parameters
const input3 = `parameters:
- name: stage
  type: string
  default: 'Build'

stages:
- stage: \${{ parameters.stage }}
  jobs:
  - job: Test
    steps:
    - bash: echo "test"`;

console.log('\n\nTest 3: Microsoft compatibility with template expansion');

const expanded3 = parser.expandPipelineToString(input3, {
    parameters: {
        stage: 'Production',
    },
    azureCompatible: true,
});

console.log('Expanded output (last 60 chars):');
console.log(JSON.stringify(expanded3.slice(-60)));

const endsWithThreeNewlines3 = expanded3.endsWith('\n\n\n');
console.log('\nEnds with 3 newlines after expansion:', endsWithThreeNewlines3 ? '✅' : '❌');

// Test 4: Verify content before trailing newlines is correct
const input4 = `stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    - bash: |
        echo "line1"
        echo "line2"`;

console.log('\n\nTest 4: Content integrity preserved with trailing newlines');

const expanded4 = parser.expandPipelineToString(input4, {
    azureCompatible: true,
});

// Remove trailing newlines and check last line
const contentWithoutTrailing = expanded4.replace(/\n+$/, '');
const lastLine = contentWithoutTrailing.split('\n').pop();
console.log('Last content line:', JSON.stringify(lastLine));

const hasValidLastLine = lastLine.trim().length > 0;
console.log('Last line has content:', hasValidLastLine ? '✅' : '❌');

const hasCorrectTrailing = expanded4.endsWith('\n\n\n');
console.log('Has correct trailing newlines:', hasCorrectTrailing ? '✅' : '❌');

// Test 5: Multiple expansions should be idempotent
const input5 = `stages:
- stage: Build
  jobs:
  - job: Test
    steps:
    - bash: echo "test"`;

console.log('\n\nTest 5: Multiple expansions are idempotent');

const expanded5a = parser.expandPipelineToString(input5, {
    azureCompatible: true,
});

const expanded5b = parser.expandPipelineToString(expanded5a, {
    azureCompatible: true,
});

const trailingMatch5a = expanded5a.match(/\n+$/);
const trailingMatch5b = expanded5b.match(/\n+$/);
const count5a = trailingMatch5a ? trailingMatch5a[0].length : 0;
const count5b = trailingMatch5b ? trailingMatch5b[0].length : 0;

console.log('First expansion trailing newlines:', count5a);
console.log('Second expansion trailing newlines:', count5b);
console.log('Both have 3 newlines:', count5a === 3 && count5b === 3 ? '✅' : '❌');

console.log('\n\nAll tests completed!');
