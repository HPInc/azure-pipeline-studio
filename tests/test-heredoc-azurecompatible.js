const { AzurePipelineParser } = require('../parser.js');

console.log('Testing heredoc behavior with azureCompatible flag...\n');

// Test 1: Heredoc with expressions in standard mode
const test1 = `
parameters:
- name: token
  type: string
  default: 'abc'

steps:
- task: Bash@3
  inputs:
    script: |
      cat <<EOF > file.txt
      Token: \${{ parameters.token }}
      Line 2
      EOF
`;

const parser = new AzurePipelineParser();

console.log('=== Test 1: Heredoc with expressions, azureCompatible: false ===');
const result1 = parser.expandPipelineToString(test1, {
    azureCompatible: false,
    parameters: { token: 'mytoken' },
});

const match1 = result1.match(/script: ([|\>])/);
const scriptContent1 = result1.match(/script: [|\>]([^]*?)(?=\n  - |\n\n|$)/)[1];
const lines1 = scriptContent1.split('\n').filter((l, i) => i > 0); // Skip first empty line
const emptyLines1 = lines1.filter((l, i) => i < lines1.length - 1 && l.trim() === '').length;

console.log(`Block style: ${match1[1] === '|' ? 'literal (|)' : 'folded (>)'}`);
console.log(`Empty lines between content: ${emptyLines1}`);
console.log(`Result: ${match1[1] === '|' && emptyLines1 === 0 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Expected: literal style with no empty lines`);
console.log();

// Test 2: Heredoc with expressions in Azure mode
console.log('=== Test 2: Heredoc with expressions, azureCompatible: true ===');
const result2 = parser.expandPipelineToString(test1, {
    azureCompatible: true,
    parameters: { token: 'mytoken' },
});

const match2 = result2.match(/script: ([|\>])/);
const scriptContent2 = result2.match(/script: [|\>]([^]*?)(?=\n  - |\n\n\n|$)/)[1];
const lines2 = scriptContent2.split('\n');
const emptyLines2 = lines2.filter((l) => l.trim() === '').length;

console.log(`Block style: ${match2[1] === '|' ? 'literal (|)' : 'folded (>)'}`);
console.log(`Empty lines in output: ${emptyLines2}`);
console.log(`Result: ${match2[1] === '>' && emptyLines2 >= 3 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Expected: folded style with empty lines added in heredoc`);
console.log();

// Test 3: Heredoc without expressions in standard mode
const test3 = `
steps:
- task: Bash@3
  inputs:
    script: |
      cat <<EOF > file.txt
      Static line 1
      Static line 2
      EOF
`;

console.log('=== Test 3: Heredoc without expressions, azureCompatible: false ===');
const result3 = parser.expandPipelineToString(test3, { azureCompatible: false });

const match3 = result3.match(/script: ([|\>])/);
const scriptContent3 = result3.match(/script: [|\>]([^]*?)(?=\n  - |\n\n|$)/)[1];
const lines3 = scriptContent3.split('\n').filter((l, i) => i > 0);
const emptyLines3 = lines3.filter((l, i) => i < lines3.length - 1 && l.trim() === '').length;

console.log(`Block style: ${match3[1] === '|' ? 'literal (|)' : 'folded (>)'}`);
console.log(`Empty lines between content: ${emptyLines3}`);
console.log(`Result: ${match3[1] === '|' && emptyLines3 === 0 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Expected: literal style with no empty lines`);
console.log();

// Test 4: Script with expressions but no heredoc in standard mode
const test4 = `
parameters:
- name: version
  type: string
  default: '1.0'

steps:
- task: Bash@3
  inputs:
    script: |
      VERSION="\${{ parameters.version }}"
      echo "Version: $VERSION"
      echo "Done"
`;

console.log('=== Test 4: Expressions without heredoc, azureCompatible: false ===');
const result4 = parser.expandPipelineToString(test4, {
    azureCompatible: false,
    parameters: { version: '2.0' },
});

const match4 = result4.match(/script: ([|\>])/);
const scriptContent4 = result4.match(/script: [|\>]([^]*?)(?=\n  - |\n\n|$)/)[1];
const lines4 = scriptContent4.split('\n').filter((l, i) => i > 0);
const emptyLines4 = lines4.filter((l, i) => i < lines4.length - 1 && l.trim() === '').length;

console.log(`Block style: ${match4[1] === '|' ? 'literal (|)' : 'folded (>)'}`);
console.log(`Empty lines between content: ${emptyLines4}`);
console.log(`Result: ${match4[1] === '|' && emptyLines4 === 0 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Expected: literal style with no empty lines`);
console.log();

// Test 5: Script with expressions but no heredoc in Azure mode
console.log('=== Test 5: Expressions without heredoc, azureCompatible: true ===');
const result5 = parser.expandPipelineToString(test4, {
    azureCompatible: true,
    parameters: { version: '2.0' },
});

const match5 = result5.match(/script: ([|\>])/);
console.log(`Block style: ${match5[1] === '|' ? 'literal (|)' : 'folded (>)'}`);
console.log(`Result: ${match5[1] === '>' ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Expected: folded style`);
console.log();

// Test 6: Multiple heredocs with expressions in standard mode
const test6 = `
parameters:
- name: msg
  type: string
  default: 'hello'

steps:
- task: Bash@3
  inputs:
    script: |
      cat <<EOF1 > file1.txt
      Message: \${{ parameters.msg }}
      EOF1
      
      cat <<EOF2 > file2.txt
      Another: \${{ parameters.msg }}
      EOF2
`;

console.log('=== Test 6: Multiple heredocs with expressions, azureCompatible: false ===');
const result6 = parser.expandPipelineToString(test6, {
    azureCompatible: false,
    parameters: { msg: 'test' },
});

const match6 = result6.match(/script: ([|\>])/);
const scriptContent6 = result6.match(/script: [|\>]([^]*?)(?=\n  - |\n\n|$)/)[1];
const lines6 = scriptContent6.split('\n').filter((l, i) => i > 0);

// Check that heredoc content lines don't have extra empty lines
let heredocLineCount = 0;
let inHeredoc = false;
let heredocEmptyCount = 0;

for (let i = 0; i < lines6.length; i++) {
    const line = lines6[i].trim();
    if (line.startsWith('cat <<EOF')) {
        inHeredoc = true;
    } else if (inHeredoc && line.match(/^EOF\d?$/)) {
        inHeredoc = false;
    } else if (inHeredoc) {
        heredocLineCount++;
        if (line === '') heredocEmptyCount++;
    }
}

console.log(`Block style: ${match6[1] === '|' ? 'literal (|)' : 'folded (>)'}`);
console.log(`Heredoc content lines: ${heredocLineCount}`);
console.log(`Empty lines within heredoc content: ${heredocEmptyCount}`);
console.log(`Result: ${match6[1] === '|' && heredocEmptyCount === 0 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Expected: literal style with no empty lines within heredoc content`);
console.log();

console.log('=== Summary ===');
console.log('All tests should show ✅ PASS');
