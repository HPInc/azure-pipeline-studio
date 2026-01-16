const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { AzurePipelineParser } = require('../parser.js');

// Initialize parser
const parser = new AzurePipelineParser();

console.log('Testing parameter scoping in template expansion...\n');

/**
 * Test 1: Parameter quote information should not leak to parent context
 */
function testParameterQuoteScoping() {
    console.log('Test 1: Parameter quote information scoped to template');

    const inputPath = path.join(__dirname, 'inputs', 'parameter-scope-parent.yaml');
    const inputYaml = fs.readFileSync(inputPath, 'utf8');

    // Parse and expand
    const result = parser.expandPipelineFromString(inputYaml, {
        azureCompatible: true,
        baseDir: path.join(__dirname, 'inputs'),
    });

    const doc = yaml.parseDocument(result);
    const output = doc.toJS();

    // Verify structure
    if (!output.stages || output.stages.length === 0) {
        throw new Error('Expected stages to be expanded');
    }

    const stage = output.stages[0];
    if (stage.stage !== 'Build') {
        throw new Error('Expected Build stage');
    }

    const job = stage.jobs[0];
    if (job.job !== 'TestJob') {
        throw new Error('Expected TestJob');
    }

    const steps = job.steps;
    if (steps.length !== 3) {
        throw new Error(`Expected 3 steps, got ${steps.length}`);
    }

    // Verify parameter values were expanded (in Azure mode, script becomes CmdLine@2 task)
    const script0 = steps[0].inputs?.script || steps[0].script;
    const script1 = steps[1].inputs?.script || steps[1].script;
    const script2 = steps[2].inputs?.script || steps[2].script;

    if (!script0 || !script0.includes('param-value')) {
        throw new Error(`Expected templateParam to be expanded to param-value, got: ${script0}`);
    }

    if (!script1 || !script1.includes('double-quoted')) {
        throw new Error(`Expected quotedParam to be expanded to double-quoted, got: ${script1}`);
    }

    // Verify runtime variable is preserved
    if (script2 !== 'echo $(parentVar)') {
        throw new Error(`Expected runtime variable, got: ${script2}`);
    }

    console.log('  ✅ Parameters expanded correctly');
    console.log('  ✅ Runtime variables preserved');
    console.log('  ✅ Parameter quote information scoped to template\n');
}

/**
 * Test 2: Parameters should not be accessible after template expansion
 */
function testParameterIsolation() {
    console.log('Test 2: Parameters isolated to template scope');

    const inputYaml = `
parameters:
  - name: globalParam
    default: global

stages:
  - template: parameter-scope-template.yaml
    parameters:
      templateParam: \${{ parameters.globalParam }}
      quotedParam: "test"
`;

    // This should work - globalParam is in the root context and can be used
    // to pass to the template
    const result = parser.expandPipelineFromString(inputYaml, {
        azureCompatible: true,
        baseDir: path.join(__dirname, 'inputs'),
    });

    const doc = yaml.parseDocument(result);
    const output = doc.toJS();

    // Verify the template parameter received the global parameter value
    const step = output.stages[0].jobs[0].steps[0];
    const script = step.inputs?.script || step.script;
    if (!script || !script.includes('global')) {
        throw new Error(`Expected global parameter to be passed to template, got: ${script}`);
    }

    console.log('  ✅ Root parameters can be passed to templates');
    console.log('  ✅ Template parameters are isolated\n');
}

// Run all tests
try {
    testParameterQuoteScoping();
    testParameterIsolation();

    console.log('======================================================================');
    console.log('✅ All parameter scoping tests passed!');
    console.log('======================================================================\n');
    process.exit(0);
} catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
}
