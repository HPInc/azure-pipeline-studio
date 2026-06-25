'use strict';

/**
 * Step Inputs Module for Azure Pipeline Studio
 * Extracts step definitions, their inputs (parameters, variables, environment),
 * and provides utilities for unit testing individual steps with various inputs.
 *
 * Supports:
 * - VS Code extension UI (accessing step inputs)
 * - CLI operations (embedded in extension.js)
 * - Unit testing (preparing test inputs with overrides)
 */

const DEFAULT_COMPILE_TIME_VARIABLES = Object.freeze({
    'Build.Reason': 'Manual',
    'Build.SourceBranch': 'refs/heads/main',
});

// ============================================================================
// VARIABLE HANDLING
// ============================================================================

function normalizeCompileTimeVariables(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    return Object.fromEntries(Object.entries(input));
}

function applyDefaultBuildVariables(baseVariables) {
    const settingsOrCliVariables = normalizeCompileTimeVariables(baseVariables);
    const result = { ...settingsOrCliVariables };

    Object.entries(DEFAULT_COMPILE_TIME_VARIABLES).forEach(([key, defaultValue]) => {
        if (!Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = defaultValue;
        }
    });

    return result;
}

function printCompileTimeVariableSources(contextLabel, settingsVariables, commandLineVariables, effectiveVariables) {
    const report = {
        defaults: { ...DEFAULT_COMPILE_TIME_VARIABLES },
        settingsJson: normalizeCompileTimeVariables(settingsVariables),
        commandLine: normalizeCompileTimeVariables(commandLineVariables),
        effective: normalizeCompileTimeVariables(effectiveVariables),
    };

    const formattedReport = JSON.stringify(report, null, 2);
    console.error(`[APS] Compile-time variable sources (${contextLabel}):\n${formattedReport}`);
}

// ============================================================================
// PATH AND CONTEXT UTILITIES
// ============================================================================

function toSimulatorPath(p) {
    if (!p || typeof p !== 'string') return p || '';
    const m = p.match(/^\\\\wsl\.localhost\\[^\\]+(.*)/i);
    if (m) return m[1].replace(/\\/g, '/');
    return p;
}

function resolveExecPaths(rawPaths, isLinuxContext) {
    if (!rawPaths || typeof rawPaths !== 'object') return {};
    const osKey = isLinuxContext ? 'linux' : 'windows';
    const osSpecific = rawPaths[osKey];
    if (!osSpecific || typeof osSpecific !== 'object') return {};
    const result = {};
    for (const [key, value] of Object.entries(osSpecific)) {
        if (typeof value === 'string') result[key] = value;
    }
    return result;
}

function isLinuxSimulationContext(documentFileName) {
    if (process.platform !== 'win32') return true;
    return /^\\\\wsl\.localhost\\/i.test(documentFileName || '');
}

// ============================================================================
// STEP EXTRACTION - STRUCTURE
// ============================================================================

/**
 * Extract a structured tree of stages, jobs, and steps from a parsed document.
 * Maps each step with its type and metadata.
 */
function extractSimulationTree(document) {
    const mapSteps = (steps) =>
        (Array.isArray(steps) ? steps : []).map((step, i) => {
            const type = step.task
                ? 'task'
                : step.bash
                  ? 'bash'
                  : step.script
                    ? 'script'
                    : step.pwsh
                      ? 'pwsh'
                      : step.powershell
                        ? 'powershell'
                        : step.checkout
                          ? 'checkout'
                          : step.publish
                            ? 'publish'
                            : step.download
                              ? 'download'
                              : 'step';
            const label =
                step.displayName ||
                step.name ||
                (step.task
                    ? String(step.task).split('@')[0]
                    : step.bash
                      ? 'Bash'
                      : step.script
                        ? 'Script'
                        : step.pwsh || step.powershell
                          ? 'PowerShell'
                          : step.checkout
                            ? `Checkout: ${step.checkout}`
                            : step.publish
                              ? 'Publish artifact'
                              : step.download
                                ? 'Download artifact'
                                : `Step ${i + 1}`);
            return {
                label,
                type,
                scriptContent: String(step.bash || step.script || step.pwsh || step.powershell || ''),
                taskName: step.task ? String(step.task) : '',
                taskInputsJson: step.inputs && typeof step.inputs === 'object' ? JSON.stringify(step.inputs) : '{}',
                stepEnv: step.env && typeof step.env === 'object' ? { ...step.env } : {},
                rawStep: step,
                templateParams: Array.isArray(step.__templateParams) ? step.__templateParams : null,
            };
        });

    const mapJobs = (jobs) =>
        (Array.isArray(jobs) ? jobs : []).map((j) => ({
            name: j.job || j.deployment || 'Job',
            displayName: j.displayName || j.job || j.deployment || 'Job',
            isDeployment: !!j.deployment,
            steps: mapSteps(j.steps),
        }));

    const stages = Array.isArray(document.stages) ? document.stages : [];
    if (stages.length === 0 && Array.isArray(document.jobs)) {
        return [{ name: '__default__', displayName: '(Pipeline)', jobs: mapJobs(document.jobs) }];
    }
    return stages.map((s) => ({
        name: s.stage || 'Stage',
        displayName: s.displayName || s.stage || 'Stage',
        jobs: mapJobs(s.jobs),
    }));
}

