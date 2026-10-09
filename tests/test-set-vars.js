#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PipelineSimulator } = require('../simulator.js');

let passCount = 0;
let failCount = 0;

function runTest(name, testFn) {
    try {
        testFn();
        console.log(`✅ ${name}`);
        passCount++;
    } catch (error) {
        console.error(`❌ ${name}: ${error.message}`);
        failCount++;
    }
}

runTest('parses local and output variable directives', () => {
    const simulator = new PipelineSimulator();
    const parsed = simulator._parseVsoDirectives(
        [
            '##vso[task.setvariable variable=localValue] local data ',
            '##vso[task.setvariable variable=version;isOutput=true]1.2.3',
            '##vso[task.setvariable issecret=true]ignored',
        ].join('\n')
    );

    assert.deepStrictEqual(parsed, {
        local: { localValue: 'local data' },
        output: { version: '1.2.3' },
    });
});

runTest('propagates variables to later steps and publishes named outputs', () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-set-vars-'));
    try {
        const simulator = new PipelineSimulator({
            mockCatalog: {
                'step:Publish variables': {
                    output: [
                        '##vso[task.setvariable variable=localValue]local-data',
                        '##vso[task.setvariable variable=version;isOutput=true]1.2.3',
                    ].join('\n'),
                },
                'step:Verify variables': (stepResult, variables) => {
                    assert.strictEqual(variables.localValue, 'local-data');
                    assert.strictEqual(variables.version, '1.2.3');
                    assert.strictEqual(variables['publish.version'], '1.2.3');
                    return stepResult;
                },
            },
        });

        const result = simulator._runJob(
            {
                job: 'SetVars',
                steps: [{ name: 'publish', displayName: 'Publish variables' }, { displayName: 'Verify variables' }],
            },
            { 'Pipeline.Workspace': workingDirectory },
            { workingDirectory, libraryVariables: {}, userOverrides: {} }
        );

        assert.strictEqual(result.result, 'Succeeded');
        assert.strictEqual(result.outputVariables['publish.version'], '1.2.3');
    } finally {
        fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
});

console.log(`\n${passCount} set-variable tests passed ✅`);
if (failCount > 0) {
    console.log(`${failCount} set-variable tests failed ❌`);
    process.exit(1);
}
