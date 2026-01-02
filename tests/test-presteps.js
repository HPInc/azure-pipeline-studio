#!/usr/bin/env node

const { AzurePipelineParser } = require('../extension.js');
const fs = require('fs');
const path = require('path');

console.log('Testing preSteps with nested @self template references...\n');

const testFile = path.join(__dirname, 'test-presteps.yml');
const sourceText = fs.readFileSync(testFile, 'utf8');

const parser = new AzurePipelineParser();

try {
    const expanded = parser.expandPipelineToString(sourceText, {
        fileName: testFile,
        resources: {
            repositories: {
                self: {
                    location: __dirname, // Use the tests directory as the location for 'self' repository
                },
            },
        },
    });

    console.log('✓ Pipeline expansion successful!\n');
    console.log('Expanded YAML:');
    console.log('='.repeat(80));
    console.log(expanded);
    console.log('='.repeat(80));

    // Check if the nested template content is present
    const hasNestedContent = expanded.includes('Running nested template steps');
    const hasEnvironmentVar = expanded.includes('Environment is $(targetEnvironment)');
    const hasBuildSteps = expanded.includes('Build Solution');
    const hasPreStepsBefore = expanded.includes('Initialize Build') && expanded.includes('Nested Template Step 1');
    const correctOrder =
        expanded.indexOf('Initialize Build') < expanded.indexOf('Nested Template Step 1') &&
        expanded.indexOf('Nested Template Step 1') < expanded.indexOf('Build Solution');

    console.log('\n✓ Validation checks:');
    console.log(`  - Nested template content found: ${hasNestedContent ? '✓' : '✗'}`);
    console.log(`  - Environment variable preserved: ${hasEnvironmentVar ? '✓' : '✗'}`);
    console.log(`  - Build template steps present: ${hasBuildSteps ? '✓' : '✗'}`);
    console.log(`  - PreSteps inserted before build: ${hasPreStepsBefore ? '✓' : '✗'}`);
    console.log(`  - Steps in correct order: ${correctOrder ? '✓' : '✗'}`);

    if (hasNestedContent && hasEnvironmentVar && hasBuildSteps && hasPreStepsBefore && correctOrder) {
        console.log('\n✓ All checks passed! preSteps with @self templates work correctly.\n');
        process.exit(0);
    } else {
        console.log('\n✗ Some checks failed. preSteps may not be fully expanded.\n');
        process.exit(1);
    }
} catch (error) {
    console.error('✗ Pipeline expansion failed:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
}