// ============================================================================
// PARAMETER EXTRACTION
// ============================================================================

function extractTopLevelParameterDefinitions(parser, sourceText, skipSyntaxCheck) {
    if (!parser || typeof parser.parseYamlDocument !== 'function') {
        return [];
    }

    let jsonDoc;
    try {
        ({ jsonDoc } = parser.parseYamlDocument(sourceText, undefined, !!skipSyntaxCheck));
    } catch (_) {
        return [];
    }

    if (!jsonDoc || typeof jsonDoc !== 'object' || !jsonDoc.parameters) {
        return [];
    }

    const toType = (rawType, fallback) => {
        const normalized = String(rawType || fallback || 'string')
            .trim()
            .toLowerCase();
        return normalized || 'string';
    };

    const normalizeArrayOrNull = (input) =>
        Array.isArray(input) ? input.map((entry) => (entry === undefined || entry === null ? '' : entry)) : null;

    const defs = [];
    const parametersNode = jsonDoc.parameters;

    if (Array.isArray(parametersNode)) {
        for (const item of parametersNode) {
            if (!item || typeof item !== 'object' || !item.name) {
                continue;
            }

            const hasDefault = Object.prototype.hasOwnProperty.call(item, 'default');
            defs.push({
                name: String(item.name),
                type: toType(item.type, 'string'),
                hasDefault,
                defaultValue: hasDefault ? item.default : '',
                values: normalizeArrayOrNull(item.values),
            });
        }
        return defs;
    }

    if (typeof parametersNode === 'object') {
        for (const [name, item] of Object.entries(parametersNode)) {
            if (!name || !String(name).trim()) {
                continue;
            }

            if (item && typeof item === 'object' && !Array.isArray(item)) {
                const hasDefault =
                    Object.prototype.hasOwnProperty.call(item, 'default') ||
                    Object.prototype.hasOwnProperty.call(item, 'value');
                const defaultValue = Object.prototype.hasOwnProperty.call(item, 'default') ? item.default : item.value;
                defs.push({
                    name: String(name),
                    type: toType(item.type, 'string'),
                    hasDefault,
                    defaultValue: hasDefault ? defaultValue : '',
                    values: normalizeArrayOrNull(item.values),
                });
                continue;
            }

            defs.push({
                name: String(name),
                type: toType(typeof item, 'string'),
                hasDefault: item !== undefined,
                defaultValue: item === undefined ? '' : item,
                values: null,
            });
        }
    }

    return defs;
}

// Prefixes that identify compile-time (predefined) pipeline variables
const COMPILE_TIME_VAR_PREFIXES = ['Build.', 'System.', 'Agent.', 'Pipeline.'];

