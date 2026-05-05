#!/usr/bin/env node

const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser');
const { PipelineSimulator } = require('../simulator');

const parser = new AzurePipelineParser();
const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

console.log('Testing Simulator Library Variables\n');

function runTest(name, sourceText, libraryVariables, assertion) {
    console.log(`=== ${name} ===`);

    const { document } = parser.expandPipeline(sourceText, {
        fileName: 'simulator-library-variables.yaml',
        baseDir: process.cwd(),
        templateStack: ['simulator-library-variables.yaml'],
        azureCompatible: false,
    });

    const simulator = new PipelineSimulator();
    const results = simulator.simulate(document, {
        libraryVariables,
        workingDirectory: process.cwd(),
    });

    if (verbose) {
        console.log(JSON.stringify(results, null, 2));
    }

    assertion(results);
    console.log('✅ PASS\n');
}

try {
    runTest(
        'Library group variables flow into simulation steps',
        `variables:
- group: SharedVars

stages:
- stage: Build
  jobs:
  - job: Verify
    steps:
    - script: echo "$(username)|$(feedName)"
      displayName: Echo library variables
`,
        {
            SharedVars: {
                username: 'local-user',
                feedName: 'local-feed',
            },
        },
        (results) => {
            const stdout = results.stages[0].jobs[0].steps[0].stdout;
            if (!stdout.includes('local-user|local-feed')) {
                throw new Error(`Expected script output to include library variables, got: ${stdout}`);
            }
        }
    );

    runTest(
        'Pipeline variables can reference earlier library group values',
        `variables:
- group: SharedVars
- name: greeting
  value: hello $(username)

stages:
- stage: Build
  jobs:
  - job: Verify
    steps:
    - script: echo "$(greeting)|$(token)"
      displayName: Echo derived variables
`,
        {
            SharedVars: {
                username: 'ado-user',
                token: 'secret-token',
            },
        },
        (results) => {
            const stdout = results.stages[0].jobs[0].steps[0].stdout;
            if (!stdout.includes('hello ado-user|secret-token')) {
                throw new Error(`Expected derived variable output, got: ${stdout}`);
            }
        }
    );

    runTest(
        'Missing library groups do not fail simulation',
        `variables:
- group: MissingGroup

stages:
- stage: Build
  jobs:
  - job: Verify
    steps:
    - script: echo "done"
      displayName: Missing group is ignored
`,
        {},
        (results) => {
            const step = results.stages[0].jobs[0].steps[0];
            if (step.result !== 'Succeeded') {
                throw new Error(`Expected step to succeed when group is missing, got: ${step.result}`);
            }
            if (!step.stdout.includes('done')) {
                throw new Error(`Expected normal script output when group is missing, got: ${step.stdout}`);
            }
        }
    );

    console.log('======================================================================');
    console.log('✅ Simulator library variable tests completed successfully!');
    console.log('======================================================================\n');
    process.exit(0);
} catch (error) {
    console.error(`❌ FAIL: ${error.message}`);
    if (verbose && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
}
