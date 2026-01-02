#!/usr/bin/env node

const { formatYaml } = require('../extension.js');
const fs = require('fs');
const path = require('path');

console.log('🔄 Testing Real File Idempotency');
console.log('=================================\n');

// Files that were reported as non-idempotent
const testFiles = [
    'jobs/service-v0-interface/java/_tests/test-integration-v0.yaml',
    'jobs/service-v0-interface/python/veracode-pipeline-scan-v0.yaml',
    'projects/3dGravity/lib/installers/cmake-installer-v0.yaml',
    'projects/global-newton/gn-win-dotnet-library-v0-alpha.yaml',
    'projects/wpp/stages/git-tag.yaml',
    'projects/wpp/stages/lambda/lambda-git-tag.yaml',
];

// Try to find templates directory - it might be in different locations
const possiblePaths = [
    path.join(__dirname, '../../templates'),
    path.join(__dirname, '../../../templates'),
    '/root/workspace/templates',
];

let templatesRoot = null;
for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
        templatesRoot = testPath;
        break;
    }
}

if (!templatesRoot) {
    console.log('⚠️  Templates directory not found. Skipping real file tests.');
    console.log('   This test requires the templates workspace to be available.\n');
    process.exit(0);
}
let passCount = 0;
let failCount = 0;

console.log('Testing 6 files that previously had idempotency issues:\n');

for (const relPath of testFiles) {
    const fullPath = path.join(templatesRoot, relPath);
    const fileName = path.basename(relPath);

    if (!fs.existsSync(fullPath)) {
        console.log(`⚠️  ${fileName.padEnd(45)} - File not found`);
        failCount++;
        continue;
    }

    const original = fs.readFileSync(fullPath, 'utf8');
    const result1 = formatYaml(original);
    const result2 = formatYaml(result1.text);
    const result3 = formatYaml(result2.text);

    const isIdempotent = result1.text === result2.text && result2.text === result3.text;

    if (isIdempotent) {
        console.log(
            `✅ ${fileName.padEnd(45)} (${original.length.toString().padStart(4)} → ${result1.text.length.toString().padStart(4)} chars)`,
        );
        passCount++;
    } else {
        console.log(`❌ ${fileName.padEnd(45)} - NOT IDEMPOTENT`);
        console.log(`   Format 1: ${result1.text.length} chars`);
        console.log(`   Format 2: ${result2.text.length} chars`);
        console.log(`   Format 3: ${result3.text.length} chars`);

        // Show first difference
        const lines1 = result1.text.split('\n');
        const lines2 = result2.text.split('\n');
        for (let i = 0; i < Math.max(lines1.length, lines2.length); i++) {
            if (lines1[i] !== lines2[i]) {
                console.log(`   First diff at line ${i + 1}:`);
                console.log(`     r1: "${lines1[i] || 'MISSING'}"`);
                console.log(`     r2: "${lines2[i] || 'MISSING'}"`);
                break;
            }
        }
        failCount++;
    }
}

console.log('\n🏁 IDEMPOTENCY TEST RESULTS');
console.log('===========================');
console.log(`Total Files: ${testFiles.length}`);
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${failCount}`);

if (failCount === 0) {
    console.log('\n🎉 ALL FILES ARE IDEMPOTENT!');
    process.exit(0);
} else {
    console.log('\n❌ Some files still have idempotency issues.');
    process.exit(1);
}