// Mapping from bash env var name to Azure variable name for known system variables.
// Azure DevOps exposes pipeline variables as env vars by uppercasing and replacing . with _.
// This reverse map lets us detect direct bash ${ENV_VAR} references in scripts.
const AZURE_ENV_VAR_NAMES = Object.freeze({
    BUILD_SOURCEBRANCH: 'Build.SourceBranch',
    BUILD_SOURCEBRANCHNAME: 'Build.SourceBranchName',
    BUILD_REASON: 'Build.Reason',
    BUILD_BUILDID: 'Build.BuildId',
    BUILD_BUILDNUMBER: 'Build.BuildNumber',
    BUILD_SOURCESDIRECTORY: 'Build.SourcesDirectory',
    BUILD_REPOSITORY_LOCALPATH: 'Build.Repository.LocalPath',
    BUILD_ARTIFACTSTAGINGDIRECTORY: 'Build.ArtifactStagingDirectory',
    BUILD_STAGINGDIRECTORY: 'Build.StagingDirectory',
    BUILD_BINARIESDIRECTORY: 'Build.BinariesDirectory',
    BUILD_DEFINITIONNAME: 'Build.DefinitionName',
    BUILD_REQUESTEDFOR: 'Build.RequestedFor',
    BUILD_REQUESTEDFOREMAIL: 'Build.RequestedForEmail',
    BUILD_SOURCEVERSION: 'Build.SourceVersion',
    BUILD_SOURCEVERSIONMESSAGE: 'Build.SourceVersionMessage',
    SYSTEM_DEBUG: 'System.Debug',
    SYSTEM_TEAMPROJECT: 'System.TeamProject',
    SYSTEM_DEFAULTWORKINGDIRECTORY: 'System.DefaultWorkingDirectory',
    SYSTEM_ACCESSTOKEN: 'System.AccessToken',
    SYSTEM_PULLREQUEST_SOURCEBRANCH: 'System.PullRequest.SourceBranch',
    SYSTEM_PULLREQUEST_TARGETBRANCH: 'System.PullRequest.TargetBranch',
    SYSTEM_PULLREQUEST_PULLREQUESTID: 'System.PullRequest.PullRequestId',
    SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: 'System.PullRequest.PullRequestNumber',
    AGENT_OS: 'Agent.OS',
    AGENT_OSARCHITECTURE: 'Agent.OSArchitecture',
    AGENT_TEMPDIRECTORY: 'Agent.TempDirectory',
    AGENT_TOOLSDIRECTORY: 'Agent.ToolsDirectory',
    AGENT_WORKFOLDER: 'Agent.WorkFolder',
    AGENT_BUILDDIRECTORY: 'Agent.BuildDirectory',
    PIPELINE_WORKSPACE: 'Pipeline.Workspace',
});

/**
 * Unified scanner: finds all ${{ parameters.X }} and $(VAR) references across
 * all relevant string fields of a step (script, displayName, condition, env,
 * inputs, template parameters).
 */
function scanStepForReferences(step) {
    const parameters = new Set();
    const compileTimeVars = new Set();
    const runtimeVars = new Set();

    function scanText(text) {
        if (typeof text !== 'string' || !text) return;
        for (const m of text.matchAll(/\$\{\{\s*parameters\.(\w+)\s*\}\}/g)) {
            parameters.add(m[1]);
        }
        for (const m of text.matchAll(/\$\(\s*(\w+(?:\.\w+)*)\s*\)/g)) {
            const varName = m[1];
            if (COMPILE_TIME_VAR_PREFIXES.some((p) => varName.startsWith(p))) {
                compileTimeVars.add(varName);
            } else {
                runtimeVars.add(varName);
            }
        }
        // Detect bash env var references (${VAR}, ${VAR:-default}, ${VAR@modifier}, $VAR)
        // and map known Azure system variable env names back to their dot-notation names.
        for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]+)|\$([A-Z][A-Z0-9_]+)\b/g)) {
            const envVarName = m[1] || m[2];
            const azureName = AZURE_ENV_VAR_NAMES[envVarName];
            if (azureName) compileTimeVars.add(azureName);
        }
    }

    function scanValues(obj) {
        if (!obj || typeof obj !== 'object') return;
        for (const v of Object.values(obj)) {
            scanText(typeof v === 'string' ? v : v != null && typeof v !== 'object' ? String(v) : null);
        }
    }

    if (!step) return { parameters: [], compileTimeVars: [], runtimeVars: [] };

    scanText(step.bash || step.script || step.pwsh || step.powershell || '');
    scanText(step.displayName);
    scanText(step.condition);
    scanValues(step.inputs);
    scanValues(step.env);
    // For template steps: scan parameter values passed to the template
    if (step.parameters && typeof step.parameters === 'object' && !Array.isArray(step.parameters)) {
        scanValues(step.parameters);
    }

    return {
        parameters: Array.from(parameters),
        compileTimeVars: Array.from(compileTimeVars),
        runtimeVars: Array.from(runtimeVars),
    };
}

