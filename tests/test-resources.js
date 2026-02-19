#!/usr/bin/env node

/**
 * Tests for Resource Handling
 *
 * Tests parsing and resolution of Azure Pipeline resources:
 * - repositories
 * - pipelines
 * - containers
 * - webhooks
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser');

const parser = new AzurePipelineParser();

console.log('Testing Resource Handling\n');

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

// Test 1: Repository resource parsing
runTest('Test 1: Repository resource parsing', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      type: github
      name: myorg/azure-pipeline-templates
      ref: refs/heads/main
    - repository: commonScripts
      type: git
      name: MyProject/CommonScripts

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - checkout: templates
          - script: echo "Building"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    if (!output.includes('repositories:')) {
        throw new Error('Expected repositories section in output');
    }

    if (!output.includes('templates')) {
        throw new Error('Expected "templates" repository in output');
    }

    if (verbose) {
        console.log(output);
    }
});

// Test 2: Pipeline resource with trigger
runTest('Test 2: Pipeline resource with trigger', () => {
    const yaml = `
resources:
  pipelines:
    - pipeline: SecurityScan
      source: 'Security Scanning Pipeline'
      trigger:
        branches:
          include:
            - main
            - releases/*
    - pipeline: BuildArtifacts
      source: 'Build Pipeline'
      trigger: true

stages:
  - stage: Deploy
    jobs:
      - job: DeployJob
        steps:
          - script: echo "Deploying after pipeline trigger"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    if (!output.includes('pipelines:')) {
        throw new Error('Expected pipelines section in output');
    }

    if (!output.includes('SecurityScan')) {
        throw new Error('Expected SecurityScan pipeline resource');
    }

    if (verbose) {
        console.log(output);
    }
});

// Test 3: Container resource
runTest('Test 3: Container resource', () => {
    const yaml = `
resources:
  containers:
    - container: linux
      image: ubuntu:20.04
    - container: node
      image: node:18-alpine
      endpoint: DockerHub

stages:
  - stage: Build
    jobs:
      - job: BuildInContainer
        container: linux
        steps:
          - script: echo "Building in container"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    if (!output.includes('containers:')) {
        throw new Error('Expected containers section in output');
    }

    if (!output.includes('ubuntu:20.04')) {
        throw new Error('Expected ubuntu container image');
    }

    if (verbose) {
        console.log(output);
    }
});

// Test 4: Webhook resource
runTest('Test 4: Webhook resource', () => {
    const yaml = `
resources:
  webhooks:
    - webhook: MyWebhook
      connection: MyServiceConnection
      filters:
        - path: status
          value: success

stages:
  - stage: Process
    jobs:
      - job: ProcessWebhook
        steps:
          - script: echo "Processing webhook"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    if (!output.includes('webhooks:')) {
        throw new Error('Expected webhooks section in output');
    }

    if (!output.includes('MyWebhook')) {
        throw new Error('Expected MyWebhook resource');
    }

    if (verbose) {
        console.log(output);
    }
});

// Test 5: Multiple resource types
runTest('Test 5: Multiple resource types in one pipeline', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      type: github
      name: myorg/templates
  
  pipelines:
    - pipeline: upstream
      source: 'Upstream Pipeline'
  
  containers:
    - container: buildContainer
      image: mcr.microsoft.com/dotnet/sdk:6.0

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        container: buildContainer
        steps:
          - checkout: templates
          - script: echo "Building with multiple resources"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    if (!output.includes('repositories:')) {
        throw new Error('Expected repositories section');
    }

    if (!output.includes('pipelines:')) {
        throw new Error('Expected pipelines section');
    }

    if (!output.includes('containers:')) {
        throw new Error('Expected containers section');
    }
});

// Test 6: Repository alias resolution with @self
runTest('Test 6: Repository @self reference', () => {
    const yaml = `
resources:
  repositories:
    - repository: self
      type: git
      name: MyProject/MyRepo

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - script: echo "Using self repository"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    if (!output.includes('self') && !output.includes('MyProject/MyRepo')) {
        throw new Error('Expected self repository definition in output');
    }
});

// Test 7: Template from external repository
runTest('Test 7: Template reference from external repository', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      type: github
      name: myorg/templates
      ref: main

stages:
  - template: stages/build.yml@templates
    parameters:
      buildConfiguration: Release
`;

    // This will fail to find the actual template, but should parse the reference
    try {
        const result = parser.expandPipeline(yaml);
        // If it succeeds, check the output
        if (result.yaml && !result.yaml.includes('templates')) {
            throw new Error('Expected templates repository reference');
        }
    } catch (error) {
        // Expected to fail on missing template file
        if (!error.message.includes('template') && !error.message.includes('not found')) {
            throw error;
        }
        // This is acceptable - template file doesn't exist in test environment
    }
});

// Test 8: Resource with endpoint configuration
runTest('Test 8: Resource with service endpoint', () => {
    const yaml = `
resources:
  repositories:
    - repository: ExternalRepo
      type: github
      name: external/repo
      endpoint: GitHubConnection
  
  containers:
    - container: PrivateRegistry
      image: myregistry.azurecr.io/myapp:latest
      endpoint: ACRConnection

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - script: echo "Using resources with endpoints"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    if (!output.includes('endpoint:')) {
        throw new Error('Expected endpoint configuration in resources');
    }
});

// Test 9: Empty resources section
runTest('Test 9: Empty resources section', () => {
    const yaml = `
resources:

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - script: echo "No resources"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    // Should parse without errors
    if (!output.includes('stages:')) {
        throw new Error('Pipeline should still process without resources');
    }
});

// Test 10: Repository with multiple checkout
runTest('Test 10: Multiple repository checkouts', () => {
    const yaml = `
resources:
  repositories:
    - repository: repo1
      type: git
      name: MyProject/Repo1
    - repository: repo2
      type: git
      name: MyProject/Repo2

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - checkout: repo1
          - checkout: repo2
          - checkout: self
          - script: echo "Building with multiple repos"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    // Verify that the multiple repositories are defined in resources
    if (!output.includes('repo1') || !output.includes('repo2')) {
        throw new Error('Expected both repositories to be defined in output');
    }
});

// Test 11: Pipeline resource with branch filters
runTest('Test 11: Pipeline resource with branch filters', () => {
    const yaml = `
resources:
  pipelines:
    - pipeline: BuildPipeline
      source: 'CI Build'
      trigger:
        branches:
          include:
            - main
            - releases/*
          exclude:
            - features/*
        tags:
          include:
            - v*
            - release-*

stages:
  - stage: Deploy
    jobs:
      - job: DeployJob
        steps:
          - script: echo "Deploying"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    if (!output.includes('branches:')) {
        throw new Error('Expected branch filters in pipeline resource');
    }

    if (!output.includes('include:')) {
        throw new Error('Expected include filters');
    }
});

// Test 12: Container with options
runTest('Test 12: Container resource with options', () => {
    const yaml = `
resources:
  containers:
    - container: build
      image: ubuntu:20.04
      options: --cpus 2 --memory 4g
      env:
        MY_VAR: value
      ports:
        - 8080:8080
      volumes:
        - /home/user:/workspace

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        container: build
        steps:
          - script: echo "Building with container options"
`;

    const result = parser.expandPipeline(yaml);
    const output = result.yaml;

    if (!output.includes('options:')) {
        throw new Error('Expected container options in output');
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
    console.log('\n🎉 All resource handling tests passed! 🎉\n');
    process.exit(0);
} else {
    console.log('\n❌ Some tests failed. Please review the output above.\n');
    process.exit(1);
}
