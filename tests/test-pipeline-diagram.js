#!/usr/bin/env node

/**
 * Tests for Pipeline Diagram / Dependency Analysis
 *
 * Tests the DependencyAnalyzer class which extracts stages, jobs, templates,
 * and resources from Azure Pipelines YAML and generates Mermaid diagrams.
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser');
const { DependencyAnalyzer } = require('../dependency-analyzer');

const parser = new AzurePipelineParser();
const analyzer = new DependencyAnalyzer(parser);

console.log('Testing Pipeline Diagram / Dependency Analysis\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

let passCount = 0;
let failCount = 0;

function runTest(name, testFn) {
    console.log(`=== ${name} ===`);
    try {
        testFn();
        console.log('✅ PASS\n');
        passCount++;
        return true;
    } catch (error) {
        console.log(`❌ FAIL: ${error.message}\n`);
        if (verbose) {
            console.log(error.stack);
        }
        failCount++;
        return false;
    }
}

// Test 1: Simple pipeline with single stage and job
runTest('Test 1: Simple pipeline - single stage, single job', () => {
    const yaml = `
stages:
  - stage: Build
    displayName: 'Build Stage'
    jobs:
      - job: BuildJob
        displayName: 'Build Application'
        steps:
          - script: echo "Building"
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    if (dependencies.error) {
        throw new Error(`Analysis failed: ${dependencies.error}`);
    }

    if (dependencies.stages.length !== 1) {
        throw new Error(`Expected 1 stage, got ${dependencies.stages.length}`);
    }

    if (dependencies.stages[0].name !== 'Build') {
        throw new Error(`Expected stage name 'Build', got '${dependencies.stages[0].name}'`);
    }

    if (!dependencies.stages[0].jobs || dependencies.stages[0].jobs.length !== 1) {
        throw new Error('Expected 1 job in stage');
    }

    if (verbose) {
        console.log('Dependencies:', JSON.stringify(dependencies, null, 2));
    }
});

// Test 2: Multi-stage pipeline with dependencies
runTest('Test 2: Multi-stage pipeline with dependencies', () => {
    const yaml = `
stages:
  - stage: Build
    displayName: 'Build'
    jobs:
      - job: Compile
        steps:
          - script: echo "Compiling"
  
  - stage: Test
    displayName: 'Test'
    dependsOn: Build
    jobs:
      - job: UnitTest
        steps:
          - script: echo "Testing"
  
  - stage: Deploy
    displayName: 'Deploy'
    dependsOn:
      - Build
      - Test
    jobs:
      - job: DeployProd
        steps:
          - script: echo "Deploying"
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    if (dependencies.stages.length !== 3) {
        throw new Error(`Expected 3 stages, got ${dependencies.stages.length}`);
    }

    const testStage = dependencies.stages.find((s) => s.name === 'Test');
    if (!testStage || testStage.dependsOn.length !== 1 || testStage.dependsOn[0] !== 'Build') {
        throw new Error('Test stage should depend on Build');
    }

    const deployStage = dependencies.stages.find((s) => s.name === 'Deploy');
    if (!deployStage || deployStage.dependsOn.length !== 2) {
        throw new Error('Deploy stage should depend on Build and Test');
    }

    if (dependencies.dependencyGraph.length < 2) {
        throw new Error('Expected dependency graph entries');
    }

    if (verbose) {
        console.log('Dependency Graph:', dependencies.dependencyGraph);
    }
});

// Test 3: Parallel stages (no dependencies)
runTest('Test 3: Parallel stages with no dependencies', () => {
    const yaml = `
stages:
  - stage: BuildFrontend
    jobs:
      - job: BuildFE
        steps:
          - script: echo "Building frontend"
  
  - stage: BuildBackend
    jobs:
      - job: BuildBE
        steps:
          - script: echo "Building backend"
  
  - stage: BuildAPI
    jobs:
      - job: BuildAPIJob
        steps:
          - script: echo "Building API"
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    if (dependencies.stages.length !== 3) {
        throw new Error(`Expected 3 stages, got ${dependencies.stages.length}`);
    }

    // All stages should have no dependencies (parallel execution)
    dependencies.stages.forEach((stage) => {
        if (stage.dependsOn && stage.dependsOn.length > 0) {
            throw new Error(`Stage ${stage.name} should have no dependencies`);
        }
    });

    if (dependencies.dependencyGraph.length > 0) {
        throw new Error('Expected no dependency graph entries for parallel stages');
    }
});

// Test 4: Jobs with dependencies
runTest('Test 4: Job dependencies within stage', () => {
    const yaml = `
jobs:
  - job: JobA
    steps:
      - script: echo "Job A"
  
  - job: JobB
    dependsOn: JobA
    steps:
      - script: echo "Job B"
  
  - job: JobC
    dependsOn:
      - JobA
      - JobB
    steps:
      - script: echo "Job C"
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    if (dependencies.jobs.length !== 3) {
        throw new Error(`Expected 3 jobs, got ${dependencies.jobs.length}`);
    }

    const jobB = dependencies.jobs.find((j) => j.name === 'JobB');
    if (!jobB || jobB.dependsOn.length !== 1 || jobB.dependsOn[0] !== 'JobA') {
        throw new Error('JobB should depend on JobA');
    }

    const jobC = dependencies.jobs.find((j) => j.name === 'JobC');
    if (!jobC || jobC.dependsOn.length !== 2) {
        throw new Error('JobC should depend on JobA and JobB');
    }
});

// Test 5: Mermaid diagram generation
runTest('Test 5: Mermaid diagram generation', () => {
    const yaml = `
stages:
  - stage: Build
    jobs:
      - job: Compile
        steps:
          - script: echo "Building"
  
  - stage: Deploy
    dependsOn: Build
    jobs:
      - job: DeployJob
        steps:
          - script: echo "Deploying"
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);
    const mermaid = analyzer.generateMermaidDiagram(dependencies);

    if (!mermaid) {
        throw new Error('Mermaid diagram generation returned empty result');
    }

    if (!mermaid.includes('graph TD') && !mermaid.includes('%%{init:')) {
        throw new Error('Mermaid diagram should contain graph notation');
    }

    if (!mermaid.includes('Build')) {
        throw new Error('Mermaid diagram should contain Build stage');
    }

    if (!mermaid.includes('Deploy')) {
        throw new Error('Mermaid diagram should contain Deploy stage');
    }

    const hasArrows = mermaid.includes('==>') || mermaid.includes('-->') || mermaid.includes('→');
    if (!hasArrows) {
        throw new Error('Mermaid diagram should contain dependency arrow');
    }

    if (!mermaid.includes('classDef')) {
        throw new Error('Mermaid diagram should contain style definitions');
    }

    if (verbose) {
        console.log('\n--- Mermaid Diagram ---');
        console.log(mermaid);
        console.log('--- End Diagram ---\n');
    }
});

// Test 6: Complex pipeline structure
runTest('Test 6: Complex multi-stage, multi-job pipeline', () => {
    const yaml = `
stages:
  - stage: CI
    displayName: 'Continuous Integration'
    jobs:
      - job: Lint
        steps:
          - script: npm run lint
      - job: Build
        dependsOn: Lint
        steps:
          - script: npm run build
      - job: Test
        dependsOn: Build
        steps:
          - script: npm test
  
  - stage: CD
    displayName: 'Continuous Deployment'
    dependsOn: CI
    jobs:
      - job: DeployStaging
        steps:
          - script: echo "Deploy to staging"
      - job: DeployProd
        dependsOn: DeployStaging
        steps:
          - script: echo "Deploy to production"
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    if (dependencies.stages.length !== 2) {
        throw new Error(`Expected 2 stages, got ${dependencies.stages.length}`);
    }

    if (dependencies.jobs.length !== 5) {
        throw new Error(`Expected 5 jobs, got ${dependencies.jobs.length}`);
    }

    const cdStage = dependencies.stages.find((s) => s.name === 'CD');
    if (!cdStage || cdStage.dependsOn[0] !== 'CI') {
        throw new Error('CD stage should depend on CI stage');
    }
});

// Test 7: Template references
runTest('Test 7: Template extraction', () => {
    const yaml = `
stages:
  - template: templates/build-stage.yml
    parameters:
      environment: production
  
  - stage: Deploy
    jobs:
      - template: templates/deploy-job.yml
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    if (dependencies.templates.length !== 2) {
        throw new Error(`Expected 2 template references, got ${dependencies.templates.length}`);
    }

    const stageTemplate = dependencies.templates.find((t) => t.path && t.path.includes('build-stage'));
    if (!stageTemplate) {
        throw new Error('Should find build-stage.yml template');
    }

    if (verbose) {
        console.log('Templates:', dependencies.templates);
    }
});

// Test 8: Resource extraction
runTest('Test 8: Resource extraction', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      type: github
      name: myorg/templates
      ref: refs/heads/main
  
  pipelines:
    - pipeline: SecurityScan
      source: 'Security Pipeline'
      trigger:
        branches:
          include:
            - main

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - script: echo "Building"
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    if (dependencies.resources.length === 0) {
        throw new Error('Expected resource entries');
    }

    const repoResource = dependencies.resources.find((r) => r.type === 'repository');
    if (!repoResource) {
        throw new Error('Should find repository resource');
    }

    if (verbose) {
        console.log('Resources:', dependencies.resources);
    }
});

// Test 9: Error handling - invalid YAML
runTest('Test 9: Error handling - invalid pipeline structure', () => {
    const yaml = `
invalid: structure
no: stages
or: jobs
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    // Should not crash, should return empty dependencies
    if (dependencies.stages.length > 0) {
        throw new Error('Should return empty stages for invalid pipeline');
    }

    if (dependencies.jobs.length > 0) {
        throw new Error('Should return empty jobs for invalid pipeline');
    }
});

// Test 10: Empty pipeline
runTest('Test 10: Empty pipeline handling', () => {
    const yaml = `# Empty pipeline file
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    if (dependencies.error) {
        throw new Error(`Should not error on empty pipeline: ${dependencies.error}`);
    }

    if (dependencies.stages.length > 0 || dependencies.jobs.length > 0) {
        throw new Error('Empty pipeline should have no stages or jobs');
    }
});

// Test 11: Deployment jobs
runTest('Test 11: Deployment jobs', () => {
    const yaml = `
stages:
  - stage: Deploy
    jobs:
      - deployment: DeployWeb
        environment: production
        strategy:
          runOnce:
            deploy:
              steps:
                - script: echo "Deploying"
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);

    if (dependencies.jobs.length !== 1) {
        throw new Error(`Expected 1 deployment job, got ${dependencies.jobs.length}`);
    }

    if (dependencies.jobs[0].name !== 'DeployWeb') {
        throw new Error(`Expected deployment job name 'DeployWeb', got '${dependencies.jobs[0].name}'`);
    }
});

// Test 12: Mermaid diagram with multiple job types
runTest('Test 12: Mermaid diagram with various stage types', () => {
    const yaml = `
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - script: echo "Building"
  
  - stage: Test
    dependsOn: Build
    jobs:
      - job: UnitTests
        steps:
          - script: echo "Testing"
  
  - stage: Deploy
    dependsOn: Test
    jobs:
      - deployment: DeployProd
        environment: production
        strategy:
          runOnce:
            deploy:
              steps:
                - script: echo "Deploying"
`;

    const dependencies = analyzer.analyzeDependencies('test.yaml', yaml);
    const mermaid = analyzer.generateMermaidDiagram(dependencies);

    if (!mermaid.includes('Build')) {
        throw new Error('Mermaid should contain Build stage');
    }

    if (!mermaid.includes('Test')) {
        throw new Error('Mermaid should contain Test stage');
    }

    if (!mermaid.includes('Deploy')) {
        throw new Error('Mermaid should contain Deploy stage');
    }

    if (!mermaid.includes('==>') && !mermaid.includes('-->') && !mermaid.includes('→')) {
        throw new Error('Mermaid diagram should contain dependency arrow');
    }
});

// Summary
console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`Total tests: ${passCount + failCount}`);
console.log(`Passed: ${passCount} ✅`);
console.log(`Failed: ${failCount} ❌`);
console.log('='.repeat(70));

if (failCount === 0) {
    console.log('\n🎉 All pipeline diagram tests passed! 🎉\n');
    process.exit(0);
} else {
    console.log('\n❌ Some tests failed. Please review the output above.\n');
    process.exit(1);
}