/**
 * Substitute ${{ parameters.NAME }} expressions in text with provided values.
 * Unresolved references are left as-is.
 */
function substituteTemplateExpressions(text, paramValues) {
    if (typeof text !== 'string' || !paramValues) return text;
    return text.replace(/\$\{\{\s*parameters\.(\w+)\s*\}\}/g, (match, name) => {
        return Object.prototype.hasOwnProperty.call(paramValues, name) ? String(paramValues[name]) : match;
    });
}

/**
 * Extract parameters referenced in a step's script or inputs.
 * Returns parameter names that appear as ${{ parameters.NAME }}
 */
function extractReferencedParameters(step) {
    return scanStepForReferences(step).parameters;
}

// ============================================================================
// VARIABLE EXTRACTION
// ============================================================================

function extractPipelineVariables(parsedDoc) {
    const simple = [];
    const groups = [];
    if (!parsedDoc || typeof parsedDoc !== 'object') return { simple, groups };
    const vars = parsedDoc.variables;
    if (Array.isArray(vars)) {
        for (const entry of vars) {
            if (!entry || typeof entry !== 'object') continue;
            if (typeof entry.group === 'string' && entry.group.trim()) {
                groups.push(entry.group.trim());
            } else if (typeof entry.name === 'string' && entry.name.trim()) {
                simple.push({
                    name: entry.name.trim(),
                    value: entry.value !== undefined ? String(entry.value) : '',
                });
            }
        }
    } else if (vars && typeof vars === 'object') {
        for (const [name, value] of Object.entries(vars)) {
            if (name && name.trim()) {
                simple.push({ name: name.trim(), value: value !== undefined ? String(value) : '' });
            }
        }
    }
    return { simple, groups };
}

/**
 * Extract variables referenced in a step's script or inputs.
 * Returns variable names that appear as $(VARIABLE_NAME)
 */
function extractReferencedVariables(step) {
    const refs = scanStepForReferences(step);
    return { compileTime: refs.compileTimeVars, runtime: refs.runtimeVars };
}

// ============================================================================
// STEP INPUTS FOR TESTING
// ============================================================================

/**
 * Extract all inputs for a specific step including parameters, variables, and environment.
 * Useful for unit testing individual steps with different input combinations.
 */
function extractStepInputs(step, allParameterDefs = [], allVariables = {}, allSystemVariables = {}) {
    if (!step) return null;

    const refs = scanStepForReferences(step);
    const referencedParamNames = new Set(refs.parameters);

    // All parameter definitions, flagged by whether the step actually references them
    const parameterDefinitions = allParameterDefs.map((p) => ({
        ...p,
        isReferenced: referencedParamNames.has(p.name),
    }));

    // Build parameter values from defaults for referenced params
    const parameterValues = {};
    allParameterDefs.forEach((p) => {
        if (referencedParamNames.has(p.name)) {
            parameterValues[p.name] = p.hasDefault ? p.defaultValue : '';
        }
    });

    // Collect referenced compile-time variable values
    const compileTimeVariableValues = {};
    refs.compileTimeVars.forEach((varName) => {
        if (allSystemVariables[varName] !== undefined) {
            compileTimeVariableValues[varName] = allSystemVariables[varName];
        }
    });

    // Collect referenced runtime variable values
    const runtimeVariableValues = {};
    refs.runtimeVars.forEach((varName) => {
        if (allVariables[varName] !== undefined) {
            runtimeVariableValues[varName] = allVariables[varName];
        }
    });

    const scriptContent = String(step.bash || step.script || step.pwsh || step.powershell || '');

    return {
        stepLabel: step.displayName || step.name || 'Step',
        stepType: extractStepType(step),
        referencedParameters: refs.parameters,
        parameterDefinitions,
        parameterValues,
        referencedCompileTimeVariables: refs.compileTimeVars,
        compileTimeVariableValues,
        referencedRuntimeVariables: refs.runtimeVars,
        runtimeVariableValues,
        stepEnvironment: step.env || {},
        scriptContent,
        taskName: step.task ? String(step.task) : '',
        taskInputs: step.inputs || {},
    };
}

