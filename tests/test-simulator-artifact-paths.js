#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser');
const { PipelineSimulator } = require('../simulator');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;
const parser = new AzurePipelineParser();

console.log('Testing Simulator Artifact Path Expansion\n');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

try {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-sim-artifacts-'));
    const sourcesDir = path.join(tempRoot, 's');
    const stagingDir = path.join(tempRoot, 'a');
    const outputRoot = path.join(tempRoot, '.azure-pipeline-studio', 'simulation');

    fs.mkdirSync(path.join(sourcesDir, 'All'), { recursive: true });
    fs.writeFileSync(path.join(sourcesDir, 'All', 'payload.txt'), 'payload\n', 'utf8');

    const pipeline = `stages:
- stage: Build
  jobs:
  - job: Publish
    steps:
    - task: PublishPipelineArtifact@1
      inputs:
        targetPath: $(Build.SourcesDirectory)
        artifact: TempArtifacts-x64-Release-x64

- stage: Package
  jobs:
  - job: Download
    steps:
    - task: DownloadPipelineArtifact@2
      inputs:
        artifact: TempArtifacts-x64-Release-x64
        targetPath: $(Build.SourcesDirectory)/All

    - task: NuGetCommand@2
      inputs:
        command: pack
        outputDir: \${BUILD_ARTIFACTSTAGINGDIRECTORY}/Packages
`;

    const { document } = parser.expandPipeline(pipeline, {
        fileName: path.join(sourcesDir, 'azure-pipelines.yml'),
        baseDir: sourcesDir,
        templateStack: [path.join(sourcesDir, 'azure-pipelines.yml')],
        azureCompatible: false,
    });

    const simulator = new PipelineSimulator({ outputRoot });
    const results = simulator.simulate(document, {
        workingDirectory: sourcesDir,
        defaultVariables: {
            'Build.Repository.LocalPath': sourcesDir,
            'Build.SourcesDirectory': sourcesDir,
            'Build.ArtifactStagingDirectory': stagingDir,
            'Build.StagingDirectory': path.join(tempRoot, 'staging'),
            'Build.BinariesDirectory': path.join(tempRoot, 'binaries'),
            'Pipeline.Workspace': path.join(tempRoot, 'workspace'),
            'Agent.WorkFolder': path.join(tempRoot, 'agent', 'work'),
            'Agent.BuildDirectory': path.join(tempRoot, 'agent', 'build'),
            'Agent.TempDirectory': path.join(tempRoot, 'agent', 'temp'),
            'Agent.ToolsDirectory': path.join(tempRoot, 'agent', 'tools'),
            'Agent.HomeDirectory': path.join(tempRoot, 'agent', 'home'),
            Simulator: outputRoot,
            'Simulator.OutputRoot': outputRoot,
        },
    });

    if (verbose) {
        console.log(JSON.stringify(results, null, 2));
    }

    const nestedAllPath = path.join(sourcesDir, 'All', 'All');
    const deeplyNestedGitPath = path.join(sourcesDir, 'All', 'All', 'All', '.git');
    assert(!fs.existsSync(nestedAllPath), `Expected no nested All directory, found: ${nestedAllPath}`);
    assert(!fs.existsSync(deeplyNestedGitPath), `Expected no recursive .git nesting, found: ${deeplyNestedGitPath}`);

    const expectedPackageDir = path.join(stagingDir, 'Packages');
    assert(fs.existsSync(expectedPackageDir), `Expected package output dir to exist: ${expectedPackageDir}`);

    const allStdout = results.stages
        .flatMap((stage) => stage.jobs)
        .flatMap((job) => job.steps)
        .map((step) => step.stdout || '')
        .join('\n');

    assert(
        !allStdout.includes('${BUILD_ARTIFACTSTAGINGDIRECTORY}'),
        'Expected ${BUILD_ARTIFACTSTAGINGDIRECTORY} to be expanded in task inputs'
    );

    const checkoutDocument = {
        variables: [
            {
                name: 'Build.Repository.LocalPath',
                value: '$(Build.Repository.LocalPath)/All',
            },
        ],
        stages: [
            {
                stage: 'Build',
                variables: [
                    {
                        name: 'Build.Repository.LocalPath',
                        value: '$(Build.Repository.LocalPath)/All',
                    },
                ],
                jobs: [
                    {
                        job: 'Build',
                        variables: [
                            {
                                name: 'Build.Repository.LocalPath',
                                value: '$(Build.Repository.LocalPath)/All',
                            },
                        ],
                        steps: [
                            {
                                checkout: 'self',
                                path: '$(Build.Repository.LocalPath)',
                            },
                        ],
                    },
                ],
            },
        ],
    };

    const checkoutResults = simulator.simulate(checkoutDocument, {
        workingDirectory: sourcesDir,
        defaultVariables: {
            'Build.Repository.LocalPath': sourcesDir,
            'Build.SourcesDirectory': sourcesDir,
            'Build.ArtifactStagingDirectory': stagingDir,
            'Build.StagingDirectory': path.join(tempRoot, 'staging'),
            'Build.BinariesDirectory': path.join(tempRoot, 'binaries'),
            'Pipeline.Workspace': path.join(tempRoot, 'workspace'),
            'Agent.WorkFolder': path.join(tempRoot, 'agent', 'work'),
            'Agent.BuildDirectory': path.join(tempRoot, 'agent', 'build'),
            'Agent.TempDirectory': path.join(tempRoot, 'agent', 'temp'),
            'Agent.ToolsDirectory': path.join(tempRoot, 'agent', 'tools'),
            'Agent.HomeDirectory': path.join(tempRoot, 'agent', 'home'),
            'Simulator.OutputRoot': outputRoot,
        },
    });

    const checkoutStdout = checkoutResults.stages[0].jobs[0].steps[0].stdout;
    assert(!checkoutStdout.includes('/All/All/All'), `Unexpected nested checkout path: ${checkoutStdout}`);
    assert(
        checkoutStdout.includes('/s/All') || checkoutStdout.includes('\\s\\All'),
        `Expected checkout target under job sources /s/All, got: ${checkoutStdout}`
    );

    const buildArtifactDocument = {
        stages: [
            {
                stage: 'Build',
                jobs: [
                    {
                        job: 'Publish',
                        steps: [
                            {
                                script: 'mkdir -p "$(Build.SourcesDirectory)/All"\necho payload > "$(Build.SourcesDirectory)/All/payload.txt"',
                            },
                            {
                                task: 'PublishBuildArtifacts',
                                inputs: {
                                    PathtoPublish: '$(Build.SourcesDirectory)',
                                    ArtifactName: 'BuildDrop',
                                },
                            },
                        ],
                    },
                ],
            },
            {
                stage: 'Package',
                jobs: [
                    {
                        job: 'Download',
                        steps: [
                            {
                                task: 'DownloadArtifacts',
                                inputs: {
                                    artifactName: 'BuildDrop',
                                    downloadPath: '$(Build.SourcesDirectory)/All',
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    };

    const buildArtifactResults = simulator.simulate(buildArtifactDocument, {
        workingDirectory: sourcesDir,
        defaultVariables: {
            'Build.Repository.LocalPath': sourcesDir,
            'Build.SourcesDirectory': sourcesDir,
            'Build.ArtifactStagingDirectory': stagingDir,
            'Build.StagingDirectory': path.join(tempRoot, 'staging'),
            'Build.BinariesDirectory': path.join(tempRoot, 'binaries'),
            'Pipeline.Workspace': path.join(tempRoot, 'workspace'),
            'Agent.WorkFolder': path.join(tempRoot, 'agent', 'work'),
            'Agent.BuildDirectory': path.join(tempRoot, 'agent', 'build'),
            'Agent.TempDirectory': path.join(tempRoot, 'agent', 'temp'),
            'Agent.ToolsDirectory': path.join(tempRoot, 'agent', 'tools'),
            'Agent.HomeDirectory': path.join(tempRoot, 'agent', 'home'),
            'Simulator.OutputRoot': outputRoot,
        },
    });

    if (verbose) {
        console.log('Build artifact simulation:', JSON.stringify(buildArtifactResults, null, 2));
    }

    const buildArtifactStdout = buildArtifactResults.stages
        .flatMap((stage) => stage.jobs || [])
        .flatMap((job) => job.steps || [])
        .map((step) => step.stdout || '');

    const downloadStepStdout = buildArtifactStdout.find((text) => text.includes('build-artifact download:')) || '';
    assert(downloadStepStdout, 'Expected DownloadArtifacts@1 to produce build-artifact download output');
    assert(
        !downloadStepStdout.includes('/All/All/All'),
        `Unexpected nested download path from DownloadArtifacts@1: ${downloadStepStdout}`
    );
    assert(
        !downloadStepStdout.includes('/All/All'),
        `Unexpected duplicate All segment from DownloadArtifacts@1: ${downloadStepStdout}`
    );

    const expectedBuildArtifactSnapshot = path.join(outputRoot, 'build-artifacts', 'BuildDrop');
    assert(
        fs.existsSync(expectedBuildArtifactSnapshot),
        `Expected build artifact snapshot dir to exist: ${expectedBuildArtifactSnapshot}`
    );

    const expectedDownloadedPayload = path.join(
        outputRoot,
        'workspace',
        'jobs',
        '002-Download',
        's',
        'All',
        'payload.txt'
    );
    assert(
        fs.existsSync(expectedDownloadedPayload),
        `Expected downloaded payload from DownloadArtifacts@1 to exist: ${expectedDownloadedPayload}`
    );

    console.log('✅ PASS\n');
    console.log('======================================================================');
    console.log('✅ Simulator artifact path expansion test completed successfully!');
    console.log('======================================================================\n');

    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.exit(0);
} catch (error) {
    console.error(`❌ FAIL: ${error.message}`);
    if (verbose && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
}
