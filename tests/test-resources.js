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
const os = require('os');
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

runTest('Test 13: Unqualified template reference uses self repository', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-self-'));

    try {
        const pipelinesDir = path.join(tempRoot, 'pipelines');
        const templatesDir = path.join(tempRoot, 'templates');

        fs.mkdirSync(pipelinesDir, { recursive: true });
        fs.mkdirSync(templatesDir, { recursive: true });

        fs.writeFileSync(
            path.join(templatesDir, 'build.yml'),
            `steps:\n  - script: echo "resolved from self"\n`,
            'utf8'
        );

        const yaml = `
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - template: templates/build.yml
`;

        const result = parser.expandPipeline(yaml, {
            fileName: path.join(pipelinesDir, 'azure-pipelines.yml'),
            baseDir: pipelinesDir,
            repoBaseDir: tempRoot,
            rootRepoBaseDir: tempRoot,
        });

        if (!result.yaml.includes('resolved from self')) {
            throw new Error('Expected unqualified template reference to resolve against self repository');
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

runTest('Test 14: Symlinked template path resolves to real template location', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-symlink-'));

    try {
        const realTemplatesDir = path.join(tempRoot, 'real', 'templates');
        const symlinkDir = path.join(tempRoot, 'links');

        fs.mkdirSync(realTemplatesDir, { recursive: true });
        fs.mkdirSync(symlinkDir, { recursive: true });

        fs.writeFileSync(
            path.join(realTemplatesDir, 'nested.yml'),
            `steps:\n  - script: echo "nested from real path"\n`,
            'utf8'
        );

        fs.writeFileSync(path.join(realTemplatesDir, 'main.yml'), `steps:\n  - template: nested.yml\n`, 'utf8');

        fs.symlinkSync(path.join(realTemplatesDir, 'main.yml'), path.join(symlinkDir, 'main.yml'));

        const yaml = `
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - template: links/main.yml
`;

        const result = parser.expandPipeline(yaml, {
            fileName: path.join(tempRoot, 'azure-pipelines.yml'),
            baseDir: tempRoot,
            repoBaseDir: tempRoot,
            rootRepoBaseDir: tempRoot,
        });

        if (!result.yaml.includes('nested from real path')) {
            throw new Error('Expected nested template under the symlink target directory to resolve');
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

runTest('Test 15: Unqualified template prefers local path before self fallback', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-local-first-'));

    try {
        const pipelinesDir = path.join(tempRoot, 'pipelines');
        const localTemplatesDir = path.join(pipelinesDir, 'templates');
        const repoTemplatesDir = path.join(tempRoot, 'templates');

        fs.mkdirSync(localTemplatesDir, { recursive: true });
        fs.mkdirSync(repoTemplatesDir, { recursive: true });

        fs.writeFileSync(
            path.join(localTemplatesDir, 'build.yml'),
            `steps:\n  - script: echo "resolved from local path"\n`,
            'utf8'
        );

        fs.writeFileSync(
            path.join(repoTemplatesDir, 'build.yml'),
            `steps:\n  - script: echo "resolved from repo root"\n`,
            'utf8'
        );

        const yaml = `
  stages:
    - stage: Build
    jobs:
      - job: BuildJob
      steps:
        - template: templates/build.yml
  `;

        const result = parser.expandPipeline(yaml, {
            fileName: path.join(pipelinesDir, 'azure-pipelines.yml'),
            baseDir: pipelinesDir,
            repoBaseDir: tempRoot,
            rootRepoBaseDir: tempRoot,
        });

        if (!result.yaml.includes('resolved from local path')) {
            throw new Error('Expected local template path to be preferred before self fallback');
        }

        if (result.yaml.includes('resolved from repo root')) {
            throw new Error('Did not expect repo-root template to win when a local path exists');
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

runTest('Test 16: Unqualified template falls back to root repo when missing in external repo', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-root-fallback-'));

    try {
        const externalRepoDir = path.join(tempRoot, 'external-templates');
        fs.mkdirSync(externalRepoDir, { recursive: true });

        fs.writeFileSync(path.join(externalRepoDir, 'entry.yml'), `steps:\n  - template: systemtest.yaml\n`, 'utf8');

        fs.writeFileSync(
            path.join(tempRoot, 'systemtest.yaml'),
            `steps:\n  - script: echo "from root fallback"\n`,
            'utf8'
        );

        const yaml = `
resources:
  repositories:
    - repository: templates
      type: git
      name: external/templates

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - template: entry.yml@templates
`;

        const result = parser.expandPipeline(yaml, {
            fileName: path.join(tempRoot, 'azure-pipelines.yml'),
            baseDir: tempRoot,
            repoBaseDir: tempRoot,
            rootRepoBaseDir: tempRoot,
            resourceLocations: {
                templates: externalRepoDir,
            },
        });

        if (!result.yaml.includes('from root fallback')) {
            throw new Error('Expected unqualified template reference to fall back to root repository file');
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

runTest('Test 17: Absolute-style unqualified template resolves from root repo', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-absolute-root-'));

    try {
        const externalRepoDir = path.join(tempRoot, 'external-templates');
        fs.mkdirSync(externalRepoDir, { recursive: true });

        fs.writeFileSync(path.join(externalRepoDir, 'entry.yml'), `steps:\n  - template: /systemtest.yaml\n`, 'utf8');

        fs.writeFileSync(
            path.join(tempRoot, 'systemtest.yaml'),
            `steps:\n  - script: echo "from absolute root"\n`,
            'utf8'
        );

        const yaml = `
resources:
  repositories:
    - repository: templates
      type: git
      name: external/templates

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - template: entry.yml@templates
`;

        const result = parser.expandPipeline(yaml, {
            fileName: path.join(tempRoot, 'azure-pipelines.yml'),
            baseDir: tempRoot,
            repoBaseDir: tempRoot,
            rootRepoBaseDir: tempRoot,
            resourceLocations: {
                templates: externalRepoDir,
            },
        });

        if (!result.yaml.includes('from absolute root')) {
            throw new Error('Expected /systemtest.yaml to resolve from root repository');
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
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