/**
 * Prepare test inputs for a step with optional overrides.
 * Returns a complete set of inputs ready for unit testing.
 */
function prepareStepTestInputs(
    step,
    allParameterDefs = [],
    allVariables = {},
    allSystemVariables = {},
    overrides = {}
) {
    const stepInputs = extractStepInputs(step, allParameterDefs, allVariables, allSystemVariables);
    if (!stepInputs) return null;

    // Apply overrides
    const testInputs = {
        ...stepInputs,
        parameterValues: { ...stepInputs.parameterValues },
        compileTimeVariableValues: { ...stepInputs.compileTimeVariableValues },
        runtimeVariableValues: { ...stepInputs.runtimeVariableValues },
        stepEnvironment: { ...stepInputs.stepEnvironment },
    };

    if (overrides.parameters) Object.assign(testInputs.parameterValues, overrides.parameters);
    if (overrides.compileTimeVariables)
        Object.assign(testInputs.compileTimeVariableValues, overrides.compileTimeVariables);
    if (overrides.runtimeVariables) Object.assign(testInputs.runtimeVariableValues, overrides.runtimeVariables);
    if (overrides.environment) Object.assign(testInputs.stepEnvironment, overrides.environment);

    // Resolve compile-time ${{ parameters.X }} expressions in the script using the final parameter values
    testInputs.resolvedScriptContent = substituteTemplateExpressions(
        testInputs.scriptContent,
        testInputs.parameterValues
    );

    return testInputs;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function buildSimulationDefaultVariables(workingDirectory, outputRoot, buildCounter, extra) {
    const out = outputRoot.replace(/[/\\]$/, '').replace(/\\/g, '/');
    return {
        'Build.Repository.LocalPath': workingDirectory,
        'Build.SourcesDirectory': workingDirectory,
        'System.DefaultWorkingDirectory': workingDirectory,
        'Build.ArtifactStagingDirectory': out + '/artifacts',
        'Build.StagingDirectory': out + '/staging',
        'Build.BinariesDirectory': out + '/binaries',
        'Pipeline.Workspace': out + '/workspace',
        'Agent.WorkFolder': out + '/agent/work',
        'Agent.BuildDirectory': out + '/agent/build',
        'Agent.TempDirectory': out + '/agent/temp',
        'Agent.ToolsDirectory': out + '/agent/tools',
        'Agent.HomeDirectory': out + '/agent/home',
        'Simulator.OutputRoot': out,
        buildCounter: buildCounter || '1',
        ...extra,
    };
}

function extractStepType(step) {
    if (!step) return 'step';
    if (step.template) return 'template';
    if (step.task) return 'task';
    if (step.bash) return 'bash';
    if (step.script) return 'script';
    if (step.pwsh) return 'pwsh';
    if (step.powershell) return 'powershell';
    if (step.checkout) return 'checkout';
    if (step.publish) return 'publish';
    if (step.download) return 'download';
    return 'step';
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Constants
    DEFAULT_COMPILE_TIME_VARIABLES,
    COMPILE_TIME_VAR_PREFIXES,

    // Variable handling
    normalizeCompileTimeVariables,
    applyDefaultBuildVariables,
    printCompileTimeVariableSources,

    // Path and context utilities
    toSimulatorPath,
    resolveExecPaths,
    isLinuxSimulationContext,

    // Step extraction - structure
    extractSimulationTree,

    // Parameter extraction
    extractTopLevelParameterDefinitions,
    extractReferencedParameters,

    // Variable extraction
    extractPipelineVariables,
    extractReferencedVariables,

    // Unified reference scanning and expression substitution
    scanStepForReferences,
    substituteTemplateExpressions,

    // Step inputs for testing
    extractStepInputs,
    prepareStepTestInputs,

    // Utilities
    buildSimulationDefaultVariables,
    extractStepType,
};
