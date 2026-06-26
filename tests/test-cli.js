#!/usr/bin/env node

/**
 * Tests for CLI command-line interface
 *
 * Covers all CLI entry points:
 *   - liststages, listjobs, liststeps        (pipeline structure queries)
 *   - getscriptinfo                           (step introspection)
 *   - runscript                               (step execution)
 *   - handleExtractTree, handleExtractParams, handleExtractVars  (extractor API)
 *   - formatYaml                              (formatter API)
 *   - formatFilesRecursively                  (recursive formatter API)
 *   - end-to-end CLI via execSync             (full process tests)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const minimist = require('minimist');

const {
    handleListStages,
    handleListJobs,
    handleListSteps,
    handleGetScriptInfo,
    handleRunScript,
    handleExtractTree,
    handleExtractParams,
    handleExtractVars,
    formatYaml,
    formatFilesRecursively,
} = require('../extension.js');

console.log('Testing CLI Command Interface\n');

const argv = minimist(process.argv.slice(2), { boolean: ['v', 'verbose'] });
const verbose = argv.v || argv.verbose;

const DEMO_PIPELINE = path.join(__dirname, 'inputs', 'demo-pipeline.yaml');
const EXTENSION_JS = path.join(__dirname, '..', 'extension.js');

let passCount = 0;
let failCount = 0;

function runTest(name, testFn) {
    console.log(`=== ${name} ===`);
    try {
        testFn();
        console.log('✅ PASS\n');
        passCount++;
    } catch (err) {
        console.log('❌ FAIL: ' + err.message + '\n');
        if (verbose) console.error(err.stack);
        failCount++;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

// ─── handleListStages ────────────────────────────────────────────────────────

runTest('liststages: returns 4 stages from demo pipeline', () => {
    const result = handleListStages([DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.stages.length, 4, 'stage count');
    assertEqual(result.stages[0].name, 'Validate', 'stage 1 name');
    assertEqual(result.stages[1].name, 'Build', 'stage 2 name');
    assertEqual(result.stages[2].name, 'Test', 'stage 3 name');
    assertEqual(result.stages[3].name, 'Package', 'stage 4 name');
    if (verbose) console.log(JSON.stringify(result.stages, null, 2));
});

runTest('liststages: stage numbers are 1-based', () => {
    const result = handleListStages([DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    result.stages.forEach((s, i) => assertEqual(s.number, i + 1, `stage[${i}].number`));
});

runTest('liststages: job counts are correct', () => {
    const result = handleListStages([DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.stages[0].jobCount, 1, 'Validate job count');
    assertEqual(result.stages[1].jobCount, 1, 'Build job count');
    assertEqual(result.stages[2].jobCount, 2, 'Test job count');
    assertEqual(result.stages[3].jobCount, 1, 'Package job count');
});

runTest('liststages: error on missing file', () => {
    const result = handleListStages(['/nonexistent/pipeline.yaml']);
    assert(result.error, 'expected error property');
    assert(result.error.includes('not found'), `error message: ${result.error}`);
});

runTest('liststages: error when no file argument given', () => {
    const result = handleListStages([]);
    assert(result.error, 'expected error property');
});

// ─── handleListJobs ──────────────────────────────────────────────────────────

runTest('listjobs: stage 1 has 1 job (Lint)', () => {
    const result = handleListJobs(['-stage', '1', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.jobs.length, 1, 'job count');
    assertEqual(result.jobs[0].name, 'Lint', 'job name');
    if (verbose) console.log(JSON.stringify(result.jobs, null, 2));
});

runTest('listjobs: stage 2 has 1 job (Compile)', () => {
    const result = handleListJobs(['-stage', '2', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.jobs[0].name, 'Compile', 'job name');
});

runTest('listjobs: stage 3 has 2 jobs (UnitTests, IntegrationTests)', () => {
    const result = handleListJobs(['-stage', '3', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.jobs.length, 2, 'job count');
    assertEqual(result.jobs[0].name, 'UnitTests', 'job 1 name');
    assertEqual(result.jobs[1].name, 'IntegrationTests', 'job 2 name');
});

runTest('listjobs: step counts are correct for Build stage', () => {
    const result = handleListJobs(['-stage', '2', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.jobs[0].stepCount, 5, 'Compile step count');
});

runTest('listjobs: error when stage is out of range', () => {
    const result = handleListJobs(['-stage', '99', DEMO_PIPELINE]);
    assert(result.error, 'expected error property');
    assert(result.error.includes('not found'), `error message: ${result.error}`);
});

runTest('listjobs: error when missing -stage argument', () => {
    const result = handleListJobs([DEMO_PIPELINE]);
    assert(result.error, 'expected error property');
});

runTest('listjobs: error on missing file', () => {
    const result = handleListJobs(['-stage', '1', '/nonexistent/pipeline.yaml']);
    assert(result.error, 'expected error property');
});

// ─── handleListSteps ─────────────────────────────────────────────────────────

runTest('liststeps: stage 1 job 1 has 3 steps', () => {
    const result = handleListSteps(['-stage', '1', '-job', '1', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.steps.length, 3, 'step count');
    if (verbose) console.log(JSON.stringify(result.steps, null, 2));
});

runTest('liststeps: stage 1 job 1 step labels are correct', () => {
    const result = handleListSteps(['-stage', '1', '-job', '1', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.steps[0].label, 'Checkout Source', 'step 1 label');
    assertEqual(result.steps[1].label, 'Run Linter', 'step 2 label');
    assertEqual(result.steps[2].label, 'Format Check', 'step 3 label');
});

runTest('liststeps: stage 3 job 2 (IntegrationTests) has 4 steps', () => {
    const result = handleListSteps(['-stage', '3', '-job', '2', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.steps.length, 4, 'step count');
    assertEqual(result.steps[2].label, 'Run Integration Tests', 'step 3 label');
});

runTest('liststeps: stage 2 job 1 last step is a task type', () => {
    const result = handleListSteps(['-stage', '2', '-job', '1', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    const lastStep = result.steps[result.steps.length - 1];
    assertEqual(lastStep.label, 'Publish Build Artifacts', 'last step label');
    assertEqual(lastStep.type, 'task', 'last step type');
});

runTest('liststeps: step numbers are 1-based', () => {
    const result = handleListSteps(['-stage', '1', '-job', '1', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    result.steps.forEach((s, i) => assertEqual(s.number, i + 1, `step[${i}].number`));
});

runTest('liststeps: error when stage is out of range', () => {
    const result = handleListSteps(['-stage', '99', '-job', '1', DEMO_PIPELINE]);
    assert(result.error, 'expected error property');
});

runTest('liststeps: error when job is out of range', () => {
    const result = handleListSteps(['-stage', '1', '-job', '99', DEMO_PIPELINE]);
    assert(result.error, 'expected error property');
});

runTest('liststeps: error when missing required arguments', () => {
    const result = handleListSteps(['-stage', '1', DEMO_PIPELINE]);
    assert(result.error, 'expected error property');
});

// ─── handleGetScriptInfo ─────────────────────────────────────────────────────

runTest('getscriptinfo: bash step has scriptContent', () => {
    const result = handleGetScriptInfo(['-stage', '1', '-job', '1', '-step', '2', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.stepType, 'bash', 'step type');
    assert(result.scriptContent, 'expected scriptContent');
    assert(result.scriptContent.includes('linter'), `script content: ${result.scriptContent}`);
    if (verbose) console.log('Script content:', result.scriptContent);
});

runTest('getscriptinfo: returns step label and type', () => {
    const result = handleGetScriptInfo(['-stage', '1', '-job', '1', '-step', '2', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assertEqual(result.stepLabel, 'Run Linter', 'step label');
    assertEqual(result.stepType, 'bash', 'step type');
});

runTest('getscriptinfo: task step has taskName and taskInputs', () => {
    const result = handleGetScriptInfo(['-stage', '2', '-job', '1', '-step', '5', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assert(result.taskName, 'expected taskName');
    assert(result.taskName.toLowerCase().includes('publishbuildartifacts'), `taskName: ${result.taskName}`);
    assert(typeof result.taskInputs === 'object', 'expected taskInputs object');
    if (verbose) console.log('Task inputs:', JSON.stringify(result.taskInputs, null, 2));
});

runTest('getscriptinfo: returns referenced runtime variables', () => {
    const result = handleGetScriptInfo(['-stage', '1', '-job', '1', '-step', '2', DEMO_PIPELINE]);
    assert(result.success, 'expected success');
    assert(Array.isArray(result.referencedRuntimeVariables), 'expected array');
    if (verbose) console.log('Runtime vars:', result.referencedRuntimeVariables);
});

runTest('getscriptinfo: error when step is out of range', () => {
    const result = handleGetScriptInfo(['-stage', '1', '-job', '1', '-step', '99', DEMO_PIPELINE]);
    assert(result.error, 'expected error property');
});

runTest('getscriptinfo: error on missing file', () => {
    const result = handleGetScriptInfo(['-stage', '1', '-job', '1', '-step', '1', '/nonexistent.yaml']);
    assert(result.error, 'expected error property');
});

// ─── handleRunScript ─────────────────────────────────────────────────────────

runTest('runscript: executes bash step and captures output', () => {
    const result = handleRunScript(['-stage', '1', '-job', '1', '-step', '2', DEMO_PIPELINE]);
    assert(result.success !== undefined, 'expected success/failure property');
    if (result.success) {
        assert(typeof result.output === 'string', 'expected output string');
        assert(result.output.includes('linter'), `output: ${result.output}`);
    } else {
        // Script execution may not be available in all environments; skip output check
        if (verbose) console.log('runscript not available in this environment:', result.error);
    }
    if (verbose) console.log('runscript output:', result.output);
});

runTest('runscript: returns step location metadata', () => {
    const result = handleRunScript(['-stage', '1', '-job', '1', '-step', '2', DEMO_PIPELINE]);
    assertEqual(result.stage, 1, 'stage');
    assertEqual(result.job, 1, 'job');
    assertEqual(result.step, 2, 'step');
});

runTest('runscript: error on non-executable step (task)', () => {
    const result = handleRunScript(['-stage', '2', '-job', '1', '-step', '5', DEMO_PIPELINE]);
    assert(result.error || result.success === false, 'expected error for task step');
});

runTest('runscript: error on missing file', () => {
    const result = handleRunScript(['-stage', '1', '-job', '1', '-step', '2', '/nonexistent.yaml']);
    assert(result.error, 'expected error property');
});

// ─── handleExtractTree / Params / Vars ───────────────────────────────────────

runTest('handleExtractTree: returns stage tree from demo pipeline', () => {
    const result = handleExtractTree(DEMO_PIPELINE);
    assert(!result.error, `unexpected error: ${result.error}`);
    assert(Array.isArray(result.stages), 'expected stages array');
    assertEqual(result.stages.length, 4, 'stage count');
    if (verbose)
        console.log(
            'Stages:',
            result.stages.map((s) => s.displayName)
        );
});

runTest('handleExtractParams: returns 3 parameter definitions', () => {
    const result = handleExtractParams(DEMO_PIPELINE);
    assert(!result.error, `unexpected error: ${result.error}`);
    assert(Array.isArray(result.parameters), 'expected parameters array');
    assertEqual(result.parameters.length, 3, 'parameter count');
    const names = result.parameters.map((p) => p.name);
    assert(names.includes('environment'), 'expected environment param');
    assert(names.includes('runIntegrationTests'), 'expected runIntegrationTests param');
    assert(names.includes('appVersion'), 'expected appVersion param');
    if (verbose) console.log('Parameters:', JSON.stringify(result.parameters, null, 2));
});

runTest('handleExtractVars: returns pipeline variables', () => {
    const result = handleExtractVars(DEMO_PIPELINE);
    assert(!result.error, `unexpected error: ${result.error}`);
    assert(Array.isArray(result.simpleVariables), 'expected simpleVariables array');
    const names = result.simpleVariables.map((v) => v.name);
    assert(names.includes('appName'), 'expected appName variable');
    assert(names.includes('nodeVersion'), 'expected nodeVersion variable');
    if (verbose) console.log('Variables:', result.simpleVariables);
});

// ─── formatYaml ──────────────────────────────────────────────────────────────

runTest('formatYaml: formats demo pipeline without error', () => {
    const source = fs.readFileSync(DEMO_PIPELINE, 'utf8');
    const result = formatYaml(source, { fileName: DEMO_PIPELINE });
    assert(!result.error, `unexpected error: ${result.error}`);
    assert(typeof result.text === 'string', 'expected text string');
    assert(result.text.length > 0, 'expected non-empty output');
    if (verbose) console.log('Formatted length:', result.text.length);
});

runTest('formatYaml: output is idempotent (format twice = same result)', () => {
    const source = fs.readFileSync(DEMO_PIPELINE, 'utf8');
    const first = formatYaml(source, { fileName: DEMO_PIPELINE });
    assert(!first.error, `first pass error: ${first.error}`);
    const second = formatYaml(first.text, { fileName: DEMO_PIPELINE });
    assert(!second.error, `second pass error: ${second.error}`);
    assertEqual(first.text, second.text, 'idempotent output');
});

runTest('formatYaml: preserves stage and job names', () => {
    const source = fs.readFileSync(DEMO_PIPELINE, 'utf8');
    const result = formatYaml(source, { fileName: DEMO_PIPELINE });
    assert(result.text.includes('Validate'), 'expected Validate stage');
    assert(result.text.includes('Build'), 'expected Build stage');
    assert(result.text.includes('Test'), 'expected Test stage');
    assert(result.text.includes('Package'), 'expected Package stage');
});

// ─── formatFilesRecursively ───────────────────────────────────────────────────

runTest('formatFilesRecursively: processes demo pipeline file', () => {
    const tmpDir = fs.mkdtempSync('/tmp/aps-test-');
    try {
        const tmpFile = path.join(tmpDir, 'demo.yaml');
        fs.copyFileSync(DEMO_PIPELINE, tmpFile);
        const result = formatFilesRecursively([tmpDir], ['.yml', '.yaml'], {});
        assert(result.totalFiles >= 1, 'expected at least 1 file processed');
        assert(!result.errors.length, `unexpected errors: ${JSON.stringify(result.errors)}`);
        if (verbose) console.log('Processed:', result.totalFiles, 'Formatted:', result.formattedFiles.length);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

runTest('formatFilesRecursively: reports error on unreadable path', () => {
    const result = formatFilesRecursively(['/nonexistent/path'], ['.yaml'], {});
    assert(result.errors.length > 0, 'expected at least one error');
});

// ─── End-to-end CLI via execSync ─────────────────────────────────────────────

function runCli(args) {
    return execSync(`node "${EXTENSION_JS}" ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function runCliExpectFail(args) {
    try {
        execSync(`node "${EXTENSION_JS}" ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        throw new Error('Expected non-zero exit but process succeeded');
    } catch (err) {
        if (err.message === 'Expected non-zero exit but process succeeded') throw err;
        return { stdout: err.stdout || '', stderr: err.stderr || '', status: err.status };
    }
}

runTest('CLI liststages: outputs all 4 stages', () => {
    const out = runCli(`liststages "${DEMO_PIPELINE}"`);
    assert(out.includes('Validate'), 'expected Validate');
    assert(out.includes('Build'), 'expected Build');
    assert(out.includes('Test'), 'expected Test');
    assert(out.includes('Package'), 'expected Package');
    if (verbose) console.log(out);
});

runTest('CLI listjobs: outputs jobs for stage 3', () => {
    const out = runCli(`listjobs -stage 3 "${DEMO_PIPELINE}"`);
    assert(out.includes('Unit Tests'), 'expected Unit Tests');
    assert(out.includes('Integration Tests'), 'expected Integration Tests');
    if (verbose) console.log(out);
});

runTest('CLI liststeps: outputs steps for stage 1 job 1', () => {
    const out = runCli(`liststeps -stage 1 -job 1 "${DEMO_PIPELINE}"`);
    assert(out.includes('Run Linter'), 'expected Run Linter step');
    assert(out.includes('Format Check'), 'expected Format Check step');
    if (verbose) console.log(out);
});

runTest('CLI getscriptinfo: outputs JSON with scriptContent for bash step', () => {
    const out = runCli(`getscriptinfo -stage 1 -job 1 -step 2 "${DEMO_PIPELINE}"`);
    const json = JSON.parse(out);
    assert(json.success, 'expected success');
    assert(
        json.scriptContent && json.scriptContent.includes('linter'),
        `expected script content, got: ${json.scriptContent}`
    );
    if (verbose) console.log(JSON.stringify(json, null, 2));
});

runTest('CLI expand-templates: expands demo pipeline to stdout', () => {
    const out = runCli(`--expand-templates "${DEMO_PIPELINE}"`);
    assert(out.includes('stages:'), 'expected stages key');
    assert(out.includes('Validate'), 'expected Validate stage');
    if (verbose) console.log('Expanded length:', out.length);
});

runTest('CLI liststages: non-zero exit on missing file', () => {
    const result = runCliExpectFail('liststages /nonexistent/pipeline.yaml');
    assert(result.status !== 0, 'expected non-zero exit code');
});

runTest('CLI listjobs: non-zero exit on missing -stage', () => {
    const result = runCliExpectFail(`listjobs "${DEMO_PIPELINE}"`);
    assert(result.status !== 0, 'expected non-zero exit code');
});

runTest('CLI --list-build-outputs: error on pipeline with no build tasks', () => {
    const result = runCliExpectFail(`--list-build-outputs "${DEMO_PIPELINE}"`);
    assert(result.status !== 0, 'expected non-zero exit for pipeline without build tasks');
    if (verbose) console.log('stderr:', result.stderr);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('='.repeat(50));
console.log(`Results: ${passCount} passed, ${failCount} failed`);
console.log('='.repeat(50));

if (failCount > 0) {
    process.exitCode = 1;
}
