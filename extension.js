const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

// Import utility functions and formatter
const { pickFirstString, resolveConfiguredPath, normalizeExtension } = require('./utils');
const { PipelineSimulator, printSimulationResults } = require('./simulator');
const { formatYaml } = require('./formatter');
const { DependencyAnalyzer } = require('./dependency-analyzer');

let vscode;
try {
    vscode = require('vscode');
} catch (error) {
    vscode = undefined;
}
const { AzurePipelineParser } = require('./parser');
const { NONAME } = require('dns');

// Module-level state for cleanup
let activeDebounceTimer;
let activeErrorDebounceTimer;
let activeDependenciesDebounceTimer;
let activeDependenciesPanel;
let activeSimulationPanel;
let lastExpandedDoc = null;
let simOutputChannel = null;
let lastSimDocument = null;
let lastSimSourceText = null;
let lastSimParserOptions = null;
let extensionRuntimeGeneration = 0;

const DEFAULT_COMPILE_TIME_VARIABLES = Object.freeze({
    'Build.Reason': 'Manual',
    'Build.SourceBranch': 'refs/heads/main',
});

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

/** Convert a Windows UNC WSL path (\\wsl.localhost\distro\foo) to the Linux path (/foo).
 * Returns the path unchanged when it is already a Linux/Windows non-UNC path.
 */
function _toSimulatorPath(p) {
    if (!p || typeof p !== 'string') return p || '';
    const m = p.match(/^\\\\wsl\.localhost\\[^\\]+(.*)/i);
    if (m) return m[1].replace(/\\/g, '/');
    return p;
}

function _escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _extractSimulationTree(document) {
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
            return { label, type };
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

function _extractTopLevelParameterDefinitions(parser, sourceText, skipSyntaxCheck) {
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

/**
 * Resolves executable path overrides for the current simulation OS context.
 * Merges base-level entries with the appropriate OS sub-object ('windows' or 'linux'),
 * where the OS sub-object takes precedence. Entries under the other OS key are ignored.
 *
 * @param {Object} rawPaths - Raw value of simulation.toolPaths setting
 * @param {boolean} isLinuxContext - true when simulation scripts will run on Linux/WSL
 * @returns {Object} flat map of tool name → resolved path
 */
function _resolveExecPaths(rawPaths, isLinuxContext) {
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

/**
 * Returns true when simulation scripts will execute in a Linux/WSL environment.
 * On a Windows host this is the case whenever the pipeline file lives inside WSL.
 *
 * @param {string} documentFileName
 */
function _isLinuxSimulationContext(documentFileName) {
    if (process.platform !== 'win32') return true;
    return /^\\\\wsl\.localhost\\/i.test(documentFileName || '');
}

/**
 * Extracts simple variable definitions and library group references from the
 * top-level variables: section of a parsed pipeline document.
 */
function _extractPipelineVariables(parsedDoc) {
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
 * Builds the standard default simulation variables from resolved paths.
 * Both the CLI and UI share this baseline variable set.
 *
 * @param {string} workingDirectory - Resolved working directory
 * @param {string} outputRoot - Resolved output root (no trailing slash)
 * @param {string} buildCounter - Build counter value as string
 * @param {Object} [extra={}] - Additional variables to merge in (e.g. checkout vars)
 */
function _buildSimulationDefaultVariables(workingDirectory, outputRoot, buildCounter, extra) {
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

/**
 * Runs a pipeline simulation from a pre-parsed document and a resolved config.
 * Shared between the CLI path and the VS Code extension UI path.
 *
 * @param {object} parsedDoc - Parsed pipeline document from AzurePipelineParser
 * @param {object} config
 * @param {string} config.workingDirectory - Resolved working directory
 * @param {string} config.outputRoot - Resolved simulation output root
 * @param {string} [config.buildCounter='1'] - Build counter value
 * @param {Object} [config.userVariables={}] - User-supplied variable overrides (-v / UI variables)
 * @param {Object} [config.libraryVariables={}] - { groupName: { varName: value } }
 * @param {string[]} [config.stages] - Stage filter; undefined means all stages
 * @param {Object} [config.executablePaths={}] - Tool executable path overrides
 * @param {string|null} [config.wslMountRoot=null] - WSL UNC mount root for path resolution
 * @param {string} [config.checkoutSource] - 'local' or 'git'; adds Simulator.Checkout* vars
 * @param {string} [config.checkoutRepository] - Repo path/URL for checkout
 * @param {Object} [config.mockCatalog] - Mock catalog for task outputs (CLI only)
 * @returns simulation results from PipelineSimulator.simulate()
 */
function runPipelineSimulation(
    parsedDoc,
    {
        workingDirectory,
        outputRoot,
        buildCounter = '1',
        userVariables = {},
        libraryVariables = {},
        stages,
        executablePaths = {},
        wslMountRoot = null,
        checkoutSource,
        checkoutRepository,
        mockCatalog,
    } = {}
) {
    const counterStr = String(buildCounter || '1');
    const counterNum = parseInt(counterStr, 10);

    const checkoutVars =
        checkoutSource !== undefined
            ? {
                  'Simulator.CheckoutSource': checkoutSource,
                  'Simulator.CheckoutRepository': checkoutRepository || '',
                  'Simulator.RepositoryRoot': checkoutRepository || workingDirectory,
              }
            : {};

    const defaultVariables = _buildSimulationDefaultVariables(workingDirectory, outputRoot, counterStr, checkoutVars);

    const userOverrides = { ...userVariables };
    if (!isNaN(counterNum)) {
        userOverrides['Build.BuildNumber'] = counterStr;
        userOverrides['Build.BuildId'] = counterStr;
        userOverrides.buildCounter = counterStr;
    }

    const simOptions = {
        defaultVariables,
        variables: { ...defaultVariables, ...userOverrides },
        workingDirectory,
        userOverrides,
        libraryVariables,
        ...(checkoutSource !== undefined ? { checkoutSource, checkoutRepository: checkoutRepository || '' } : {}),
        ...(stages && stages.length ? { stages } : {}),
    };

    const systemDebugValue =
        userOverrides['System.Debug'] !== undefined ? userOverrides['System.Debug'] : defaultVariables['System.Debug'];
    const debugScript =
        String(systemDebugValue || '')
            .trim()
            .toLowerCase() === 'true';

    const outRoot = outputRoot.replace(/[/\\]$/, '');
    const simulatorConfig = { outputRoot: outRoot, executablePaths, wslMountRoot, debugScript };
    if (mockCatalog) simulatorConfig.mockCatalog = mockCatalog;
    const simulator = new PipelineSimulator(simulatorConfig);
    return simulator.simulate(parsedDoc, simOptions);
}

function _generateSimulationViewHtml(
    stageTree,
    fileName,
    topLevelParameterDefinitions = [],
    nonce = '',
    knownVarsJson = '{"azure":[],"pipeline":[],"groups":[]}',
    savedVarsJson = '{"overrides":{},"libData":[]}'
) {
    const esc = _escHtml;
    const topLevelParametersJson = JSON.stringify(topLevelParameterDefinitions || []).replace(/</g, '\\u003c');
    const STEP_ICONS = {
        task: '⚙',
        bash: '🐚',
        script: '📝',
        pwsh: '⬡',
        powershell: '⬡',
        checkout: '↓',
        publish: '↑',
        download: '↓',
        step: '▸',
    };
    const STEP_COLORS = {
        task: '#4299e1',
        bash: '#68d391',
        script: '#f6ad55',
        pwsh: '#63b3ed',
        powershell: '#63b3ed',
        checkout: '#b794f4',
        publish: '#fc8181',
        download: '#76e4f7',
        step: '#a0aec0',
    };

    // Generate sidebar stages list with expandable jobs/tasks
    const stagesSidebarHtml = stageTree
        .map((stage, si) => {
            const sidebarJobsHtml =
                stage.jobs
                    .map((job, ji) => {
                        const sidebarStepsHtml =
                            job.steps
                                .map(
                                    (step, ti) =>
                                        `<div class="sidebar-task-row" data-stage-index="${si}" data-job-index="${ji}" data-step-index="${ti}" onclick="selectSidebarTask(event,${si},${ji},${ti})">` +
                                        `<span class="sidebar-task-icon" style="color:${STEP_COLORS[step.type] || '#a0aec0'}">${STEP_ICONS[step.type] || '▸'}</span>` +
                                        `<span class="sidebar-result" id="ssr-task-${si}-${ji}-${ti}">•</span>` +
                                        `<span class="sidebar-task-name">${esc(step.label)}</span>` +
                                        `</div>`
                                )
                                .join('') || '<div class="empty-msg">No tasks</div>';

                        return (
                            `<div class="sidebar-job-item">` +
                            `<div class="sidebar-job-header" onclick="toggleSidebarJob(event,'ssjt-${si}-${ji}','ssjto-${si}-${ji}')">` +
                            `<span class="sidebar-toggle" id="ssjto-${si}-${ji}"></span>` +
                            `<span class="sidebar-result" id="ssr-job-${si}-${ji}">•</span>` +
                            `<span class="sidebar-job-name">${esc(job.displayName)}</span>` +
                            `<span class="count-badge">${job.steps.length}</span>` +
                            `</div>` +
                            `<div class="sidebar-job-steps collapsed" id="ssjt-${si}-${ji}">${sidebarStepsHtml}</div>` +
                            `</div>`
                        );
                    })
                    .join('') || '<div class="empty-msg">No jobs</div>';

            return (
                `<div class="sidebar-stage ${si === 0 ? 'active' : ''}" data-stage-index="${si}">` +
                `<div class="sidebar-stage-header" onclick="toggleSidebarStage(event,${si})">` +
                `<span class="sidebar-toggle" id="sst-${si}"></span>` +
                `<span class="sidebar-result" id="ssr-stage-${si}">•</span>` +
                `<span class="stage-checkbox-wrap" onclick="event.stopPropagation()"><input type="checkbox" class="stage-cb" data-name="${esc(stage.name)}" checked onchange="onStageSelectionChange()"></span>` +
                `<span class="stage-indicator"></span>` +
                `<span class="sidebar-stage-name">${esc(stage.displayName)}</span>` +
                `</div>` +
                `<div class="sidebar-stage-meta">${stage.jobs.length} job${stage.jobs.length !== 1 ? 's' : ''}</div>` +
                `<div class="sidebar-stage-jobs collapsed" id="ssj-${si}">${sidebarJobsHtml}</div>` +
                `</div>`
            );
        })
        .join('');

    // Generate main content for each stage
    const stageContentsHtml = stageTree
        .map((stage, si) => {
            const jobsHtml =
                stage.jobs
                    .map((job, ji) => {
                        const stepsHtml = job.steps
                            .map(
                                (step) =>
                                    `<div class="step-row">` +
                                    `<span class="step-icon" style="color:${STEP_COLORS[step.type] || '#a0aec0'}">${STEP_ICONS[step.type] || '▸'}</span>` +
                                    `<span class="step-type">${esc(step.type)}</span>` +
                                    `<span class="step-label">${esc(step.label)}</span>` +
                                    `</div>`
                            )
                            .join('');
                        return (
                            `<div class="job-item">` +
                            `<div class="job-header" onclick="toggleSteps('steps-${si}-${ji}')">` +
                            `<span class="toggle" id="tj-${si}-${ji}">&#9658;</span>` +
                            `<span class="job-badge${job.isDeployment ? ' deploy' : ''}">${job.isDeployment ? 'DEPLOY' : 'JOB'}</span>` +
                            `<span class="job-name">${esc(job.displayName)}</span>` +
                            `<span class="count-badge">${job.steps.length}</span>` +
                            `</div>` +
                            `<div class="steps-list collapsed" id="steps-${si}-${ji}">${stepsHtml || '<div class="empty-msg">No steps</div>'}</div>` +
                            `</div>`
                        );
                    })
                    .join('') || '<div class="empty-msg">No jobs</div>';
            return (
                `<div class="stage-content ${si === 0 ? 'active' : ''}" data-stage-index="${si}">` +
                `<div class="jobs-container">${jobsHtml}</div>` +
                `</div>`
            );
        })
        .join('');

    const baseName = fileName.split(/[\\/]/).pop();

    /* eslint-disable prettier/prettier */
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Pipeline Simulation</title><!-- nonce:${nonce} -->
<style id="mainStyle">
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;background:#1e1e1e;color:#cccccc;height:100vh;display:flex;flex-direction:column;line-height:1.4}
.main-container{display:flex;flex:1;overflow:hidden}
.header{background:#2d2d30;padding:14px 20px;border-bottom:2px solid #555;flex-shrink:0}
.header h1{color:#e8e8e8;font-size:1.2em;display:flex;align-items:center;gap:10px;font-weight:600}
.header .filename{color:#999;font-size:.88em;margin-top:3px;font-family:monospace;word-break:break-all}
.sidebar{width:300px;background:#252526;border-right:1px solid #3e3e42;display:flex;flex-direction:column;overflow-y:auto;flex-shrink:0}
.sidebar-header{padding:10px 14px;border-bottom:1px solid #3e3e42;background:#2d2d30;font-size:.82em;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.08em;display:flex;align-items:center;justify-content:space-between;gap:10px}
.sidebar-header-controls{display:flex;align-items:center;gap:6px;font-size:.9em;text-transform:none;letter-spacing:normal;color:#bbb}
.sidebar-header-controls input{cursor:pointer;accent-color:#0078d4;width:14px;height:14px}
.sidebar-header-controls label{cursor:pointer}
.sidebar-content{flex:1;overflow-y:auto;padding:6px 0}
.sidebar-stage{padding:6px 12px;border-bottom:1px solid #2e2e2e;cursor:pointer;transition:background .1s}
.sidebar-stage:hover{background:#2c2c2e}
.sidebar-stage.active{background:#3a3a3c;border-left:3px solid #888}
.sidebar-stage.active .stage-indicator{background:#ccc}
.sidebar-stage-header{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.stage-indicator{width:7px;height:7px;border-radius:50%;background:#555;flex-shrink:0}
.sidebar-stage-name{font-size:.92em;color:#d0d0d0;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sidebar-stage-meta{font-size:.8em;color:#666;padding-left:16px}
.sidebar-stage-jobs{margin-top:4px;padding:0 0 6px 14px;border-left:1px solid #3a3a3c}
.sidebar-stage-jobs.collapsed{display:none}
.sidebar-job-item{margin:4px 0 0}
.sidebar-job-header{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:4px;cursor:pointer}
.sidebar-job-header:hover{background:#303033}
.sidebar-job-name{font-size:.86em;color:#c0c0c0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sidebar-job-steps{padding:2px 0 2px 18px}
.sidebar-job-steps.collapsed{display:none}
.sidebar-task-row{display:flex;align-items:center;gap:6px;padding:4px 4px;border-radius:3px;cursor:pointer}
.sidebar-task-row:hover{background:#303033}
.sidebar-task-row.active{background:#3c3c3f}
.sidebar-task-icon{font-size:.82em;width:14px;flex-shrink:0;text-align:center}
.sidebar-result{font-size:.78em;width:12px;flex-shrink:0;text-align:center;color:#666}
.sidebar-result.succeeded{color:#4ec94e}
.sidebar-result.failed{color:#f47174}
.sidebar-result.skipped{color:#c8a84b}
.sidebar-task-name{font-size:.82em;color:#a0a0a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.sidebar-task-row:hover .sidebar-task-name{color:#d8d8d8}
.sidebar-task-row.active .sidebar-task-name{color:#e8e8e8}
.main-content{flex:1;display:flex;flex-direction:column;overflow:hidden}
.settings-panel{background:#2a2a2c;border-bottom:1px solid #444;padding:12px 20px;overflow-y:auto;max-height:none;flex:1}
.settings-panel.collapsed{max-height:36px;flex:0 0 auto;overflow:hidden}
.body{flex:1;overflow-y:auto;padding:16px 20px}
.body.hidden{display:none}
.body-toolbar{display:flex;justify-content:flex-end;align-items:center;margin-bottom:4px}
.stage-content{display:none}
.stage-content.active{display:block}
.stage-content-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #0078d4}
.stage-content-header h2{color:#fff;font-size:1.2em;margin:0}
.stage-checkbox-wrap{display:flex;align-items:center}
.section-title{color:#cccccc;font-size:.85em;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin:12px 0 8px}
.options-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:4px}
.field-group{display:flex;align-items:center;gap:8px}
.param-section{margin-top:12px}
.param-grid{display:flex;flex-direction:column;gap:8px}
.param-row{display:grid;grid-template-columns:220px minmax(0,1fr);gap:10px;align-items:center}
.param-name{font-size:.8em;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.param-control{background:#2d2d30;border:1px solid #3e3e42;color:#e0e0e0;padding:6px 8px;border-radius:3px;width:100%}
.param-control:focus{outline:none;border-color:#0078d4}
.param-note{font-size:.74em;color:#666;grid-column:2}
.field-label{font-size:.82em;color:#ccc}
.field-input{background:#2d2d30;border:1px solid #3e3e42;color:#e0e0e0;padding:4px 8px;border-radius:3px;font-size:.82em;width:90px}
.field-input:focus{outline:none;border-color:#0078d4}
.field-select{background:#2d2d30;border:1px solid #3e3e42;color:#e0e0e0;padding:4px 8px;border-radius:3px;font-size:.82em;cursor:pointer}
.field-select:focus{outline:none;border-color:#0078d4}
.vars-table{width:100%;border-collapse:collapse;margin-top:4px;font-size:.85em}
.vars-table td{padding:3px 5px}
.vars-ref-table td{vertical-align:middle}
.varth{color:#ccc;font-weight:700;font-size:.8em;padding:4px 5px;text-align:left}
.var-group-label{font-size:.82em;color:#c8c8c8;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:10px;margin-bottom:4px;padding:3px 2px;display:flex;align-items:center;gap:6px}
.var-group-label.var-toggle{cursor:pointer}
.var-group-label.var-toggle:hover{color:#ccc}
.var-group-sublabel{font-size:.95em;color:#ccc;font-weight:600;margin-top:8px;margin-bottom:3px;padding:2px 4px;display:flex;align-items:center;gap:8px}
.varref-group{margin-bottom:8px}
.varref-group-title{font-size:.74em;color:#777;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;border-bottom:1px solid #2a2a2a;padding-bottom:2px}
.varref-item{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:.79em}
.varref-name{font-family:monospace;color:#9cdcfe;word-break:break-word}
.varref-val{color:#aaa;font-family:monospace;font-size:.92em;word-break:break-word}
.varref-add{background:none;border:1px solid #3e3e42;color:#666;padding:1px 5px;border-radius:3px;cursor:pointer;font-size:.74em;line-height:1.5;flex-shrink:0}
.varref-add:hover{border-color:#0078d4;color:#9cdcfe}
.varref-toggle{font-size:.8em;color:#777;cursor:pointer;user-select:none;padding:3px 0;display:inline-block}
.varref-toggle:hover{color:#ccc}
#variablesContent.collapsed{display:none}
#pipelineVarsBody .vars-table,#azureVarsBody .vars-table{font-size:.98em}
#libVarsBody .vars-table{font-size:.98em}
#libVarsBody .var-key,#libVarsBody .var-val{font-size:.98em}
#libVarsBody .lib-name{color:#9cdcfe;font-family:monospace}
#toolPathsPanelBody .vars-table{font-size:.98em}
#toolPathsPanelBody .tool-name{color:#9cdcfe;font-family:monospace}#toolPathsPanelBody .tool-name,#toolPathsPanelBody .tool-path{font-size:.98em}
.var-key,.var-val{background:#2d2d30;border:1px solid #3e3e42;color:#e0e0e0;padding:4px 8px;border-radius:3px;width:100%}.var-key{font-weight:600}
.var-key:focus,.var-val:focus{outline:none;border-color:#0078d4}
.add-var-btn{background:none;border:1px dashed #555;color:#777;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:.8em;font-weight:600;line-height:1.4}
.add-var-btn:hover{border-color:#0078d4;color:#ccc}
.save-lib-btn{background:#3a3a3d;border:1px solid #666;color:#ddd;padding:3px 9px;border-radius:3px;cursor:pointer;font-size:.8em;line-height:1.4}
.save-lib-btn:hover{border-color:#0078d4;color:#fff}
.remove-var-btn{background:none;border:none;color:#b8b8b8;cursor:pointer;font-size:1.05em;padding:0 4px;line-height:1}
.remove-var-btn:hover{color:#fc8181}
.toolbar{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.toolbar-btn{background:#2d2d30;border:1px solid #3e3e42;color:#aaa;padding:4px 8px;border-radius:3px;cursor:pointer;font-size:.74em}
.toolbar-btn:hover{border-color:#555;color:#ddd}
.jobs-container{display:flex;flex-direction:column;gap:8px}
.job-item{display:none;background:#2a2a2a;border:1px solid #3e3e42;border-radius:3px;overflow:hidden}
.job-header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#2d2d30;cursor:pointer;transition:background .15s}
.job-header:hover{background:#333333}
.toggle{display:inline-block;font-size:.72em;color:#888;transition:transform .15s;cursor:pointer;width:14px;flex-shrink:0;text-align:center;user-select:none}
.toggle.open{transform:rotate(90deg);color:#ccc}
.sidebar-toggle{display:inline-block;width:7px;height:7px;border-right:2px solid #b8b8b8;border-bottom:2px solid #b8b8b8;transform:rotate(-45deg);transition:transform .15s,border-color .15s;flex-shrink:0;font-size:0;vertical-align:middle;margin-bottom:1px;cursor:pointer}
.sidebar-toggle.open{transform:rotate(45deg);border-color:#ffffff}
.job-badge{font-size:.62em;font-weight:700;padding:2px 6px;border-radius:2px;background:#0078d4;color:#fff;flex-shrink:0}
.job-badge.deploy{background:#6b46c1}
.job-name{font-size:.85em;color:#ccc;flex:1}
.count-badge{font-size:.66em;color:#999;background:#1e1e1e;padding:2px 6px;border-radius:10px;border:1px solid #3e3e42;white-space:nowrap;font-weight:600}
.steps-list{padding:0;background:#1e1e1e}
.steps-list.collapsed{display:none}
.step-row{display:flex;align-items:baseline;gap:8px;padding:8px 12px;border-top:1px solid #252526}
.step-icon{font-size:.85em;flex-shrink:0;width:16px;text-align:center}
.step-type{font-size:.68em;color:#666;font-family:monospace;flex-shrink:0;min-width:56px;font-weight:600}
.step-label{font-size:.85em;color:#999;flex:1}
.empty-msg{font-size:.78em;color:#555;padding:12px;font-style:italic;text-align:center}
.actions{display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid #3e3e42}
.run-btn{background:#0078d4;border:none;color:#fff;padding:9px 20px;border-radius:3px;cursor:pointer;font-size:.92em;font-weight:600}
.run-btn:hover{background:#005a9e}
.run-btn:disabled{background:#444;color:#777;cursor:not-allowed}
.status-msg{font-size:.84em;color:#888}
.res-wrap{margin-top:18px;border-top:1px solid #3e3e42;padding-top:14px}
.res-stage{margin-bottom:10px}
.res-stage-hd{font-size:1em;font-weight:700;color:#ddd;padding:6px 0 4px;border-bottom:1px solid #3e3e42;text-transform:uppercase;letter-spacing:.03em}
.res-job{margin:4px 0 4px 12px}
.res-job-hd{font-size:.96em;font-weight:600;color:#aaa;padding:4px 0 2px}
.res-step{margin:4px 0 4px 20px;font-size:1.02em}
.res-icon{margin-right:6px;font-size:1.04em}
.res-step-name{color:#ccc}
.res-out{margin:3px 0 3px 20px;font-family:monospace;font-size:.96em;color:#9fa8b0;white-space:pre-wrap;word-break:break-all;max-height:min(65vh,calc(100vh - 260px));overflow-y:auto;background:#1a1a1a;padding:5px 8px;border-radius:2px}
.res-vars{margin:2px 0 2px 20px}
.res-var{font-size:.94em;color:#8f98a1;font-family:monospace}
.res-out-var{color:#7eb8d4}
.res-vk{color:#444;margin-right:3px}
.res-summary{margin-top:12px;padding:8px 10px;background:#252526;border:1px solid #3e3e42;border-radius:3px;font-size:.84em;font-weight:600}
@keyframes aps-spin{to{transform:rotate(360deg)}}
.sim-loading{display:flex;align-items:center;gap:10px;padding:24px 0;color:#888;font-size:.9em}
.sim-spinner{width:20px;height:20px;border:2px solid #3e3e42;border-top-color:#569cd6;border-radius:50%;animation:aps-spin .8s linear infinite;flex-shrink:0}
.sec-title-row{display:flex;align-items:center;gap:8px}
.sec-collapse-btn{margin-left:auto;background:#3a3a3d;border:1px solid #666;color:#ddd;padding:3px 11px;border-radius:3px;cursor:pointer;font-size:.8em;font-weight:600}
.sec-save-btn{background:#2e2e31;border:1px solid #555;color:#ccc;padding:2px 7px;border-radius:3px;cursor:pointer;font-size:.75em}.var-group-actions{display:flex;align-items:center;gap:4px;flex-shrink:0;margin-left:6px}
.sec-save-btn:hover{border-color:#888;color:#fff}
.sec-collapse-btn:hover{border-color:#888;color:#fff;background:#3d3d3f}
.res-stage-hd{cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between}
.res-stage-hd:hover{color:#fff}
.res-job-hd{cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between}
.res-job-hd:hover{color:#ccc}
.res-tog{font-size:.7em;color:#555;margin-left:6px;flex-shrink:0}
.res-body{overflow:hidden}
.res-body.collapsed{display:none}
.back-btn{background:#3d3d3f;border:1px solid #555;color:#ccc;padding:8px 14px;border-radius:3px;cursor:pointer;font-size:.88em;font-weight:600}
.back-btn:hover{background:#4a4a4e;border-color:#888;color:#fff}
.res-browser-btn{background:#0e639c;color:#fff;border:none;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:.78em}.res-browser-btn:hover{background:#1177bb}
.term-btn{display:none;background:none;border:1px solid #3e3e42;color:#ccc;padding:8px 16px;border-radius:3px;cursor:pointer;font-size:.88em;font-weight:600}
.term-btn:hover{border-color:#0078d4;color:#fff}
.term-btn:disabled{border-color:#333;color:#555;cursor:not-allowed}
#pageLoader{position:fixed;inset:0;background:#1e1e1e;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:9999}
#pageLoader .pl-spinner{width:28px;height:28px;border:3px solid #3e3e42;border-top-color:#569cd6;border-radius:50%;animation:aps-spin .8s linear infinite}
#pageLoader .pl-text{font-size:.85em;color:#666}
</style></head>
<body>
<div id="pageLoader"><div class="pl-spinner"></div><div class="pl-text">Loading…</div></div>
<div class="header"><h1>&#9889; Pipeline Simulation</h1><div class="filename">${esc(baseName)}</div><div class="filename" style="font-size:.7em;color:#555;margin-left:auto">${new Date().toLocaleTimeString()}</div></div>
<div class="main-container">
  <div class="sidebar">
    <div class="sidebar-header"><span>Stages</span><span class="sidebar-header-controls"><input type="checkbox" id="selectAllStages" checked onchange="toggleAllStages(this.checked)"><label for="selectAllStages">All</label></span></div>
    <div class="sidebar-content">${stagesSidebarHtml || '<div class="empty-msg">No stages</div>'}</div>
  </div>
  <div class="main-content">
    <div class="settings-panel" id="settingsPanel">
      <div class="section-title sec-title-row" style="margin-top:0">Settings<button class="sec-collapse-btn" id="settingsToggle" onclick="toggleSettingsPanel()">&#9650; Collapse</button></div>
      <div id="settingsContent">
        <div class="section-title sec-title-row" onclick="toggleToolPaths()" style="margin-top:0;cursor:pointer"><span class="sidebar-toggle" id="toolPathsToggle"></span>Tool Paths</div>
        <div id="toolPathsContent" style="display:none">
          <div id="toolPathsPanelBody"></div>
        </div>
        <div class="section-title sec-title-row" onclick="toggleVariables()" style="margin-top:12px;cursor:pointer"><span class="sidebar-toggle" id="variablesToggle"></span>Variables</div>
        <div id="variablesContent" style="display:none">
          <div id="variablesPanelBody"></div>
        </div>
                <div id="topLevelParamsSection" class="param-section" style="display:none">
                    <div class="section-title">Top-Level Parameters</div>
                    <div id="topLevelParamsRows" class="param-grid"></div>
                </div>
        <div class="options-row" style="margin-top:12px">
          <div class="field-group"><label class="field-label" for="buildCounter">Build Counter</label>
            <input class="field-input" type="number" id="buildCounter" value="1" min="1" step="1"></div>
          <div class="field-group"><label class="field-label" for="buildReason">Build Reason</label>
            <select class="field-select" id="buildReason" onchange="syncSpecialVarToPanel()"><option value="Manual">Manual</option><option value="IndividualCI">IndividualCI</option><option value="BatchedCI">BatchedCI</option><option value="Schedule">Schedule</option><option value="PullRequest">PullRequest</option><option value="BuildCompletion">BuildCompletion</option><option value="ResourceTrigger">ResourceTrigger</option></select></div>
          <div class="field-group"><label class="field-label" for="sourceBranch">Source Branch</label>
            <input class="field-input" list="sourceBranchList" id="sourceBranch" value="refs/heads/main" style="width:170px" oninput="syncSpecialVarToPanel()">
            <datalist id="sourceBranchList"><option value="refs/heads/main"><option value="refs/heads/master"><option value="refs/heads/develop"><option value="refs/heads/release"><option value="refs/pull/1/merge"></datalist></div>
          <div class="field-group"><input type="checkbox" id="debugMode" style="cursor:pointer;accent-color:#0078d4;width:14px;height:14px" onchange="syncSpecialVarToPanel()"><label class="field-label" for="debugMode" style="cursor:pointer">Enable Debug</label></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="run-btn" id="runBtn" onclick="runSimulation()">&#9654; Run Simulation</button>

          <button class="back-btn" id="backBtn" onclick="showSettings()" style="display:none">&#9881; Settings</button>
          <span class="status-msg" id="statusMsg"></span>
        </div>
      </div>
    </div>
        <div class="body hidden" id="renderBody">
            <div class="body-toolbar"><button class="res-browser-btn" id="browserBtn" onclick="openResultsInBrowser()" style="display:none">&#127760; Open in Browser</button></div>
      <div id="stageContents">${stageContentsHtml || '<div class="empty-msg">No stages found</div>'}</div>
      <div id="resultsPanel"></div>
    </div>
  </div>
</div>
<script>
window.onerror=function(msg,src,line,col,err){var l=document.getElementById('pageLoader');if(l){l.innerHTML='<div style="color:#f47174;padding:20px;font-family:monospace;font-size:13px"><b>JS Error (line '+line+'):</b><br>'+msg+'<br><br>'+(err&&err.stack?err.stack.replace(/\\n/g,'<br>'):'')+'</div>';}return false;};
window.addEventListener('unhandledrejection',function(e){var l=document.getElementById('pageLoader');if(l){l.innerHTML='<div style="color:#f47174;padding:20px;font-family:monospace;font-size:13px"><b>Unhandled Promise Rejection:</b><br>'+String(e.reason)+'</div>';}});
const vscode=acquireVsCodeApi();let varCount=0;let libVarCount=0;let taskFilter=null;
const topLevelParameterDefinitions=${topLevelParametersJson};
const knownVars=${knownVarsJson};
const savedVars=${savedVarsJson};
function _normParamType(t){return String(t||'string').trim().toLowerCase();}
function _asBool(v){if(typeof v==='boolean')return v;var s=String(v||'').trim().toLowerCase();return s==='true'||s==='1'||s==='yes';}
function _stringifyParamValue(v){if(v===undefined||v===null)return '';if(typeof v==='object'){try{return JSON.stringify(v);}catch(_){return String(v);}}return String(v);}
function _createParamControl(def){
    const t=_normParamType(def.type);
    const values=Array.isArray(def.values)&&def.values.length?def.values:null;
    const hasDefault=!!def.hasDefault;
    const defaultValue=hasDefault?def.defaultValue:'';
    let control;
    if(values){
        control=document.createElement('select');
        control.className='param-control';
        values.forEach(function(opt){
            const option=document.createElement('option');
            const text=_stringifyParamValue(opt);
            option.value=text;
            option.textContent=text;
            if(_stringifyParamValue(defaultValue)===text)option.selected=true;
            control.appendChild(option);
        });
    }else if(t==='boolean'){
        control=document.createElement('input');
        control.type='checkbox';
        control.style.accentColor='#0078d4';
        control.style.width='16px';
        control.style.height='16px';
        control.checked=hasDefault?_asBool(defaultValue):false;
    }else if(t==='number'){
        control=document.createElement('input');
        control.type='number';
        control.className='param-control';
        control.value=hasDefault?_stringifyParamValue(defaultValue):'';
    }else{
        control=document.createElement('input');
        control.type='text';
        control.className='param-control';
        control.value=hasDefault?_stringifyParamValue(defaultValue):'';
    }
    control.setAttribute('data-param-name',String(def.name||''));
    control.setAttribute('data-param-type',t);
    control.setAttribute('data-param-has-default',hasDefault?'true':'false');
    control.setAttribute('data-param-default',_stringifyParamValue(defaultValue));
    return control;
}
function renderTopLevelParameters(){
    const section=document.getElementById('topLevelParamsSection');
    const rows=document.getElementById('topLevelParamsRows');
    if(!section||!rows)return;
    rows.innerHTML='';
    if(!Array.isArray(topLevelParameterDefinitions)||!topLevelParameterDefinitions.length){
        section.style.display='none';
        return;
    }
    section.style.display='block';
    topLevelParameterDefinitions.forEach(function(def){
        const name=String((def&&def.name)||'').trim();
        if(!name)return;
        const row=document.createElement('div');
        row.className='param-row';
        const label=document.createElement('label');
        label.className='param-name';
        label.textContent=name;
        const control=_createParamControl(def);
        label.htmlFor='param-'+name;
        control.id='param-'+name;
        row.appendChild(label);
        row.appendChild(control);
        rows.appendChild(row);
        const note=document.createElement('div');
        note.className='param-note';
        note.textContent='type: '+_normParamType(def.type)+(Array.isArray(def.values)&&def.values.length?'  values: '+def.values.map(_stringifyParamValue).join(', '):'');
        rows.appendChild(note);
    });
}
function _collectTopLevelParameters(){
    const out={};
    document.querySelectorAll('[data-param-name]').forEach(function(control){
        const name=(control.getAttribute('data-param-name')||'').trim();
        if(!name)return;
        const t=_normParamType(control.getAttribute('data-param-type')||'string');
        const hasDefault=control.getAttribute('data-param-has-default')==='true';
        const defaultRaw=control.getAttribute('data-param-default')||'';
        let value;
        if(control.type==='checkbox'){
            value=!!control.checked;
            const defaultBool=hasDefault?_asBool(defaultRaw):false;
            if(!hasDefault&&!value)return;
            if(hasDefault&&value===defaultBool)return;
            out[name]=value;
            return;
        }
        const raw=String(control.value||'');
        const trimmed=raw.trim();
        if(trimmed===''){
            if(!hasDefault)return;
            if(defaultRaw==='')return;
        }
        if(hasDefault&&trimmed===defaultRaw)return;
        if(t==='number'){
            const n=Number(trimmed);
            value=Number.isFinite(n)?n:trimmed;
        }else if(t==='boolean'){
            value=_asBool(trimmed);
        }else{
            value=trimmed;
        }
        out[name]=value;
    });
    return out;
}
function _collectSelectedStages(){
    const unique=new Set();
    document.querySelectorAll('.stage-cb:checked').forEach(function(cb){
        const name=String((cb && cb.dataset && cb.dataset.name) || '').trim();
        if(name)unique.add(name);
    });
    return Array.from(unique);
}
function syncSelectAllStages(){
    const master=document.getElementById('selectAllStages');
    const stageCheckboxes=Array.from(document.querySelectorAll('.stage-cb'));
    if(!master)return;
    if(!stageCheckboxes.length){
        master.checked=false;
        master.indeterminate=false;
        return;
    }
    const checkedCount=stageCheckboxes.filter(cb=>cb.checked).length;
    master.checked=checkedCount===stageCheckboxes.length;
    master.indeterminate=checkedCount>0&&checkedCount<stageCheckboxes.length;
}
function onStageSelectionChange(){
    syncSelectAllStages();
}
function toggleAllStages(checked){
    document.querySelectorAll('.stage-cb').forEach(function(cb){
        cb.checked=!!checked;
    });
    syncSelectAllStages();
}
function selectStage(index){
    taskFilter=null;
    document.querySelectorAll('.sidebar-task-row').forEach(el=>el.classList.remove('active'));
    document.querySelectorAll('.sidebar-stage').forEach((el,i)=>{el.classList.toggle('active',i===index);});
    document.querySelectorAll('.stage-content').forEach((el,i)=>{el.classList.toggle('active',i===index);});
    applyTaskFilter();
}
function toggleCollapse(bodyId,toggleId){
    var body=document.getElementById(bodyId);
    var toggle=document.getElementById(toggleId);
    if(!body)return;
    var collapsed=body.classList.toggle('collapsed');
    if(toggle)toggle.classList.toggle('open',!collapsed);
}
function expandAll(expand){
    document.querySelectorAll('.sidebar-stage-jobs,.sidebar-job-steps').forEach(function(el){
        el.classList.toggle('collapsed',!expand);
    });
    document.querySelectorAll('.sidebar-stage-header .sidebar-toggle,.sidebar-job-header .sidebar-toggle').forEach(function(el){
        el.classList.toggle('open',expand);
    });
}
function toggleSidebarStage(event,index){
    if(event)event.stopPropagation();
    selectStage(index);
    toggleCollapse('ssj-'+index,'sst-'+index);
}
function toggleSidebarJob(event,bodyId,toggleId){
    if(event)event.stopPropagation();
    toggleCollapse(bodyId,toggleId);
}
function selectSidebarTask(event,stageIndex,jobIndex,stepIndex){
    if(event)event.stopPropagation();
    selectStage(stageIndex);
    taskFilter={stageIndex,jobIndex,stepIndex};
    document.querySelectorAll('.sidebar-task-row').forEach(el=>el.classList.remove('active'));
    if(event&&event.currentTarget)event.currentTarget.classList.add('active');
    expandResultsForTask(stageIndex,jobIndex);
    applyTaskFilter();
}
function expandResultsForTask(stageIndex,jobIndex){
    const panel=document.getElementById('resultsPanel');
    if(!panel)return;

    const stageSel='.res-stage[data-stage-index="'+String(stageIndex)+'"]';
    const stageEl=panel.querySelector(stageSel);
    if(!stageEl)return;

    const stageHeader=stageEl.querySelector('.res-stage-hd');
    const stageBody=stageHeader?stageHeader.nextElementSibling:null;
    if(stageBody&&stageBody.classList.contains('collapsed')){
        stageBody.classList.remove('collapsed');
        const stageTog=stageHeader.querySelector('.res-tog');
        if(stageTog)stageTog.textContent='▼';
    }

    const jobSel='.res-job[data-stage-index="'+String(stageIndex)+'"][data-job-index="'+String(jobIndex)+'"]';
    const jobEl=panel.querySelector(jobSel);
    if(!jobEl)return;

    const jobHeader=jobEl.querySelector('.res-job-hd');
    const jobBody=jobHeader?jobHeader.nextElementSibling:null;
    if(jobBody&&jobBody.classList.contains('collapsed')){
        jobBody.classList.remove('collapsed');
        const jobTog=jobHeader.querySelector('.res-tog');
        if(jobTog)jobTog.textContent='▼';
    }
}
function resetSidebarResults(){
    document.querySelectorAll('.sidebar-result').forEach(el=>{
        el.textContent='•';
        el.classList.remove('succeeded','failed','skipped');
    });
}
function setSidebarResult(id,result){
    const el=document.getElementById(id);
    if(!el)return;
    el.classList.remove('succeeded','failed','skipped');
    if(result==='Succeeded'){
        el.textContent='✔';
        el.classList.add('succeeded');
        return;
    }
    if(result==='Failed'){
        el.textContent='✖';
        el.classList.add('failed');
        return;
    }
    if(result==='Skipped'){
        el.textContent='⦸';
        el.classList.add('skipped');
        return;
    }
    el.textContent='•';
}
function updateSidebarResults(r){
    if(!r||!Array.isArray(r.stages))return;
    for(let si=0;si<r.stages.length;si++){
        const stage=r.stages[si]||{};
        setSidebarResult('ssr-stage-'+si,stage.result);
        const jobs=Array.isArray(stage.jobs)?stage.jobs:[];
        for(let ji=0;ji<jobs.length;ji++){
            const job=jobs[ji]||{};
            setSidebarResult('ssr-job-'+si+'-'+ji,job.result);
            const steps=Array.isArray(job.steps)?job.steps:[];
            for(let ti=0;ti<steps.length;ti++){
                const step=steps[ti]||{};
                setSidebarResult('ssr-task-'+si+'-'+ji+'-'+ti,step.result);
            }
        }
    }
}
function applyTaskFilter(){
    const panel=document.getElementById('resultsPanel');
    if(!panel)return;
    const summary=panel.querySelector('.res-summary');
    const steps=panel.querySelectorAll('.res-step');
    if(!steps.length)return;
    if(!taskFilter){
        panel.querySelectorAll('.res-stage,.res-job,.res-step').forEach(el=>{el.style.display='';});
        document.querySelectorAll('.job-item').forEach(el=>{el.style.display='';});
        if(summary)summary.style.display='';
        return;
    }
    const s=String(taskFilter.stageIndex),j=String(taskFilter.jobIndex),t=String(taskFilter.stepIndex);
    steps.forEach(el=>{
        const show=el.getAttribute('data-stage-index')===s&&el.getAttribute('data-job-index')===j&&el.getAttribute('data-step-index')===t;
        el.style.display=show?'':'none';
    });
    panel.querySelectorAll('.res-stage').forEach(stageEl=>{
        const stageIdx=stageEl.getAttribute('data-stage-index');
        const matchesStage=stageIdx===s;
        stageEl.style.display=matchesStage?'':'none';
    });
    panel.querySelectorAll('.res-job').forEach(jobEl=>{
        const stageIdx=jobEl.getAttribute('data-stage-index');
        const jobIdx=jobEl.getAttribute('data-job-index');
        const matchesJob=stageIdx===s&&jobIdx===j;
        jobEl.style.display=matchesJob?'':'none';
    });
    document.querySelectorAll('.job-item').forEach(el=>{el.style.display='none';});
    if(summary)summary.style.display='none';
}
function toggleSteps(id){const el=document.getElementById(id);if(!el)return;el.classList.toggle('collapsed');}
function toggleSettingsPanel(){var s=document.getElementById('settingsContent');var p=document.getElementById('settingsPanel');var btn=document.getElementById('settingsToggle');if(!s||!p)return;var c=s.classList.toggle('collapsed');p.classList.toggle('collapsed');btn.textContent=c?'▼ Settings':'▲ Collapse';}
function _varRefAdd(btn){var name=btn.getAttribute('data-name');var kind=btn.getAttribute('data-kind');if(kind==='group')addLibVarWithGroup(name);else addVarWithKey(name);}
function _btnClick(e,fn){e.stopPropagation();fn(e.currentTarget||e.target);}
function _btnFeedback(btn,text,color){if(!btn)return;var orig=btn.textContent;btn.textContent=text;btn.style.color=color;btn.disabled=true;setTimeout(function(){btn.textContent=orig;btn.style.color='';btn.disabled=false;},1500);}
function _collectAzureOverrides(){
    var overrides={};
    document.querySelectorAll('.var-override-input').forEach(function(inp){
        var name=inp.getAttribute('data-varname');
        if(name&&inp.value.trim())overrides[name]=inp.value.trim();
    });
    return overrides;
}
function _collectLibData(){
    var libData=[];
    knownVars.groups.forEach(function(g,gi){
        var tb=document.getElementById('libvars-'+gi);
        var vars=[];
        if(tb)tb.querySelectorAll('tr[data-group]').forEach(function(row){
            var n=row.querySelector('.lib-name');
            var v=row.querySelector('.lib-val');
            if(n&&n.value.trim())vars.push({name:n.value.trim(),value:v?v.value.trim():''});
        });
        libData.push({group:g,vars:vars});
    });
    return libData;
}
function saveAzureVars(btn){vscode.postMessage({command:'saveAzureVars',data:{overrides:_collectAzureOverrides()}});_btnFeedback(btn,'Saved \u2713','#4ec9b0');}
function saveLibVars(btn){vscode.postMessage({command:'saveLibVars',data:{libData:_collectLibData()}});_btnFeedback(btn,'Saved \u2713','#4ec9b0');}
function saveVars(){vscode.postMessage({command:'saveVars',data:{overrides:_collectAzureOverrides(),libData:_collectLibData()}});}
function clearAzureVars(btn){
    document.querySelectorAll('#azureVarsBody .var-override-input').forEach(function(inp){inp.value='';});
    syncSpecialVarToPanel();
    vscode.postMessage({command:'clearAzureVars'});
    _btnFeedback(btn,'Cleared','#ce9178');
}
function clearLibVars(btn){
    knownVars.groups.forEach(function(g,gi){var tb=document.getElementById('libvars-'+gi);if(tb)tb.innerHTML='';});
    vscode.postMessage({command:'clearLibVars'});
    _btnFeedback(btn,'Cleared','#ce9178');
}
function addToolPath(){var tb=document.getElementById('toolPathsRows');if(!tb)return;var tr=document.createElement('tr');tr.innerHTML='<td style="width:48%"><input class="var-key tool-name" placeholder="tool (e.g. bash)"></td><td><input class="var-val tool-path" placeholder="path"></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){tr.remove();};tb.appendChild(tr);var inp=tr.querySelector('.tool-name');if(inp)inp.focus();}
function _collectToolPaths(){var paths={};document.querySelectorAll('#toolPathsRows tr').forEach(function(row){var n=row.querySelector('.tool-name');var p=row.querySelector('.tool-path');if(n&&p&&n.value.trim()&&p.value.trim())paths[n.value.trim()]=p.value.trim();});return paths;}
function saveToolPaths(btn){vscode.postMessage({command:'saveToolPaths',data:{toolPaths:_collectToolPaths()}});_btnFeedback(btn,'Saved \u2713','#4ec9b0');}
function clearToolPaths(btn){var tb=document.getElementById('toolPathsRows');if(tb)tb.innerHTML='';vscode.postMessage({command:'clearToolPaths'});_btnFeedback(btn,'Cleared','#ce9178');}
function clearVars(){clearAzureVars();clearLibVars();vscode.postMessage({command:'clearVars'});}
function toggleVariables(){var c=document.getElementById('variablesContent');var btn=document.getElementById('variablesToggle');if(!c)return;var hidden=c.style.display==='none';c.style.display=hidden?'':'none';if(btn)btn.classList.toggle('open',hidden);}
function toggleToolPaths(){var c=document.getElementById('toolPathsContent');var btn=document.getElementById('toolPathsToggle');if(!c)return;var hidden=c.style.display==='none';c.style.display=hidden?'':'none';if(btn)btn.classList.toggle('open',hidden);}
function _renderToolPathsPanel(){var body=document.getElementById('toolPathsPanelBody');if(!body)return;var html='<div class="var-group-sublabel" style="margin-top:0"><button class="add-var-btn" onclick="addToolPath()" title="Add Tool Path">+ Add Tool Path</button><span style="margin-left:auto;display:flex;gap:4px"><button class="sec-save-btn" onclick="_btnClick(event,saveToolPaths)" title="Save Tool Paths">Save</button><button class="sec-save-btn" onclick="_btnClick(event,clearToolPaths)" title="Clear Tool Paths">Clear</button></span></div><table class="vars-table"><thead><tr><th class="varth" style="width:48%">Tool</th><th class="varth">Path</th><th style="width:5%"></th></tr></thead><tbody id="toolPathsRows"></tbody></table>';body.innerHTML=html;}
function toggleVarSubSection(hdr){var id=hdr.getAttribute('data-target');var el=document.getElementById(id);if(!el)return;var hidden=el.style.display==='none';el.style.display=hidden?'':'none';var tog=hdr.querySelector('.sidebar-toggle');if(tog)tog.classList.toggle('open',hidden);}
function syncSpecialVarToPanel(){var set=function(name,val){var inp=document.querySelector('.var-override-input[data-varname="'+name+'"]');if(inp)inp.value=val;};var dbg=document.getElementById('debugMode');var br=document.getElementById('buildReason');var sb=document.getElementById('sourceBranch');if(dbg)set('System.Debug',dbg.checked?'true':'');if(br&&br.value)set('Build.Reason',br.value);if(sb){var sval=sb.value.trim();set('Build.SourceBranch',sval);if(sval){var sbn=sval.replace(/^refs\\/heads\\//,'');set('Build.SourceBranchName',sbn!==sval?sbn:sval.split('/').pop()||sval);}else{set('Build.SourceBranchName','');}}}
function _collectAllVars(){var vars={};document.querySelectorAll('.var-override-input').forEach(function(inp){var name=inp.getAttribute('data-varname');if(name&&inp.value.trim())vars[name]=inp.value.trim();});return vars;}
function addVarWithKey(name,defaultVal){var id='vr'+(varCount++);var tr=document.createElement('tr');tr.id=id;var enc=String(name||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');var phenc=String(defaultVal||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');tr.innerHTML='<td style="width:42%"><input class="var-key" placeholder="key" value="'+enc+'"></td><td style="width:49%"><input class="var-val" placeholder="'+(phenc||'value')+'" title="default: '+(phenc||'(none)')+'"></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){tr.remove();};var tb=document.getElementById('varRows');if(tb){tb.appendChild(tr);if(!name){var inp=tr.querySelector('.var-val');if(inp)inp.focus();}}}
function addLibVarUnder(btn){var group=btn.getAttribute('data-group');var tbid=btn.getAttribute('data-tbody');var tb=document.getElementById(tbid);if(!tb)return;var tr=document.createElement('tr');tr.setAttribute('data-group',group||'');tr.innerHTML='<td style="width:48%"><input class="var-key lib-name" placeholder="variable"></td><td><input class="var-val lib-val" placeholder="value"></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){tr.remove();};tb.appendChild(tr);var inp=tr.querySelector('.lib-name');if(inp)inp.focus();}



function _collectLibVars(){var m={};document.querySelectorAll('tr[data-group]').forEach(function(row){var g=row.getAttribute('data-group');var n=row.querySelector('.lib-name');var v=row.querySelector('.lib-val');if(g&&n&&v&&g.trim()&&n.value.trim()){var gk=g.trim();if(!m[gk])m[gk]={};m[gk][n.value.trim()]=v.value.trim();}});return m;}

function _renderVariablesPanel(){var body=document.getElementById('variablesPanelBody');if(!body)return;var e=escHtml;var html='';html+='<div class="var-group-label var-toggle" data-target="azureVarsBody" onclick="toggleVarSubSection(this)"><span class="sidebar-toggle"></span>Azure System Variables<button class="sec-save-btn" onclick="_btnClick(event,saveVars)" title="Save">Save</button><button class="sec-save-btn" onclick="_btnClick(event,clearAzureVars)" title="Clear">Clear</button></div><div id="azureVarsBody" style="display:none"><table class="vars-table vars-ref-table"><thead><tr><th class="varth" style="width:38%">Variable</th><th class="varth" style="width:22%">Description</th><th class="varth">Override</th></tr></thead><tbody>';knownVars.azure.forEach(function(v){var en=e(v.name);var ed=e(v.desc||'');html+='<tr><td class="varref-name">'+en+'</td><td class="varref-val">'+ed+'</td><td><input class="var-override-input var-val" data-varname="'+en+'" placeholder="(auto)" style="width:100%"></td></tr>';});html+='</tbody></table></div>';if(knownVars.groups&&knownVars.groups.length){html+='<div class="var-group-label var-toggle" data-target="libVarsBody" onclick="toggleVarSubSection(this)" style="margin-top:8px"><span class="sidebar-toggle"></span>Library Variables<button class="sec-save-btn" onclick="_btnClick(event,saveVars)" title="Save">Save</button><button class="sec-save-btn" onclick="_btnClick(event,clearLibVars)" title="Clear">Clear</button></div><div id="libVarsBody" style="display:none">';knownVars.groups.forEach(function(g,gi){var eg=e(g);var tbid='libvars-'+gi;html+='<div class="var-group-sublabel"><span>'+eg+'</span><button class="add-var-btn" data-group="'+eg+'" data-tbody="'+tbid+'" onclick="addLibVarUnder(this)" title="Add variable">+</button></div><table class="vars-table"><thead><tr><th class="varth" style="width:48%">Variable</th><th class="varth">Value</th><th style="width:5%"></th></tr></thead><tbody id="'+tbid+'"></tbody></table>';});html+='</div>';}body.innerHTML=html;}

function addLibVarToFirstGroup(){
    if(!knownVars.groups||!knownVars.groups.length)return;
    var btn=document.querySelector('#libVarsBody .add-var-btn');
    if(btn)addLibVarUnder(btn);
}

function _renderVariablesPanel(){
    var body=document.getElementById('variablesPanelBody');
    if(!body)return;
    var e=escHtml;
    var html='';
    html+='<div class="var-group-label var-toggle" data-target="azureVarsBody" onclick="toggleVarSubSection(this)"><span class="sidebar-toggle"></span>Azure System Variables</div>';
    html+='<div id="azureVarsBody" style="display:none"><div class="var-group-actions" style="margin:4px 0 6px 0"><button class="sec-save-btn" onclick="_btnClick(event,saveAzureVars)" title="Save Azure System Variables">Save</button><button class="sec-save-btn" onclick="_btnClick(event,clearAzureVars)" title="Clear Azure System Variables">Clear</button></div><table class="vars-table vars-ref-table"><thead><tr><th class="varth" style="width:38%">Variable</th><th class="varth" style="width:22%">Description</th><th class="varth">Override</th></tr></thead><tbody>';
    knownVars.azure.forEach(function(v){
        var en=e(v.name);
        var ed=e(v.desc||'');
        html+='<tr><td class="varref-name">'+en+'</td><td class="varref-val">'+ed+'</td><td><input class="var-override-input var-val" data-varname="'+en+'" placeholder="(auto)" style="width:100%"></td></tr>';
    });
    html+='</tbody></table></div>';
    if(knownVars.groups&&knownVars.groups.length){
        html+='<div class="var-group-label var-toggle" data-target="libVarsBody" onclick="toggleVarSubSection(this)" style="margin-top:8px"><span class="sidebar-toggle"></span>Library Variables</div>';
        html+='<div id="libVarsBody" style="display:none"><div class="var-group-actions" style="margin:4px 0 6px 0"><button class="sec-save-btn" onclick="_btnClick(event,saveLibVars)" title="Save Library Variables">Save</button><button class="sec-save-btn" onclick="_btnClick(event,clearLibVars)" title="Clear Library Variables">Clear</button></div>';
        knownVars.groups.forEach(function(g,gi){
            var eg=e(g);
            var tbid='libvars-'+gi;
            html+='<div class="var-group-sublabel"><span>'+eg+'</span><button class="add-var-btn" data-group="'+eg+'" data-tbody="'+tbid+'" onclick="addLibVarUnder(this)" title="Add Variable">+ Add Variable</button></div>';
            html+='<table class="vars-table"><thead><tr><th class="varth" style="width:48%">Variable</th><th class="varth">Value</th><th style="width:5%"></th></tr></thead><tbody id="'+tbid+'"></tbody></table>';
        });
        html+='</div>';
    }
    body.innerHTML=html;
}

function addVar(){var id='vr'+(varCount++);var tr=document.createElement('tr');tr.id=id;tr.innerHTML='<td style="width:46%"><input class="var-key" placeholder="key"></td><td style="width:49%"><input class="var-val" placeholder="value"></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){document.getElementById(id).remove();};var tb=document.getElementById('varRows');if(!tb){tb=document.createElement('tbody');tb.id='varRows';document.querySelector('.vars-table')?.appendChild(tb);}tb.appendChild(tr);}
function addLibVar(){var id='lv'+(libVarCount++);var tr=document.createElement('tr');tr.id=id;tr.innerHTML='<td style="width:30%"><input class="var-key lib-group" placeholder="group"></td><td style="width:30%"><input class="var-key lib-name" placeholder="variable"></td><td style="width:35%"><input class="var-val lib-val" placeholder="value"></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){document.getElementById(id).remove();};var tb=document.getElementById('libVarRows');if(!tb){tb=document.createElement('tbody');tb.id='libVarRows';document.querySelector('.vars-table:nth-of-type(2)')?.appendChild(tb);}tb.appendChild(tr);}
function runSimulation(){
  try{
    const stages=_collectSelectedStages();
  const buildCounter=document.getElementById('buildCounter').value;
  const variables=_collectAllVars();
  if(document.getElementById('debugMode').checked)variables['System.Debug']='true';
  const buildReason=document.getElementById('buildReason').value;if(buildReason)variables['Build.Reason']=buildReason;
  const sourceBranch=document.getElementById('sourceBranch').value.trim();if(sourceBranch){variables['Build.SourceBranch']=sourceBranch;const sbn=sourceBranch.replace(/^refs\\/heads\\//,'');variables['Build.SourceBranchName']=sbn!==sourceBranch?sbn:sourceBranch.split('/').pop()||sourceBranch;}
  document.getElementById('runBtn').disabled=true;
  
  document.getElementById('statusMsg').textContent='';
    var ob=document.getElementById('browserBtn');if(ob)ob.style.display='none';
    resetSidebarResults();
  document.getElementById('resultsPanel').innerHTML='<div class="sim-loading"><div class="sim-spinner"></div><span>Running simulation…</span></div>';
    var rb=document.getElementById('renderBody');if(rb)rb.classList.remove('hidden');
  var s=document.getElementById('settingsContent');if(s){s.classList.add('collapsed');document.getElementById('settingsPanel').classList.add('collapsed');var btn=document.getElementById('settingsToggle');if(btn)btn.innerHTML='&#9660; Settings';}
  var bb=document.getElementById('backBtn');if(bb)bb.style.display='inline-block';
  const libVars=_collectLibVars();
    const parameters=_collectTopLevelParameters();
    vscode.postMessage({command:'runSimulation',stages,buildCounter,variables,libraryVariables:libVars,parameters,toolPaths:_collectToolPaths()});
  }catch(e){console.error('[aps] runSimulation error',e);document.getElementById('resultsPanel').innerHTML='';document.getElementById('statusMsg').textContent='⚠ JS error: '+String(e);document.getElementById('runBtn').disabled=false;}
}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function toggleRes(hd){var body=hd.nextElementSibling;if(!body)return;var c=body.classList.toggle('collapsed');var t=hd.querySelector('.res-tog');if(t)t.textContent=c?'\u25b6':'\u25bc';}
function openResultsInBrowser(){
    var results=document.getElementById('resultsPanel');
    var sidebar=document.querySelector('.sidebar');
    if(!results||!results.querySelector('.res-wrap')||!sidebar)return;
    var styleEl=document.getElementById('mainStyle');
    var css=styleEl?styleEl.textContent:'';
    var resultsClone=results.cloneNode(true);
    var sidebarClone=sidebar.cloneNode(true);
    var btn=resultsClone.querySelector('.res-browser-btn');
    if(btn)btn.remove();
    sidebarClone.querySelectorAll('[onclick]').forEach(function(el){el.removeAttribute('onclick');});

    var extraCss='body{height:auto;min-height:100vh;overflow:auto}.main-container{height:auto;min-height:100vh;overflow:visible}.sidebar,.body{overflow:visible}.export-content{flex:1;padding:16px 20px}.export-title{padding:14px 20px;border-bottom:2px solid #555;background:#2d2d30;color:#e8e8e8;font-size:1.05em;font-weight:600}';

    var exportScript='(' + function () {
        function expandResultsForTask(stageIndex, jobIndex) {
            var panel = document.querySelector('.export-content');
            if (!panel) return;

            var stage = panel.querySelector('.res-stage[data-stage-index="' + stageIndex + '"]');
            if (stage) {
                var stageHeader = stage.querySelector('.res-stage-hd');
                var stageBody = stageHeader ? stageHeader.nextElementSibling : null;
                if (stageBody && stageBody.classList.contains('collapsed')) {
                    stageBody.classList.remove('collapsed');
                    var stageToggle = stageHeader.querySelector('.res-tog');
                    if (stageToggle) stageToggle.textContent = '▼';
                }
            }

            var job = panel.querySelector(
                '.res-job[data-stage-index="' + stageIndex + '"][data-job-index="' + jobIndex + '"]'
            );
            if (!job) return;
            var jobHeader = job.querySelector('.res-job-hd');
            var jobBody = jobHeader ? jobHeader.nextElementSibling : null;
            if (jobBody && jobBody.classList.contains('collapsed')) {
                jobBody.classList.remove('collapsed');
                var jobToggle = jobHeader.querySelector('.res-tog');
                if (jobToggle) jobToggle.textContent = '▼';
            }
        }

        function applyTaskFilter(filter) {
            var panel = document.querySelector('.export-content');
            if (!panel) return;
            var summary = panel.querySelector('.res-summary');
            var steps = panel.querySelectorAll('.res-step');
            if (!steps.length) return;

            if (!filter) {
                panel.querySelectorAll('.res-stage,.res-job,.res-step').forEach(function (el) {
                    el.style.display = '';
                });
                if (summary) summary.style.display = '';
                return;
            }

            steps.forEach(function (el) {
                var show =
                    el.getAttribute('data-stage-index') === filter.stageIndex &&
                    el.getAttribute('data-job-index') === filter.jobIndex &&
                    el.getAttribute('data-step-index') === filter.stepIndex;
                el.style.display = show ? '' : 'none';
            });

            panel.querySelectorAll('.res-job').forEach(function (jobEl) {
                var visible = Array.from(jobEl.querySelectorAll('.res-step')).some(function (step) {
                    return step.style.display !== 'none';
                });
                jobEl.style.display = visible ? '' : 'none';
            });

            panel.querySelectorAll('.res-stage').forEach(function (stageEl) {
                var visible = Array.from(stageEl.querySelectorAll('.res-job')).some(function (jobEl) {
                    return jobEl.style.display !== 'none';
                });
                stageEl.style.display = visible ? '' : 'none';
            });

            if (summary) summary.style.display = 'none';
        }

        function toggleResultHeader(headerEl) {
            var body = headerEl.nextElementSibling;
            if (!body) return;
            var collapsed = body.classList.toggle('collapsed');
            var toggle = headerEl.querySelector('.res-tog');
            if (toggle) toggle.textContent = collapsed ? '▶' : '▼';
        }

        document.querySelectorAll('.res-collapsible').forEach(function (headerEl) {
            headerEl.addEventListener('click', function () {
                toggleResultHeader(headerEl);
            });
        });

        document.querySelectorAll('.sidebar-task-row').forEach(function (taskRow) {
            taskRow.addEventListener('click', function () {
                document.querySelectorAll('.sidebar-task-row').forEach(function (el) {
                    el.classList.remove('active');
                });
                taskRow.classList.add('active');

                var filter = {
                    stageIndex: String(taskRow.getAttribute('data-stage-index') || ''),
                    jobIndex: String(taskRow.getAttribute('data-job-index') || ''),
                    stepIndex: String(taskRow.getAttribute('data-step-index') || ''),
                };

                expandResultsForTask(filter.stageIndex, filter.jobIndex);
                applyTaskFilter(filter);
            });
        });

        document.querySelectorAll('.sidebar-stage-header').forEach(function (stageHeader) {
            stageHeader.addEventListener('click', function () {
                var stageWrap = stageHeader.parentElement;
                if (!stageWrap) return;
                document.querySelectorAll('.sidebar-task-row').forEach(function (el) {
                    el.classList.remove('active');
                });
                applyTaskFilter(null);
                var stageBody = stageWrap.querySelector('.sidebar-stage-jobs');
                if (!stageBody) return;
                var collapsed = stageBody.classList.toggle('collapsed');
                var stageToggle = stageHeader.querySelector('.sidebar-toggle');
                if (stageToggle) stageToggle.classList.toggle('open', !collapsed);
            });
        });

        document.querySelectorAll('.sidebar-job-header').forEach(function (jobHeader) {
            jobHeader.addEventListener('click', function () {
                var jobWrap = jobHeader.parentElement;
                if (!jobWrap) return;
                var jobBody = jobWrap.querySelector('.sidebar-job-steps');
                if (!jobBody) return;
                var collapsed = jobBody.classList.toggle('collapsed');
                var jobToggle = jobHeader.querySelector('.sidebar-toggle');
                if (jobToggle) jobToggle.classList.toggle('open', !collapsed);
            });
        });
    }.toString() + ')();';

    vscode.postMessage({
        command:'openResultsInBrowser',
        html:'<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Simulation Results</title><style>'+css+extraCss+'</style></head><body><div class="export-title">Pipeline Simulation Results</div><div class="main-container">'+sidebarClone.outerHTML+'<div class="export-content">'+resultsClone.innerHTML+'</div></div><scr'+'ipt>'+exportScript+'<\/scr'+'ipt></body></html>'
    });
}
function renderResults(r){
  const panel=document.getElementById('resultsPanel');
  const ICON={Succeeded:'\u2714',Failed:'\u2716',Skipped:'\u29d8'};
  const COL={Succeeded:'#4ec94e',Failed:'#f47174',Skipped:'#c8a84b'};
    const WARN='#c8a84b';
    const ERR='#f47174';
    const normalizeLogLine=(line)=>String(line||'').replace(/\\x1b\\[[0-9;]*m/g,'').replace(/^\\s*\\[stderr\\]\\s*/i,'').trim();
    const extractVsoFromTraceEcho=(line)=>{
        const raw=normalizeLogLine(line);
        const m=/^\\+{1,3}\\s+echo\\s+['\\"](##vso\\[[^\\]]+\\][\\s\\S]*)['\\"]$/.exec(raw);
        return m?m[1]:'';
    };
    const isHiddenTraceNoise=(line)=>{
        const raw=normalizeLogLine(line);
        return /^\\+{1,3}\\s+_aps_trace_pause\\b/.test(raw)||
            /^\\+{1,3}\\s+_aps_trace_resume\\b/.test(raw)||
            /^\\+{1,3}\\s+case\\s+"\\$-"\\s+in\\b/.test(raw)||
            /^\\+{1,3}\\s+_APS_TRACE_WAS_ON=/.test(raw)||
            /^\\+{1,3}\\s+set\\s+\\+x\\b/.test(raw)||
            /^\\+{1,3}\\s+set\\s+-x\\b/.test(raw)||
            /^\\+{1,3}\\s+exit\\s+1$/.test(raw);
    };
    const shouldShowStdoutLine=(line)=>{
        const raw=normalizeLogLine(line);
        if(!raw)return false;
        if(/^##vso\\[/i.test(raw)){
            return /^##vso\\[task\\.logissue\\s+type=(error|warning)[^\\]]*\\]/i.test(raw)||/^##vso\\[task\\.debug\\]/i.test(raw);
        }
        return true;
    };
    const formatRenderedLine=(line,isStderr)=>{
        const tracedVso=extractVsoFromTraceEcho(line);
        const raw=tracedVso||normalizeLogLine(line);
        let color='';
        if(/^##\\s*\\[debug\\]/i.test(raw)||/^##vso\\[task\\.debug\\]/i.test(raw)||/^##vso\\[task\\.logissue\\s+type=warning[^\\]]*\\]/i.test(raw)) color=WARN;
        if(/^##\\s*\\[error\\]/i.test(raw)||/^##vso\\[task\\.logissue\\s+type=error[^\\]]*\\]/i.test(raw)) color=ERR;
        const prefix=isStderr?'<span class="res-vk">[stderr]</span> ':'';
        const content=escHtml(raw);
        return color?'<div>'+prefix+'<span style="color:'+color+'">'+content+'</span></div>':'<div>'+prefix+content+'</div>';
    };
    let html='<div class="res-wrap">';
    for(let si=0;si<r.stages.length;si++){
        const stage=r.stages[si];
    const sn=escHtml(stage.displayName||stage.stage);
        html+='<div class="res-stage" data-stage-index="'+si+'"><div class="res-stage-hd res-collapsible">'+sn+'<span class="res-tog">\u25b6</span></div><div class="res-body collapsed">';
        for(let ji=0;ji<stage.jobs.length;ji++){
            const job=stage.jobs[ji];
      const jn=escHtml(job.displayName||job.job);
            html+='<div class="res-job" data-stage-index="'+si+'" data-job-index="'+ji+'"><div class="res-job-hd res-collapsible">\u25b6 '+jn+'<span class="res-tog">\u25b6</span></div><div class="res-body collapsed">';
            for(let ti=0;ti<job.steps.length;ti++){
                const step=job.steps[ti];
        const res=step.result||'Skipped';
        const icon=ICON[res]||'?';
        const col=COL[res]||'#888';
                html+='<div class="res-step" data-stage-index="'+si+'" data-job-index="'+ji+'" data-step-index="'+ti+'"><span class="res-icon" style="color:'+col+'">'+icon+'</span><span class="res-step-name">'+escHtml(step.displayName||'')+'</span>';
        if(step.stdout&&step.stdout.trim()){
                    const lines=step.stdout.split('\\n').filter(l=>shouldShowStdoutLine(l)).map(l=>formatRenderedLine(l,false)).join('');
          html+='<div class="res-out">'+lines+'</div>';
        }
                if(step.stderr&&step.stderr.trim()){
                                        const errLines=step.stderr.split('\\n').filter(l=>normalizeLogLine(l)&&!isHiddenTraceNoise(l)).map(l=>formatRenderedLine(l,true)).join('');
                    html+='<div class="res-out">'+errLines+'</div>';
                }
        const ov=Object.entries(step.outputVariables||{});
        const lv=Object.entries(step.variables||{}).filter(([k])=>!step.outputVariables||!(k in step.outputVariables));
        if(ov.length||lv.length){
          html+='<div class="res-vars">';
          for(const[k,v]of lv)html+='<div class="res-var"><span class="res-vk">[var]</span> '+escHtml(k)+'='+escHtml(v)+'</div>';
          for(const[k,v]of ov)html+='<div class="res-var res-out-var"><span class="res-vk">[out]</span> '+escHtml(k)+'='+escHtml(v)+'</div>';
          html+='</div>';
        }
        html+='</div>';
      }
      html+='</div></div>';
    }
    html+='</div></div>';
  }
  const total=r.totalPassed+r.totalFailed+r.totalSkipped;
  html+='<div class="res-summary"><span style="color:#4ec94e">\u2714 '+r.totalPassed+' passed</span>  <span style="color:#f47174">\u2716 '+r.totalFailed+' failed</span>  <span style="color:#c8a84b">\u29d8 '+r.totalSkipped+' skipped</span>  <span style="color:#888">'+total+' total</span></div>';
  html+='</div>';
  panel.innerHTML=html;
        var browserBtn=document.getElementById('browserBtn');if(browserBtn)browserBtn.style.display='inline-block';
    panel.querySelectorAll('.res-body.collapsed').forEach(function(el){el.classList.remove('collapsed');});
    panel.querySelectorAll('.res-tog').forEach(function(el){el.textContent='\u25bc';});
        updateSidebarResults(r);
        if(taskFilter){
                expandResultsForTask(taskFilter.stageIndex,taskFilter.jobIndex);
        }
    applyTaskFilter();
  panel.scrollIntoView({behavior:'smooth',block:'start'});
}
document.getElementById('resultsPanel').addEventListener('click',function(e){
  var hd=e.target.closest('.res-collapsible');if(!hd)return;
  var body=hd.nextElementSibling;if(!body)return;
  var c=body.classList.toggle('collapsed');
  var t=hd.querySelector('.res-tog');if(t)t.textContent=c?'\u25b6':'\u25bc';
});
requestAnimationFrame(function(){requestAnimationFrame(function(){var l=document.getElementById('pageLoader');if(l)l.remove();});});
renderTopLevelParameters();
function _syncOverrideToSettings(vn,val){if(vn==='Build.SourceBranch'){var sb=document.getElementById('sourceBranch');if(sb)sb.value=val;}else if(vn==='Build.SourceBranchName'){/* skip */}else if(vn==='Build.Reason'){var br=document.getElementById('buildReason');if(br)br.value=val;}else if(vn==='System.Debug'){var dbg=document.getElementById('debugMode');if(dbg)dbg.checked=val==='true'||val==='1';}else if(vn==='Build.BuildNumber'||vn==='Build.BuildId'){var bc=document.getElementById('buildCounter');if(bc&&vn==='Build.BuildNumber')bc.value=val;}}function _applyVarsLoaded(data){if(!data)return;var o=data.overrides||{};document.querySelectorAll('.var-override-input').forEach(function(inp){var name=inp.getAttribute('data-varname');if(o[name]!==undefined)inp.value=o[name];});if(Array.isArray(data.libData)){data.libData.forEach(function(entry){var gi=knownVars.groups.indexOf(entry.group);if(gi<0)return;var tb=document.getElementById('libvars-'+gi);if(!tb)return;tb.innerHTML='';if(!Array.isArray(entry.vars))return;entry.vars.forEach(function(v){var tr=document.createElement('tr');tr.setAttribute('data-group',entry.group);var en=escHtml(v.name||'');var ev=escHtml(v.value||'');tr.innerHTML='<td style="width:48%"><input class="var-key lib-name" placeholder="variable" value="'+en+'"></td><td><input class="var-val lib-val" placeholder="value" value="'+ev+'"></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){tr.remove();};tb.appendChild(tr);});});}if(data.toolPaths&&typeof data.toolPaths==='object'){var ttp=document.getElementById('toolPathsRows');if(ttp){ttp.innerHTML='';Object.entries(data.toolPaths).forEach(function(kv){var tr=document.createElement('tr');var en=escHtml(kv[0]||'');var ev=escHtml(kv[1]||'');tr.innerHTML='<td style="width:48%"><input class="var-key tool-name" placeholder="tool (e.g. bash)" value="'+en+'"></td><td><input class="var-val tool-path" placeholder="path" value="'+ev+'"></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){tr.remove();};ttp.appendChild(tr);});}}try{syncSpecialVarToPanel();}catch(e){}}window.addEventListener('load',function(){_renderVariablesPanel();_renderToolPathsPanel();_applyVarsLoaded(savedVars);setTimeout(function(){expandAll(false);selectStage(0);syncSpecialVarToPanel();syncSelectAllStages();var pb=document.getElementById('variablesPanelBody');if(pb)pb.addEventListener('input',function(e){var inp=e.target;if(!inp.classList.contains('var-override-input'))return;_syncOverrideToSettings(inp.getAttribute('data-varname'),inp.value);});vscode.postMessage({command:'loadVars'});},50);});
window.addEventListener('message',e=>{
  const d=e.data;
  if(d.command==='simulationStarted'){document.getElementById('runBtn').disabled=false;}
  else if(d.command==='simulationResults'){document.getElementById('runBtn').disabled=false;renderResults(d.results);}
    else if(d.command==='simulationError'){document.getElementById('resultsPanel').innerHTML='';document.getElementById('statusMsg').textContent='\u26a0 '+d.error;document.getElementById('runBtn').disabled=false;var browserBtn=document.getElementById('browserBtn');if(browserBtn)browserBtn.style.display='none';}
  else if(d.command==='varsLoaded'){_applyVarsLoaded(d.data);}
});
<\/script>
</body></html>`;
    /* eslint-enable prettier/prettier */
}

function activate(context) {
    if (!vscode) {
        console.warn('VS Code API unavailable; activate() skipped (CLI execution detected).');
        return;
    }

    console.log('Azure Pipeline YAML Parser extension is now active!');
    const runtimeGeneration = ++extensionRuntimeGeneration;
    const parser = new AzurePipelineParser();
    const dependencyAnalyzer = new DependencyAnalyzer(parser);
    let lastRenderedDocument;
    let debounceTimer;
    let errorDebounceTimer;
    const errorDebounceDelayMs = 500;
    let isRendering = false;
    let pendingDocument = null;
    let pendingError = null;
    const renderedScheme = 'ado-pipeline-expanded';
    const renderedContent = new Map();
    const renderedEmitter = new vscode.EventEmitter();
    let dependenciesPanel;
    let dependenciesPanelHtml = '';
    let dependenciesDocumentUri;
    let dependenciesDebounceTimer;
    let isDependenciesRendering = false;
    let pendingDependenciesDocument = null;
    let simulationPanel = null;
    const canUseVsCodeUi = () => !!vscode && runtimeGeneration === extensionRuntimeGeneration;

    context.subscriptions.push(renderedEmitter);
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(renderedScheme, {
            onDidChange: renderedEmitter.event,
            provideTextDocumentContent: (uri) => renderedContent.get(uri.toString()) || '',
        })
    );

    const getRenderTargetUri = (document) => {
        const baseName = path.basename(document.fileName || 'pipeline.yml') || 'pipeline.yml';
        const sourceId = encodeURIComponent(document.fileName || baseName);
        return vscode.Uri.from({
            scheme: renderedScheme,
            path: '/' + baseName,
            query: `${sourceId}|expanded`,
        });
    };

    const getFormatSettings = (document) => {
        const defaults = {
            noArrayIndent: true,
            indent: 2,
            lineWidth: 0,
            forceQuotes: false,
            sortKeys: false,
            firstBlockBlankLines: 2,
            betweenSectionBlankLines: 1,
            normalizeAzureVariablePaths: true,
            newlineFormat: '\n',
        };

        if (!vscode) return defaults;

        try {
            const config = vscode.workspace.getConfiguration(
                'azurePipelineStudio',
                document ? document.uri : undefined
            );
            const result = { ...defaults };

            const booleanSettings = [
                'noArrayIndent',
                'forceQuotes',
                'sortKeys',
                'stepSpacing',
                'normalizeAzureVariablePaths',
            ];
            booleanSettings.forEach((key) => {
                const value = config.get(`format.${key}`);
                if (typeof value === 'boolean') result[key] = value;
            });

            const indent = config.get('format.indent');
            if (Number.isInteger(indent) && indent > 0 && indent <= 8) {
                result.indent = indent;
            }

            const lineWidth = config.get('format.lineWidth');
            if (typeof lineWidth === 'number' && lineWidth >= 0) {
                result.lineWidth = lineWidth;
            }

            const integerSettings = [
                { key: 'firstBlockBlankLines', min: 0, max: 4 },
                { key: 'betweenSectionBlankLines', min: 0, max: 4 },
            ];
            integerSettings.forEach(({ key, min, max }) => {
                const value = config.get(`format.${key}`);
                if (Number.isInteger(value) && value >= min && value <= max) {
                    result[key] = value;
                }
            });

            const newlineFormat = config.get('format.newlineFormat');
            if (newlineFormat === '\n' || newlineFormat === '\r\n') {
                result.newlineFormat = newlineFormat;
            }

            return result;
        } catch (error) {
            console.warn('Failed to read azurePipelineStudio.format settings:', error);
            return defaults;
        }
    };

    const formatOriginalDocument = async (document) => {
        if (!document) {
            return;
        }

        const originalText = document.getText();
        let formatResult;
        try {
            const formatOptions = getFormatSettings(document);
            formatOptions.fileName = document.fileName;
            formatOptions.wasExpanded = false;
            formatResult = formatYaml(originalText, formatOptions);

            if (formatResult.error) {
                const errorValue =
                    formatResult.error instanceof Error ? formatResult.error : new Error(String(formatResult.error));
                showErrorWebview(errorValue, context, 'formatting');
                return;
            }
        } catch (error) {
            const errorMessage =
                error && error.message ? error.message : 'An unexpected error occurred during YAML formatting';
            showErrorWebview(errorMessage, context, 'formatting');
            return;
        }

        const fullRange = document.validateRange(
            new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, formatResult.text);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showErrorMessage('Failed to apply YAML formatting changes.');
            return;
        }

        // Close error panel on successful formatting
        closeErrorPanel();

        if (formatResult.warning) {
            vscode.window.showWarningMessage(formatResult.warning);
        } else {
            vscode.window.setStatusBarMessage('Applied YAML formatting.', 3000);
        }
    };

    let errorPanelOpen = false;
    let currentErrorPanel = null;

    // Register openErrorFile command once at activation
    context.subscriptions.push(
        vscode.commands.registerCommand('azurePipelineStudio.openErrorFile', async (filePath, lineNumber) => {
            try {
                const document = await vscode.workspace.openTextDocument(filePath);
                const options = { preview: false };
                if (lineNumber && lineNumber > 0) {
                    const position = new vscode.Position(lineNumber - 1, 0);
                    options.selection = new vscode.Range(position, position);
                }
                await vscode.window.showTextDocument(document, options);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
            }
        })
    );

    const showErrorWebviewNow = (error, context, errorType = 'expansion') => {
        if (!canUseVsCodeUi()) {
            return;
        }
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        const errorStackText = normalizedError.stack || '';
        // Dispose of existing error panel before creating a new one
        if (currentErrorPanel) {
            try {
                currentErrorPanel.dispose();
            } catch (e) {
                // Panel already disposed, ignore
            }
            currentErrorPanel = null;
        }

        // Determine panel title based on error type
        const titles = {
            expansion: '❌ Pipeline Expansion Error',
            formatting: '❌ YAML Formatting Error',
            dependency: '❌ Dependency Analysis Error',
        };
        const title = titles[errorType] || '❌ Pipeline Error';

        // Create webview panel
        const panel = vscode.window.createWebviewPanel('azurePipelineError', title, vscode.ViewColumn.Two, {
            enableScripts: true,
        });

        // Store reference to current error panel
        currentErrorPanel = panel;

        // Explicitly reveal the panel to ensure it's visible
        panel.reveal(vscode.ViewColumn.Two);

        // Mark error panel as open
        errorPanelOpen = true;

        // Clean up when panel is disposed
        panel.onDidDispose(() => {
            errorPanelOpen = false;
            currentErrorPanel = null;
        });

        const escapeHtml = (text) => {
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };

        // Collect repo root base dirs for resolving absolute-style template paths
        // Primary: parse call stack pairs (/rel/path.yaml, \\unc\path.yaml) and strip the template
        // suffix from the UNC path to derive the exact repo root.
        // Fallback: use the parent directory of any bare UNC path found in the error text.
        const templateResolveBaseDirs = [];
        const errorText = normalizedError.message || String(normalizedError);

        // Extract (templateRelPath, uncPath) pairs from call stack entries.
        const stackPairRegex = /([^\s\(]+\.ya?ml(?:@[^:\s]+)?)(?::\d+)?\s+\((\\\\[^\)]+\.ya?ml)\)/g;
        let stackPairMatch;
        while ((stackPairMatch = stackPairRegex.exec(errorText)) !== null) {
            const templateRef = stackPairMatch[1].split('@')[0]; // strip @repo suffix
            const uncPath = stackPairMatch[2];
            // Normalize separators to compare suffix
            const uncNorm = uncPath.replace(/\\/g, '/');
            const tmplNorm = templateRef.replace(/\\/g, '/');
            if (uncNorm.endsWith(tmplNorm)) {
                const root = uncPath.slice(0, uncPath.length - templateRef.length).replace(/[/\\]+$/, '');
                if (root && !templateResolveBaseDirs.includes(root)) templateResolveBaseDirs.push(root);
            }
        }

        // Fallback: use the immediate parent directory of any bare UNC path in the error text.
        for (const uncFilePath of [...errorText.matchAll(/(\\\\[^\s\n\)]+\.ya?ml)/g)].map((m) => m[1])) {
            const dir = path.dirname(uncFilePath);
            if (dir && !templateResolveBaseDirs.includes(dir)) templateResolveBaseDirs.push(dir);
        }

        if (lastRenderedDocument) {
            try {
                const resourceOverrides = buildResourceOverridesForDocument(lastRenderedDocument);
                if (resourceOverrides && resourceOverrides.repositories) {
                    for (const entry of Object.values(resourceOverrides.repositories)) {
                        const loc = entry && entry.location;
                        if (loc && typeof loc === 'string' && !templateResolveBaseDirs.includes(loc)) {
                            templateResolveBaseDirs.push(loc);
                        }
                    }
                }
                const wf = vscode.workspace.getWorkspaceFolder(lastRenderedDocument.uri);
                if (wf && wf.uri && wf.uri.fsPath && !templateResolveBaseDirs.includes(wf.uri.fsPath)) {
                    templateResolveBaseDirs.push(wf.uri.fsPath);
                }
            } catch (e) {
                /* ignore */
            }
        }

        // Convert file paths in text to clickable links
        const makePathsClickable = (text) => {
            const placeholders = [];
            let placeholderIndex = 0;

            // First handle template stack format with repository references:
            // Format: /templates/file.yaml@repo:46 (\\actual\path\file.yaml)
            // or: /templates/file.yaml:46 (\\actual\path\file.yaml)
            // Also handle format without line number: /templates/file.yaml@repo (\\actual\path\file.yaml)
            // Extract line number and actual path, make the template reference clickable, hide UNC path
            const templateStackRegex =
                /([^\s\(]+\.ya?ml(?:@[^:]+)?)(?::(\d+))?\s+\((\\\\[^\)]+\.ya?ml|[A-Za-z]:[^\)]+\.ya?ml|\/[^\)]+\.ya?ml)\)/g;
            text = text.replace(templateStackRegex, (match, templatePath, lineNumber, actualPath) => {
                // Skip extension bundle paths
                if (actualPath && actualPath.includes('extension-bundle.js')) {
                    return match;
                }

                if (actualPath) {
                    const escapedPath = actualPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                    const displayText = lineNumber ? `${templatePath}:${lineNumber}` : templatePath;
                    const link = `<a class="file-link" href="#" title="${escapeHtml(actualPath)}" onclick="openFile('${escapedPath}', ${lineNumber || 'null'}); return false;">${escapeHtml(displayText)}</a>`;
                    const placeholder = `___PLACEHOLDER_${placeholderIndex}___`;
                    placeholders.push(link);
                    placeholderIndex++;
                    return placeholder;
                }
                return match;
            });

            // Then handle standard format: path/file.yaml:LINE
            const pathRegex =
                /(\\\\[^\s\n:]+\.(?:ya?ml|js|ts))(?::(\d+))?(?::(\d+))?|([A-Za-z]:\\[^\s\n:]+\.(?:ya?ml|js|ts))(?::(\d+))?(?::(\d+))?|(\/[^\s\n:]+\.(?:ya?ml|js|ts))(?::(\d+))?(?::(\d+))?/g;

            text = text.replace(
                pathRegex,
                (match, uncPath, uncLine, uncCol, winPath, winLine, winCol, unixPath, unixLine, unixCol) => {
                    let filePath = uncPath || winPath || unixPath;
                    const lineNumber = uncLine || winLine || unixLine;

                    // Skip extension bundle paths
                    if (filePath && filePath.includes('extension-bundle.js')) {
                        return match;
                    }

                    // For absolute-style template paths, resolve against known repository roots so the link points to the actual file on disk.
                    if (unixPath && templateResolveBaseDirs.length) {
                        const resolved = templateResolveBaseDirs
                            .map((base) => path.join(base, unixPath))
                            .find((candidate) => {
                                try {
                                    return fs.existsSync(candidate);
                                } catch {
                                    return false;
                                }
                            });
                        if (resolved) filePath = resolved;
                    }

                    if (filePath) {
                        const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                        const lineParam = lineNumber ? lineNumber : 'null';
                        return `<a class="file-link" href="#" title="${escapeHtml(filePath)}" onclick="openFile('${escapedPath}', ${lineParam}); return false;">${escapeHtml(match)}</a>`;
                    }
                    return match;
                }
            );

            // Restore placeholders
            placeholders.forEach((link, index) => {
                text = text.replace(`___PLACEHOLDER_${index}___`, link);
            });

            return text;
        };

        // Format error message with line breaks and proper indentation
        const formatErrorMessage = (text) => {
            // First escape HTML
            const escaped = escapeHtml(text);
            // Make paths clickable
            const withLinks = makePathsClickable(escaped);
            // Convert newlines to <br> and preserve spaces
            return withLinks
                .split('\n')
                .map((line) => line.replace(/^( +)/, (match) => '&nbsp;'.repeat(match.length)))
                .join('<br>');
        };

        const parseErrorSections = (text) => {
            const lines = String(text || '').split('\n');
            const messageLines = [];
            const templateLines = [];
            const tipLines = [];

            let i = 0;
            while (i < lines.length) {
                const trimmed = lines[i].trim();
                const tipHeaderMatch = /^.*tips?:/i.exec(trimmed);
                if (trimmed.toLowerCase() === 'template call stack:') {
                    i++;
                    while (i < lines.length && lines[i].trim()) {
                        templateLines.push(lines[i].trim());
                        i++;
                    }
                    continue;
                }
                if (tipHeaderMatch) {
                    const afterColon = trimmed.split(':').slice(1).join(':').trim();
                    if (afterColon) {
                        tipLines.push(afterColon);
                    }
                    i++;
                    while (i < lines.length && lines[i].trim()) {
                        tipLines.push(lines[i].trim());
                        i++;
                    }
                    continue;
                }

                messageLines.push(lines[i]);
                i++;
            }

            return { messageLines, templateLines, tipLines };
        };

        const extractTemplateCallStackFromText = (text) => {
            const match = /Template call stack:\s*([\s\S]*?)(?:\n\s*\n|$)/i.exec(String(text || ''));
            if (!match || !match[1]) {
                return [];
            }

            return match[1]
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
        };

        const rawErrorText = normalizedError.message || String(normalizedError);
        const undefinedParamMatch = /Undefined template parameter '([^']+)'/.exec(rawErrorText);
        const parsedSections = parseErrorSections(rawErrorText);
        let messageLines = parsedSections.messageLines.filter((line) => line.trim().length);
        let templateLines = parsedSections.templateLines;
        let tipLines = parsedSections.tipLines;

        if (!templateLines.length) {
            templateLines = extractTemplateCallStackFromText(rawErrorText);
        }

        if (!templateLines.length && errorStackText) {
            templateLines = extractTemplateCallStackFromText(errorStackText);
        }

        if (undefinedParamMatch) {
            const paramName = undefinedParamMatch[1];
            messageLines = [`Undefined template parameter '${paramName}'.`];
            tipLines = [
                `- Ensure '${paramName}' is declared in the 'parameters' section`,
                '- Check if the reference should use a loop object instead of parameters (For e.g. {{ each cfg in configurations }}:, properties inside cfg should be referred with cfg.name)',
            ];
            if (!templateLines.length && errorStackText) {
                templateLines = extractTemplateCallStackFromText(errorStackText);
            }
        }

        if (tipLines.length === 0 && errorType === 'expansion') {
            tipLines = [
                '- Undefined or circular template references',
                '- Missing or incorrect parameter values',
                '- Malformed YAML structure in referenced templates',
                '- Use "Pipeline Diagram" to see the complete dependency graph and identify the root cause.',
            ];
        }

        const detailsLines = [];
        if (messageLines.length) {
            detailsLines.push(...messageLines);
        }

        if (templateLines.length) {
            detailsLines.push('Template call stack:');
            templateLines.forEach((line) => {
                detailsLines.push(`  ${line}`);
            });
        }

        const errorDetailsText = detailsLines.join('\n');

        const tipLinesNormalized = tipLines.map((line) =>
            line.startsWith('-') || line.startsWith('•') ? line : `- ${line}`
        );

        const suggestPipelineRoot =
            errorType === 'expansion' &&
            lastRenderedDocument &&
            !/^\s*-?\s*template\s*:.*@\w+/m.test(
                typeof lastRenderedDocument.getText === 'function' ? lastRenderedDocument.getText() : ''
            );
        const pipelineRootTipLine = suggestPipelineRoot
            ? `- <a class="file-link" href="#" onclick="configurePipelineRoot(); return false;">Configure Pipeline Root</a> if your templates use absolute paths (e.g. /stages/step.yaml) and no repository resources are defined.`
            : '';

        const tipsHtml =
            tipLinesNormalized.length || pipelineRootTipLine
                ? `
                    <h2>Tips</h2>
                    <div class="error-details">
                        ${pipelineRootTipLine ? `<code>${pipelineRootTipLine}</code>` : ''}
                        ${tipLinesNormalized.length ? `<code>${formatErrorMessage(tipLinesNormalized.join('\n'))}</code>` : ''}
                    </div>
            `
                : '';

        const stackLines = errorStackText
            .split('\n')
            .filter((line, index) => index === 0 || line.trim().startsWith('at '));
        // Keep first line (error location), add indentation to 'at' lines
        const sanitizedStackText =
            stackLines.length > 0
                ? stackLines
                      .map((line, index) => {
                          if (index === 0) return line; // Keep first line as is
                          return line.trim().startsWith('at ') ? `  ${line.trim()}` : line;
                      })
                      .join('\n')
                : '';

        // Build HTML content with proper styling
        let htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                        line-height: 1.6;
                        color: #e0e0e0;
                        background-color: #1e1e1e;
                        padding: 20px;
                        margin: 0;
                    }
                    .error-container {
                        max-width: 900px;
                        margin: 0 auto;
                    }
                    h1 {
                        color: #ff6b6b;
                        margin-top: 0;
                        font-size: 1.8em;
                    }
                    h2 {
                        color: #ff9f43;
                        margin-top: 20px;
                        font-size: 1.3em;
                        border-bottom: 1px solid #444;
                        padding-bottom: 8px;
                    }
                    .error-details {
                        background-color: #252526;
                        border-left: 3px solid #ff6b6b;
                        padding: 12px;
                        margin: 12px 0;
                        border-radius: 4px;
                        overflow-x: auto;
                        line-height: 1.8;
                    }
                    .error-details code {
                        font-family: 'Courier New', Courier, monospace;
                        font-size: 0.95em;
                        color: #ce9178;
                        white-space: normal;
                        display: block;
                    }
                    .tip-box {
                        background-color: #1f3a2c;
                        border-left: 3px solid #4ec9b0;
                        padding: 12px;
                        margin: 12px 0;
                        border-radius: 4px;
                    }
                    .tip-label {
                        font-weight: bold;
                        color: #4ec9b0;
                        margin-bottom: 8px;
                    }
                    ul {
                        margin: 8px 0;
                        padding-left: 20px;
                    }
                    li {
                        margin: 4px 0;
                    }
                    .file-link {
                        color: #569cd6;
                        text-decoration: underline;
                        cursor: pointer;
                        font-family: inherit;
                    }
                    .file-link:hover {
                        color: #4fc3f7;
                    }
                    .stack-trace {
                        background-color: #252526;
                        border-left: 3px solid #888;
                        padding: 12px;
                        margin: 12px 0;
                        border-radius: 4px;
                        overflow-x: auto;
                        font-family: 'Courier New', Courier, monospace;
                        font-size: 0.9em;
                        color: #d4d4d4;
                        max-height: 400px;
                        overflow-y: auto;
                    }
                    .file-list {
                        background-color: #252526;
                        border-left: 3px solid #569cd6;
                        padding: 12px;
                        margin: 12px 0;
                        border-radius: 4px;
                    }
                    .hr {
                        border: none;
                        border-top: 1px solid #444;
                        margin: 16px 0;
                    }
                </style>
            </head>
            <body>
                <div class="error-container">
                    <h1>${escapeHtml(title)}</h1>
                    
                    <h2>Error Details</h2>
                    <div class="error-details">
                        <code>${formatErrorMessage(errorDetailsText)}</code>
                    </div>

                    ${tipsHtml}

                    <h2>Stack Trace</h2>
                    <div class="stack-trace">
                        <pre>${makePathsClickable(escapeHtml(sanitizedStackText || 'No stack trace available'))}</pre>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    function openFile(filePath, lineNumber) {
                        vscode.postMessage({
                            command: 'openFile',
                            filePath: filePath,
                            lineNumber: lineNumber
                        });
                    }
                    function configurePipelineRoot() {
                        vscode.postMessage({ command: 'configurePipelineRoot' });
                    }
                </script>
            </body>
            </html>
        `;

        panel.webview.html = htmlContent;

        // Handle messages from webview
        panel.webview.onDidReceiveMessage((message) => {
            if (message.command === 'openFile') {
                vscode.commands.executeCommand(
                    'azurePipelineStudio.openErrorFile',
                    message.filePath,
                    message.lineNumber
                );
            } else if (message.command === 'configurePipelineRoot') {
                vscode.commands.executeCommand('azurePipelineStudio.configureRootDirectory');
            }
        });
    };

    const scheduleErrorDisplay = (delayMs = errorDebounceDelayMs) => {
        clearTimeout(errorDebounceTimer);
        clearTimeout(activeErrorDebounceTimer);
        errorDebounceTimer = activeErrorDebounceTimer = setTimeout(() => {
            if (!canUseVsCodeUi()) return;
            if (!pendingError) return;
            if (isRendering) {
                scheduleErrorDisplay(delayMs);
                return;
            }
            const { error: err, context: ctx, errorType: type } = pendingError;
            pendingError = null;
            errorDebounceTimer = activeErrorDebounceTimer = undefined;
            showErrorWebviewNow(err, ctx, type);
        }, delayMs);
    };

    const showErrorWebview = (error, context, errorType = 'expansion', options = {}) => {
        const immediate = options.immediate === true;
        const normalizedError = error instanceof Error ? error : new Error(String(error));

        if (immediate) {
            clearTimeout(errorDebounceTimer);
            clearTimeout(activeErrorDebounceTimer);
            errorDebounceTimer = activeErrorDebounceTimer = undefined;
            pendingError = null;
            showErrorWebviewNow(normalizedError, context, errorType);
            return;
        }

        pendingError = { error, context, errorType };
        scheduleErrorDisplay();
    };

    const closeErrorPanel = () => {
        if (currentErrorPanel) {
            try {
                currentErrorPanel.dispose();
            } catch (e) {
                // Panel already disposed, ignore
            }
            currentErrorPanel = null;
            errorPanelOpen = false;
        }
    };

    const isExpansionViewOpenForDocument = (document) => {
        if (!canUseVsCodeUi() || !document) {
            return false;
        }

        const targetUri = getRenderTargetUri(document).toString();
        return vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === targetUri);
    };

    const scheduleRender = (document, delayMs = 500) => {
        if (!shouldRenderDocument(document)) return;

        // Only refresh if a panel is already open; never auto-open panels here.
        if (!lastRenderedDocument || lastRenderedDocument.fileName !== document.fileName) {
            return;
        }

        if (!errorPanelOpen && !isExpansionViewOpenForDocument(document)) {
            return;
        }

        // When delayMs is 0, this is typically from save or explicit command; otherwise check refreshOnType preference
        if (delayMs > 0) {
            const expansionConfig = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
            const refreshOnType = expansionConfig.get('expansion.refreshOnType', true);
            if (!refreshOnType) {
                return;
            }

            const configuredDelay = expansionConfig.get('expansion.refreshDelayMs', 500);
            delayMs = Number.isInteger(configuredDelay) && configuredDelay >= 0 ? configuredDelay : delayMs;
        }

        pendingDocument = document;
        clearTimeout(debounceTimer);
        clearTimeout(activeDebounceTimer);
        debounceTimer = activeDebounceTimer = setTimeout(() => {
            if (!canUseVsCodeUi()) return;
            if (isRendering) return;
            const doc = pendingDocument;
            pendingDocument = null;
            void renderYamlDocument(doc, { silent: true });
        }, delayMs);
    };

    const enrichErrorWithLineNumbers = async (error) => {
        try {
            const errorText = error.message || String(error);

            // Extract file paths and parameters from error
            const filePathRegex = /(\\\\[^\s\n:]+\.ya?ml|[A-Za-z]:\\[^\s\n:]+\.ya?ml|\/[^\s\n:]+\.ya?ml)/g;
            const undefinedParamRegex = /Undefined template parameter '([^']+)'/g;

            let paramName = null;
            const paramMatch = undefinedParamRegex.exec(errorText);
            if (paramMatch) {
                paramName = paramMatch[1];
            }

            let filePath = null;
            const fileMatch = filePathRegex.exec(errorText);
            if (fileMatch) {
                filePath = fileMatch[1];
            }

            if (paramName && filePath) {
                try {
                    const fileUri = vscode.Uri.file(filePath);
                    const fileContent = await vscode.workspace.fs.readFile(fileUri);
                    const fileText = new TextDecoder().decode(fileContent);
                    const lines = fileText.split('\n');

                    // Search for the parameter in the file
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].includes(paramName)) {
                            const lineNumber = i + 1;
                            // Add line number to error message
                            const enrichedError = new Error(errorText.replace(filePath, `${filePath}:${lineNumber}`));
                            enrichedError.stack = error.stack;
                            return enrichedError;
                        }
                    }
                } catch (e) {
                    // If we can't read the file, just return the original error
                    return error;
                }
            }

            return error;
        } catch (e) {
            return error;
        }
    };

    const renderYamlDocument = async (document, options = {}) => {
        if (!document) return;
        if (!canUseVsCodeUi()) return;
        const expansionPanelOpen = isExpansionViewOpenForDocument(document);
        const manualOpenRequested = options.manualOpen === true;
        const errorPanelWasOpen = errorPanelOpen;
        const allowPanelOpen = manualOpenRequested || expansionPanelOpen || errorPanelWasOpen;
        const shouldRevealAfterSuccess = manualOpenRequested || expansionPanelOpen || errorPanelWasOpen;

        lastRenderedDocument = document;
        const sourceText = document.getText();

        isRendering = true;
        try {
            const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
            const settingsCompileTimeVariables = config.get('expansion.variables', {});
            const effectiveCompileTimeVariables = applyDefaultBuildVariables(settingsCompileTimeVariables);
            printCompileTimeVariableSources(
                'VS Code Expand Pipeline',
                settingsCompileTimeVariables,
                {},
                effectiveCompileTimeVariables
            );

            const configuredSkipSyntaxCheck = config.get('expansion.skipSyntaxCheck', false);
            const skipSyntaxCheck = options.silent ? configuredSkipSyntaxCheck : false;
            const resourceOverrides = buildResourceOverridesForDocument(document);
            const rootDirectoryOverride = buildRootDirectoryOverrideForDocument(document);
            const azureCompatible = options.azureCompatible !== undefined ? options.azureCompatible : false;

            const resourceLocations =
                resourceOverrides &&
                resourceOverrides.repositories &&
                typeof resourceOverrides.repositories === 'object'
                    ? Object.fromEntries(
                          Object.entries(resourceOverrides.repositories)
                              .map(([alias, entry]) => [alias, entry && entry.location])
                              .filter(([, location]) => typeof location === 'string' && location.trim().length)
                      )
                    : undefined;

            const parserOverrides = {
                fileName: document.fileName,
                azureCompatible,
                skipSyntaxCheck,
                ...(resourceOverrides && { resources: resourceOverrides }),
                ...(rootDirectoryOverride && { rootRepoBaseDir: rootDirectoryOverride }),
                ...(resourceLocations && { resourceLocations }),
                ...(Object.keys(effectiveCompileTimeVariables).length && { variables: effectiveCompileTimeVariables }),
            };

            const expandedYaml = parser.expandPipelineFromString(sourceText, parserOverrides);

            const formatOptions = getFormatSettings(document);
            formatOptions.fileName = document.fileName;
            formatOptions.wasExpanded = true;
            const formatted = formatYaml(expandedYaml, formatOptions);

            if (formatted.error) {
                const errorValue =
                    formatted.error instanceof Error ? formatted.error : new Error(String(formatted.error));
                if (allowPanelOpen) {
                    try {
                        showErrorWebviewNow(errorValue, context, 'expansion');
                    } catch (displayError) {
                        console.error(
                            '[Azure Pipeline Studio] Failed to render expansion error webview:',
                            displayError
                        );
                    }
                    if (canUseVsCodeUi()) {
                        vscode.window.showErrorMessage(errorValue.message || 'Pipeline expansion failed.');
                    }
                }
                return;
            }

            const targetUri = getRenderTargetUri(document);
            renderedContent.set(targetUri.toString(), formatted.text);
            renderedEmitter.fire(targetUri);

            clearTimeout(errorDebounceTimer);
            clearTimeout(activeErrorDebounceTimer);
            errorDebounceTimer = activeErrorDebounceTimer = undefined;
            pendingError = null;

            // Close error panel on successful expansion
            closeErrorPanel();

            if (shouldRevealAfterSuccess) {
                const targetDoc = await vscode.workspace.openTextDocument(targetUri);
                await vscode.window.showTextDocument(targetDoc, {
                    viewColumn: vscode.ViewColumn.Two,
                    preview: false,
                    preserveFocus: true,
                });
            }
        } catch (error) {
            console.error('Error expanding pipeline:', error);
            const enhancedError = new Error(formatTemplateExpansionError(document.fileName, error));
            enhancedError.stack = error.stack;
            if (allowPanelOpen) {
                try {
                    showErrorWebviewNow(enhancedError, context, 'expansion');
                } catch (displayError) {
                    console.error('[Azure Pipeline Studio] Failed to render expansion error webview:', displayError);
                }
                if (canUseVsCodeUi()) {
                    vscode.window.showErrorMessage(enhancedError.message || 'Pipeline expansion failed.');
                }
            }
        } finally {
            isRendering = false;
            pendingDocument && scheduleRender(pendingDocument, 0);
        }
    };

    function buildResourceOverridesForDocument(document) {
        if (!vscode || !document) return undefined;

        const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
        const configuredResources = config.get('resourceLocations');

        if (!Array.isArray(configuredResources) || !configuredResources.length) {
            return undefined;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        const workspaceDir = workspaceFolder && workspaceFolder.uri ? workspaceFolder.uri.fsPath : undefined;
        const documentDir = document.fileName ? path.dirname(document.fileName) : undefined;
        const repositories = {};

        for (const entry of configuredResources) {
            if (!entry || typeof entry !== 'object') continue;

            const alias = entry.repository && entry.repository.trim ? entry.repository.trim() : '';
            const rawPath = pickFirstString(entry.path, entry.location);
            if (!alias || !rawPath) continue;

            const resolvedPath = resolveConfiguredPath(rawPath, workspaceDir, documentDir);
            if (!resolvedPath) continue;

            const overrideEntry = { location: resolvedPath };
            const matchCriteria = {};

            ['repository', 'name', 'endpoint', 'ref', 'type'].forEach((key) => {
                const value = entry[key] && entry[key].trim ? entry[key].trim() : '';
                if (value) matchCriteria[key] = value;
            });

            if (Object.keys(matchCriteria).length) {
                overrideEntry.__match = matchCriteria;
            }

            repositories[alias] = overrideEntry;
        }

        return Object.keys(repositories).length ? { repositories } : undefined;
    }

    function buildRootDirectoryOverrideForDocument(document) {
        if (!vscode || !document) return undefined;

        const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
        const rawRootDirectory = config.get('pipelineRoot');
        if (typeof rawRootDirectory !== 'string' || !rawRootDirectory.trim().length) return undefined;

        const text = document.getText();

        // If any template reference uses @repoAlias syntax, repository resources
        // take precedence — don't apply the root directory override.
        if (/^\s*-?\s*template\s*:.*@\w+/m.test(text)) return undefined;

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        return resolveConfiguredPath(
            rawRootDirectory,
            workspaceFolder && workspaceFolder.uri ? workspaceFolder.uri.fsPath : undefined,
            document.fileName ? path.dirname(document.fileName) : undefined
        );
    }

    const shouldRenderDocument = (document) => {
        if (!document || !document.fileName) {
            return false;
        }
        const lower = document.fileName.toLowerCase();
        return lower.endsWith('.yaml') || lower.endsWith('.yml');
    };

    const isRelevantDocument = (document) =>
        shouldRenderDocument(document) && lastRenderedDocument && lastRenderedDocument.fileName === document.fileName;

    const commandDisposable = vscode.commands.registerCommand('azurePipelineStudio.showRenderedYaml', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !shouldRenderDocument(editor.document)) {
            vscode.window.showInformationMessage('Open an Azure Pipeline YAML file to view the expanded contents.');
            return;
        }

        closeErrorPanel();
        await renderYamlDocument(editor.document, { azureCompatible: false, manualOpen: true });
    });
    context.subscriptions.push(commandDisposable);

    const commandAzureCompatibleDisposable = vscode.commands.registerCommand(
        'azurePipelineStudio.showRenderedYamlAzureCompatible',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !shouldRenderDocument(editor.document)) {
                vscode.window.showInformationMessage('Open an Azure Pipeline YAML file to view the expanded contents.');
                return;
            }

            closeErrorPanel();
            await renderYamlDocument(editor.document, { azureCompatible: true, manualOpen: true });
        }
    );
    context.subscriptions.push(commandAzureCompatibleDisposable);

    const formatOriginalCommandDisposable = vscode.commands.registerCommand(
        'azurePipelineStudio.formatOriginalYaml',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !shouldRenderDocument(editor.document)) {
                vscode.window.showInformationMessage('Open an Azure Pipeline YAML file before formatting.');
                return;
            }

            closeErrorPanel();
            await formatOriginalDocument(editor.document);
        }
    );
    context.subscriptions.push(formatOriginalCommandDisposable);

    const configureCommandDisposable = vscode.commands.registerCommand(
        'azurePipelineStudio.configureResourceLocations',
        async () => {
            try {
                await handleConfigureResourceLocationRequest();
            } catch (error) {
                console.error('[Azure Pipeline Studio] Error in configure command:', error);
                vscode.window.showErrorMessage(`Configuration error: ${error.message}`);
            }
        }
    );
    context.subscriptions.push(configureCommandDisposable);

    const commandRootDirectoryDisposable = vscode.commands.registerCommand(
        'azurePipelineStudio.configureRootDirectory',
        async () => {
            try {
                await handleConfigurePipelineRootRequest();
            } catch (error) {
                console.error('[Azure Pipeline Studio] Error in configure pipeline root command:', error);
                vscode.window.showErrorMessage(`Configuration error: ${error.message}`);
            }
        }
    );
    context.subscriptions.push(commandRootDirectoryDisposable);

    const generateLoadingHtml = (projectName) => {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pipeline Diagram - Loading</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: #1e1e1e;
            color: #cccccc;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
        }
        .loading-container {
            text-align: center;
            max-width: 500px;
        }
        .spinner {
            width: 50px;
            height: 50px;
            border: 4px solid #3e3e42;
            border-top: 4px solid #0078d4;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        h2 {
            color: #ffffff;
            margin-bottom: 10px;
        }
        p {
            color: #888888;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="loading-container">
        <div class="spinner"></div>
        <h2>Analyzing Pipeline Dependencies</h2>
        <p>Expanding templates and generating diagram...</p>
        <p style="margin-top: 15px; font-size: 0.85em; opacity: 0.7;">${projectName}</p>
    </div>
</body>
</html>`;
    };

    const ensureDependenciesPanel = () => {
        if (!canUseVsCodeUi()) {
            return null;
        }
        if (dependenciesPanel) {
            return dependenciesPanel;
        }

        dependenciesPanel = vscode.window.createWebviewPanel(
            'pipelineDependencies',
            'Pipeline Dependencies',
            vscode.ViewColumn.Two,
            { enableScripts: true }
        );

        dependenciesPanel.onDidDispose(() => {
            dependenciesPanel = activeDependenciesPanel = null;
            dependenciesDocumentUri = undefined;
        });

        dependenciesPanel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'openInBrowser') {
                try {
                    const os = require('os');
                    const tempFile = path.join(os.tmpdir(), `pipeline-dependencies-${Date.now()}.html`);
                    fs.writeFileSync(tempFile, dependenciesPanelHtml);
                    await vscode.env.openExternal(vscode.Uri.file(tempFile));
                    vscode.window.showInformationMessage('Opened dependencies in browser');
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to open in browser: ${err.message}`);
                }
            } else if (message.command === 'openFile') {
                try {
                    const fileUri = vscode.Uri.file(message.file);
                    await vscode.window.showTextDocument(fileUri);
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
                }
            }
        });

        return dependenciesPanel;
    };

    const renderDependenciesPanel = async (document, options = {}) => {
        if (!document || !shouldRenderDocument(document)) {
            vscode.window.showInformationMessage('Open an Azure Pipeline YAML file to view dependencies.');
            return;
        }

        const { reveal = false, silent = false } = options;

        closeErrorPanel();
        dependenciesDocumentUri = document.uri;

        if (isDependenciesRendering) {
            pendingDependenciesDocument = document;
            return;
        }

        isDependenciesRendering = true;

        // Show panel immediately with loading state to avoid blocking extension host
        const panel = ensureDependenciesPanel();
        if (!panel) {
            isDependenciesRendering = false;
            return;
        }

        activeDependenciesPanel = dependenciesPanel = panel;

        const projectName = (document && document.fileName) || 'Pipeline';
        const loadingHtml = generateLoadingHtml(projectName);
        try {
            panel.webview.html = loadingHtml;

            // Give UI time to actually render the loading state before starting heavy work
            // This is critical for responsiveness
            await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (panelError) {
            console.error('[Azure Pipeline Studio] Failed to set loading HTML', panelError);
            dependenciesPanel = null;
            activeDependenciesPanel = null;
            isDependenciesRendering = false;
            return;
        }

        if (reveal) {
            try {
                panel.reveal(vscode.ViewColumn.Two, true);
            } catch (revealError) {
                // Panel reveal failed, ignore
            }
        }

        // Defer expensive computation to avoid blocking extension host
        // Use setTimeout with delay to allow more event loop processing and UI updates
        // setImmediate runs before I/O, setTimeout allows UI updates to process
        // Increased delay to ensure loading state is visible before heavy work starts
        setTimeout(async () => {
            if (!canUseVsCodeUi()) {
                isDependenciesRendering = false;
                return;
            }

            const buildDependencyError = (error, fallbackMessage, tipText) => {
                const errorMessage = error.message || fallbackMessage;
                const enhancedMessage = `Error in Pipeline Diagram:\n\n${errorMessage}\n\n💡 Tip: ${tipText}`;
                const enhancedError = new Error(enhancedMessage);
                enhancedError.stack = error.stack;
                return enhancedError;
            };

            try {
                const sourceText = document.getText();
                lastRenderedDiagramSourceText = sourceText;

                // Warn if document is very large
                if (sourceText.length > 100000) {
                    console.warn(
                        '[Azure Pipeline Studio] Large document detected:',
                        sourceText.length,
                        'characters - processing may take time'
                    );
                    if (!silent) {
                        vscode.window.showWarningMessage(
                            'Large pipeline detected. Diagram generation may take some time and could impact editor responsiveness.',
                            'Continue'
                        );
                    }
                }

                const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
                const settingsCompileTimeVariables = config.get('expansion.variables', {});
                const effectiveCompileTimeVariables = applyDefaultBuildVariables(settingsCompileTimeVariables);
                printCompileTimeVariableSources(
                    'VS Code Dependency Diagram',
                    settingsCompileTimeVariables,
                    {},
                    effectiveCompileTimeVariables
                );
                const skipSyntaxCheck = config.get('expansion.skipSyntaxCheck', false);
                const resourceOverrides = buildResourceOverridesForDocument(document);

                const parserOverrides = {
                    fileName: document.fileName,
                    azureCompatible: false,
                    skipSyntaxCheck,
                    ...(resourceOverrides && { resources: resourceOverrides }),
                    ...(Object.keys(effectiveCompileTimeVariables).length && {
                        variables: effectiveCompileTimeVariables,
                    }),
                };

                if (!silent) {
                    vscode.window.setStatusBarMessage('Expanding pipeline templates...', 2000);
                }

                let expandedYaml;
                try {
                    // Wrap parser call with Promise + setTimeout to allow event loop processing between operations
                    // Note: The parser itself is still synchronous, but this allows UI updates before it starts
                    expandedYaml = await new Promise((resolve, reject) => {
                        try {
                            // Small delay to allow event loop to process UI updates
                            setTimeout(() => {
                                try {
                                    const result = parser.expandPipelineFromString(sourceText, parserOverrides);
                                    resolve(result);
                                } catch (err) {
                                    reject(err);
                                }
                            }, 10);
                        } catch (err) {
                            reject(err);
                        }
                    });
                } catch (error) {
                    const enhancedError = buildDependencyError(
                        error,
                        'An error occurred while expanding pipeline templates',
                        'Check your YAML syntax and template references. You can also use "Expand Pipeline" to debug template expansion issues.'
                    );
                    showErrorWebviewNow(enhancedError, context, 'dependency');
                    return;
                }

                if (!silent) {
                    vscode.window.setStatusBarMessage('Analyzing dependencies...', 2000);
                }

                let dependencies;
                try {
                    // Wrap analyzer call with Promise + setTimeout to allow event loop processing
                    // Small delay to allow UI updates between heavy operations
                    dependencies = await new Promise((resolve, reject) => {
                        setTimeout(() => {
                            try {
                                const result = dependencyAnalyzer.analyzePipeline(expandedYaml);
                                resolve(result);
                            } catch (err) {
                                reject(err);
                            }
                        }, 10);
                    });
                } catch (error) {
                    const enhancedError = buildDependencyError(
                        error,
                        'An error occurred while analyzing pipeline dependencies',
                        `It's often easier to identify and fix issues using "Expand Pipeline" first. This will show you the full expanded YAML with all template variables and references resolved.`
                    );
                    showErrorWebviewNow(enhancedError, context, 'dependency');
                    return;
                }

                const stageCount = dependencies.stages.length || 0;
                const jobCount = dependencies.jobs.length || 0;

                // Wrap diagram generation with Promise + setTimeout to allow event loop processing
                // Small delay to allow UI updates between heavy operations
                const mermaidDiagram = await new Promise((resolve) => {
                    setTimeout(() => {
                        const diagram =
                            dependencies.stages.length > 0 || dependencies.jobs.length > 0
                                ? dependencyAnalyzer.generateMermaidDiagram(dependencies)
                                : '';
                        resolve(diagram);
                    }, 10);
                });

                const stageCountForDisplay = stageCount || jobCount || 0;

                const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pipeline Diagram</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: #1e1e1e;
            min-height: 100vh;
            padding: 0;
            margin: 0;
        }

        .container {
            max-width: 100%;
            margin: 0;
            background: #252526;
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%);
            color: white;
            padding: 20px;
            border-bottom: 4px solid #0078d4;
        }

        .header h1 {
            font-size: 2em;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .header-icon {
            font-size: 1.2em;
        }

        .header-info {
            display: flex;
            gap: 30px;
            margin-top: 15px;
            font-size: 0.9em;
            opacity: 0.9;
        }

        .header-info-item {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .content {
            padding: 20px;
            min-height: calc(100vh - 200px);
            background: #252526;
        }

        .diagram-container {
            background: #1e1e1e;
            border-radius: 0;
            padding: 20px;
            margin-bottom: 0;
            overflow: hidden;
            height: calc(100vh - 250px);
            position: relative;
        }

        .mermaid {
            display: flex;
            justify-content: center;
            background: #1e1e1e;
            border-radius: 0;
            min-height: 400px;
            transition: transform 0.1s ease-out;
        }

        .legend-color {
            width: 20px;
            height: 20px;
            border-radius: 2px;
        }

        .stage-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }

        .stage-card {
            background: #1e1e1e;
            border-radius: 4px;
            padding: 20px;
            border-left: 4px solid #4299e1;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
            transition: all 0.3s;
            cursor: pointer;
        }

        .stage-card:hover {
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
            transform: translateY(-2px);
        }

        .stage-divider {
            grid-column: 1 / -1;
            height: 1px;
            background: linear-gradient(to right, transparent, #3e3e42, transparent);
            margin: 10px 0;
        }

        .stage-card h3 {
            color: #ffffff;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .stage-number {
            display: inline-block;
            width: 28px;
            height: 28px;
            background: #4299e1;
            color: white;
            border-radius: 4px;
            text-align: center;
            line-height: 28px;
            font-size: 0.85em;
            margin-right: 10px;
        }

        .stage-deps {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #3e3e42;
        }

        .stage-deps-title {
            font-size: 0.85em;
            font-weight: 600;
            color: #cccccc;
            margin-bottom: 8px;
        }

        .dep-badge {
            display: inline-block;
            background: #3e3e42;
            color: #e0e0e0;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 0.8em;
            margin-right: 6px;
            margin-bottom: 6px;
        }

        .stage-details {
            display: none;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 2px solid #3e3e42;
            color: #cccccc;
        }

        .stage-card.expanded .stage-details {
            display: block;
        }

        .expand-icon {
            transition: transform 0.3s;
        }

        .stage-card.expanded .expand-icon {
            transform: rotate(180deg);
        }

        .search-box {
            margin-bottom: 20px;
            position: relative;
        }

        .search-box input {
            width: 100%;
            padding: 12px 40px 12px 16px;
            border: 2px solid #3e3e42;
            border-radius: 4px;
            font-size: 1em;
            background: #1e1e1e;
            color: #e0e0e0;
            transition: border-color 0.3s;
        }

        .search-box input:focus {
            outline: none;
            border-color: #D13438;
        }

        .critical-path-box {
            background: #ffeef0;
            border-left: 4px solid #e53e3e;
            padding: 20px;
            border-radius: 4px;
            margin: 20px 0;
        }

        .critical-path-box h3 {
            color: #c53030;
            margin-bottom: 10px;
        }

        .critical-path-box p {
            font-family: 'Courier New', monospace;
            color: #742a2a;
            line-height: 1.8;
            margin-bottom: 15px;
        }

        .resources-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 20px;
        }

        .resource-card {
            background: #1e1e1e;
            border-radius: 4px;
            padding: 20px;
            border-left: 4px solid #48bb78;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        }

        .resource-card h3 {
            color: #ffffff;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .resource-type {
            display: inline-block;
            background: #48bb78;
            color: white;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 0.75em;
            font-weight: 600;
            text-transform: uppercase;
        }

        .resource-details {
            font-size: 0.9em;
            color: #cccccc;
        }

        .resource-details div {
            padding: 6px 0;
            border-bottom: 1px solid #3e3e42;
        }

        .resource-details div:last-child {
            border-bottom: none;
        }
        
        .resource-details strong {
            color: #ffffff;
        }

        @media (max-width: 768px) {
            .stage-list {
                grid-template-columns: 1fr;
            }
            .header h1 {
                font-size: 1.5em;
            }
        }
        
        h2 {
            color: #ffffff;
        }
        
        p {
            color: #cccccc;
        }
        
        a:hover {
            text-decoration: underline !important;
            opacity: 0.8;
        }
        
        .btn {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.2s ease;
            white-space: nowrap;
        }
        
        .btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        
        .btn-primary {
            background: #0078d4;
            color: white;
        }
        
        .btn-primary:hover {
            background: #106ebe;
        }
        
        .btn-secondary {
            background: #3e3e42;
            color: white;
        }
        
        .btn-secondary:hover {
            background: #4e4e52;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div style="display: flex; align-items: center; gap: 10px;">
                <h1 style="margin: 0;">
                    Pipeline Diagram
                </h1>
                <button onclick="openInBrowser()" class="btn btn-primary">🌐 Open in Browser</button>
            </div>
            <div class="header-info">
                <div class="header-info-item">
                    <button onclick="toggleDiagramSource()" id="source-toggle-btn" class="btn btn-secondary">📝 View Source</button>
                </div>
                <div class="header-info-item">
                    <span>🏗️</span>
                    <span>${stageCountForDisplay} Stage${stageCountForDisplay !== 1 ? 's' : ''}</span>
                </div>
                <div class="header-info-item" style="display: flex; align-items: center; gap: 8px;">
                    <div class="legend-color" style="width: 16px; height: 16px; background: #F87171; border-radius: 2px;"></div>
                    <span style="font-size: 0.9em; color: #F87171;">Longest path</span>
                </div>
            </div>
            <div style="margin-top: 8px; font-size: 0.85em; opacity: 0.7;">
                <span>📄 </span>
                <a href="#" onclick="event.preventDefault(); const vscode = acquireVsCodeApi(); vscode.postMessage({ command: 'openFile', file: '${projectName}' });" style="color: #569cd6; text-decoration: none; cursor: pointer;" title="${projectName}">${projectName}</a>
            </div>
        </div>

        <div class="content">
            <div>
                <div class="diagram-container" id="diagram-container" style="cursor: grab; overflow: hidden; position: relative;">
                    <div class="mermaid" id="mermaid-diagram">
${mermaidDiagram
    .split('\n')
    .map((line) => '                        ' + line)
    .join('\n')}
                    </div>
                    <div id="mermaid-error" style="display: none; padding: 20px; background: #2d1f1f; border-left: 4px solid #ff6b6b; color: #ff6b6b; border-radius: 4px; margin-top: 10px;">
                        <h3 style="margin-top: 0; color: #ff6b6b;">⚠️ Diagram Rendering Error</h3>
                        <p style="color: #cccccc; margin-bottom: 10px;">The Mermaid diagram failed to render. This could be due to:</p>
                        <ul style="color: #cccccc; margin-left: 20px;">
                            <li>Invalid Mermaid syntax in the generated diagram</li>
                            <li>Complex pipeline structure that exceeds rendering limits</li>
                            <li>Circular dependencies or invalid stage references</li>
                        </ul>
                        <p style="color: #cccccc; margin-top: 10px;">💡 <strong>Tip:</strong> View the source code below or check the "Mermaid Source" tab to validate it at <a href="https://mermaid.live" style="color: #569cd6;">mermaid.live</a></p>
                        <pre id="mermaid-error-details" style="background: #1e1e1e; padding: 10px; border-radius: 4px; overflow-x: auto; margin-top: 10px; color: #ce9178;"></pre>
                    </div>
                </div>
                
                <!-- Source Code Section (replaces diagram when visible) -->
                <div id="diagram-source-section" style="display: none; background: #1e1e1e; border-radius: 4px; overflow: hidden; border-left: 4px solid #0078d4;">
                    <div style="padding: 15px; background: #2d2d2d; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #3e3e42;">
                        <h3 style="margin: 0; color: #ffffff; font-size: 1.1em;">📝 Mermaid Source Code</h3>
                        <div style="display: flex; gap: 10px;">
                            <button onclick="copyDiagramSource()" style="padding: 6px 12px; background: #0078d4; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;">📋 Copy</button>
                            <button onclick="toggleDiagramSource()" style="padding: 6px 12px; background: #3e3e42; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;">✖ Close</button>
                        </div>
                    </div>
                    <div style="padding: 0;">
                        <span id="diagram-copy-feedback" style="display: none; position: absolute; right: 20px; margin-top: 10px; color: #4ec9b0; background: #1e1e1e; padding: 5px 10px; border-radius: 4px; font-size: 13px;">✓ Copied!</span>
                        <pre id="diagram-source-code" style="background: #1e1e1e; padding: 20px; margin: 0; overflow-x: auto; color: #ce9178; line-height: 1.6; font-family: 'Courier New', Courier, monospace; font-size: 14px; white-space: pre-wrap; word-wrap: break-word;">${mermaidDiagram.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // Open in browser function
        window.openInBrowser = function() {
            const vscode = acquireVsCodeApi();
            vscode.postMessage({ command: 'openInBrowser' });
        };
        
        // Pan and zoom functionality for diagram
        (function() {
            const container = document.getElementById('diagram-container');
            if (!container) return;
            
            let scale = 1;
            let translateX = 0;
            let translateY = 0;
            let isDragging = false;
            let startX = 0;
            let startY = 0;
            
            const updateTransform = function() {
                const diagram = container.querySelector('.mermaid');
                if (diagram) {
                    diagram.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ')';
                    diagram.style.transformOrigin = '0 0';
                }
            };
            
            // Mouse wheel zoom
            container.addEventListener('wheel', function(e) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                const newScale = scale * delta;
                if (newScale >= 0.1 && newScale <= 5) {
                    scale = newScale;
                    updateTransform();
                }
            });
            
            // Mouse drag pan
            container.addEventListener('mousedown', function(e) {
                isDragging = true;
                startX = e.clientX - translateX;
                startY = e.clientY - translateY;
                container.style.cursor = 'grabbing';
            });
            
            document.addEventListener('mousemove', function(e) {
                if (!isDragging) return;
                translateX = e.clientX - startX;
                translateY = e.clientY - startY;
                updateTransform();
            });
            
            document.addEventListener('mouseup', function() {
                isDragging = false;
                container.style.cursor = 'grab';
            });
        })();
        
        // Toggle diagram source visibility (source replaces the diagram area)
        window.toggleDiagramSource = function() {
            const sourceSection = document.getElementById('diagram-source-section');
            const diagramContainer = document.getElementById('diagram-container');
            const toggleBtn = document.getElementById('source-toggle-btn');
            if (sourceSection && diagramContainer && toggleBtn) {
                const isVisible = sourceSection.style.display !== 'none';
                sourceSection.style.display = isVisible ? 'none' : 'block';
                diagramContainer.style.display = isVisible ? '' : 'none';
                toggleBtn.textContent = isVisible ? '📝 View Source' : '🔼 Hide Source';
            }
        };
        
        // Copy diagram source to clipboard
        window.copyDiagramSource = function() {
            const sourceCode = document.getElementById('diagram-source-code');
            const feedback = document.getElementById('diagram-copy-feedback');
            if (sourceCode) {
                const text = sourceCode.textContent;
                navigator.clipboard.writeText(text).then(function() {
                    feedback.style.display = 'inline';
                    setTimeout(function() {
                        feedback.style.display = 'none';
                    }, 2000);
                }).catch(function(err) {
                    console.error('Failed to copy:', err);
                });
            }
        };
        
        // Initialize Mermaid with error handling
        mermaid.initialize({ 
            startOnLoad: false,
            theme: 'dark',
            flowchart: {
                useMaxWidth: true,
                htmlLabels: true,
                curve: 'basis'
            }
        });
        
        // Manually render with error handling
        try {
            mermaid.run({
                querySelector: '.mermaid',
            }).catch(function(error) {
                console.error('Mermaid rendering error:', error);
                const diagramDiv = document.getElementById('mermaid-diagram');
                const errorDiv = document.getElementById('mermaid-error');
                const errorDetails = document.getElementById('mermaid-error-details');
                if (diagramDiv && errorDiv && errorDetails) {
                    diagramDiv.style.display = 'none';
                    errorDiv.style.display = 'block';
                    errorDetails.textContent = error.message || String(error);
                }
            });
        } catch (error) {
            console.error('Mermaid initialization error:', error);
            const diagramDiv = document.getElementById('mermaid-diagram');
            const errorDiv = document.getElementById('mermaid-error');
            const errorDetails = document.getElementById('mermaid-error-details');
            if (diagramDiv && errorDiv && errorDetails) {
                diagramDiv.style.display = 'none';
                errorDiv.style.display = 'block';
                errorDetails.textContent = error.message || String(error);
            }
        }
        
        // Initial diagram is already rendered
    </script>
</body>
</html>`;

                dependenciesPanelHtml = htmlContent;

                try {
                    panel.webview.html = htmlContent;
                } catch (panelError) {
                    console.error('[Azure Pipeline Studio] Failed to set panel HTML', panelError);
                    // Panel might be disposed, ignore
                    dependenciesPanel = null;
                    activeDependenciesPanel = null;
                    return;
                }

                closeErrorPanel();

                if (!silent) {
                    vscode.window.setStatusBarMessage('Pipeline dependencies analyzed.', 3000);
                }
            } catch (error) {
                // This catch block handles unexpected errors that weren't caught by inner try-catch blocks
                const errorMessage = error.message || 'An unexpected error occurred while analyzing dependencies';
                const enhancedMessage =
                    `Error in Pipeline Diagram:\n\n${errorMessage}\n\n` +
                    `💡 Tip: This is an unexpected error. Please check the error details below.`;
                const enhancedError = new Error(enhancedMessage);
                enhancedError.stack = error.stack;
                showErrorWebviewNow(enhancedError, context, 'dependency');
            } finally {
                isDependenciesRendering = false;
                if (pendingDependenciesDocument) {
                    const queuedDocument = pendingDependenciesDocument;
                    pendingDependenciesDocument = null;
                    void renderDependenciesPanel(queuedDocument, { silent: true });
                }
            }
        }, 150); // 150ms delay to ensure loading state renders before heavy computation
    };

    const scheduleDependenciesRefresh = (document, delayMs = 500) => {
        if (!dependenciesPanel || !dependenciesDocumentUri) {
            return;
        }

        if (document.uri.toString() !== dependenciesDocumentUri.toString()) {
            return;
        }

        const configuredDelay = vscode.workspace
            .getConfiguration('azurePipelineStudio', document.uri)
            .get('diagram.refreshDelayMs', 500);
        const effectiveDelay =
            delayMs === 0 ? 0 : Number.isInteger(configuredDelay) && configuredDelay >= 0 ? configuredDelay : delayMs;

        pendingDependenciesDocument = document;
        clearTimeout(dependenciesDebounceTimer);
        clearTimeout(activeDependenciesDebounceTimer);
        dependenciesDebounceTimer = activeDependenciesDebounceTimer = setTimeout(() => {
            if (!dependenciesPanel || isDependenciesRendering) {
                return;
            }
            const queuedDocument = pendingDependenciesDocument;
            pendingDependenciesDocument = null;
            if (queuedDocument) {
                void renderDependenciesPanel(queuedDocument, { silent: true });
            }
        }, effectiveDelay);
    };

    const showDependenciesCommandDisposable = vscode.commands.registerCommand(
        'azurePipelineStudio.showDependencies',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !shouldRenderDocument(editor.document)) {
                vscode.window.showInformationMessage('Open an Azure Pipeline YAML file to view dependencies.');
                return;
            }

            // Start async work but don't await it - let command return immediately
            void renderDependenciesPanel(editor.document, { reveal: true });
        }
    );
    context.subscriptions.push(showDependenciesCommandDisposable);

    const openSimulationView = async (document) => {
        if (!canUseVsCodeUi()) return;
        closeErrorPanel();

        const sourceText = document.getText();
        const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
        const settingsCompileTimeVariables = config.get('expansion.variables', {});
        const effectiveCompileTimeVariables = applyDefaultBuildVariables(settingsCompileTimeVariables);
        const skipSyntaxCheck = config.get('expansion.skipSyntaxCheck', false);
        const resourceOverrides = buildResourceOverridesForDocument(document);
        const rootDirectoryOverride = buildRootDirectoryOverrideForDocument(document);
        const resourceLocations =
            resourceOverrides && resourceOverrides.repositories
                ? Object.fromEntries(
                      Object.entries(resourceOverrides.repositories)
                          .map(([alias, entry]) => [alias, entry && entry.location])
                          .filter(([, loc]) => typeof loc === 'string' && loc.trim().length)
                  )
                : undefined;

        const parserOptions = {
            fileName: document.fileName,
            azureCompatible: false,
            skipSyntaxCheck,
            ...(resourceOverrides && { resources: resourceOverrides }),
            ...(rootDirectoryOverride && { rootRepoBaseDir: rootDirectoryOverride }),
            ...(resourceLocations && { resourceLocations }),
            ...(Object.keys(effectiveCompileTimeVariables).length && { variables: effectiveCompileTimeVariables }),
        };

        let stageTree = [];
        let expandedDoc = null;
        let topLevelParameterDefinitions = [];
        try {
            const simParser = new AzurePipelineParser({ skipSyntax: skipSyntaxCheck });
            const { document: parsedDoc } = simParser.expandPipeline(sourceText, parserOptions);
            expandedDoc = parsedDoc;
            lastExpandedDoc = parsedDoc;
            stageTree = _extractSimulationTree(expandedDoc);
            topLevelParameterDefinitions = _extractTopLevelParameterDefinitions(simParser, sourceText, skipSyntaxCheck);
        } catch (err) {
            const enhancedError = new Error(formatTemplateExpansionError(document.fileName, err));
            enhancedError.stack = err.stack;
            showErrorWebviewNow(enhancedError, context, 'expansion');
            return;
        }

        const { simple: pipelineSimpleVars, groups: pipelineVarGroups } = _extractPipelineVariables(expandedDoc);
        const azureSystemVars = [
            { name: 'Build.SourcesDirectory', desc: 'Repository sources directory' },
            { name: 'Build.Repository.LocalPath', desc: 'Local repository path' },
            { name: 'System.DefaultWorkingDirectory', desc: 'Default working directory' },
            { name: 'Build.ArtifactStagingDirectory', desc: 'Artifact staging directory' },
            { name: 'Build.StagingDirectory', desc: 'Staging directory' },
            { name: 'Build.BinariesDirectory', desc: 'Binaries output directory' },
            { name: 'Pipeline.Workspace', desc: 'Pipeline workspace root' },
            { name: 'Agent.TempDirectory', desc: 'Agent temp directory' },
            { name: 'Agent.BuildDirectory', desc: 'Agent build directory' },
            { name: 'Agent.WorkFolder', desc: 'Agent work folder' },
            { name: 'Agent.ToolsDirectory', desc: 'Agent tools directory' },
            { name: 'Agent.HomeDirectory', desc: 'Agent home directory' },
            { name: 'Build.BuildNumber', desc: 'Build number (= counter)' },
            { name: 'Build.BuildId', desc: 'Build ID' },
            { name: 'Build.Reason', desc: 'Build trigger reason' },
            { name: 'Build.SourceBranch', desc: 'Full branch ref (refs/heads/\u2026)' },
            { name: 'Build.SourceBranchName', desc: 'Short branch name' },
            { name: 'System.TeamProject', desc: 'Team project name' },
            { name: 'System.Debug', desc: 'Debug mode (true/false)' },
            { name: 'Agent.OS', desc: 'Agent OS' },
        ];
        const knownVarsJson = JSON.stringify({
            azure: azureSystemVars,
            pipeline: pipelineSimpleVars,
            groups: pipelineVarGroups,
        }).replace(/</g, '\\u003c');

        lastSimDocument = document;
        lastSimSourceText = sourceText;
        lastSimParserOptions = parserOptions;

        if (simulationPanel) {
            simulationPanel.reveal(vscode.ViewColumn.Two, true);
        } else {
            simulationPanel = vscode.window.createWebviewPanel(
                'pipelineSimulation',
                'Simulate Pipeline Run',
                vscode.ViewColumn.Two,
                { enableScripts: true }
            );
            simulationPanel.onDidDispose(() => {
                simulationPanel = null;
                activeSimulationPanel = null;
            });
            activeSimulationPanel = simulationPanel;

            simulationPanel.webview.onDidReceiveMessage(async (message) => {
                if (!simOutputChannel) {
                    simOutputChannel = vscode.window.createOutputChannel('Pipeline Simulation');
                }
                const document = lastSimDocument;
                const sourceText = lastSimSourceText;
                const parserOptions = lastSimParserOptions;
                if (message.command === 'runInTerminal') {
                    const { spawn } = require('child_process');
                    const os = require('os');
                    const isWindows = process.platform === 'win32';

                    // On Windows hosts, run with Windows Node to avoid old WSL /usr/bin/node syntax limitations.
                    const pipelineFile = isWindows ? document.fileName : _toSimulatorPath(document.fileName);
                    const bundlePath = isWindows
                        ? path.join(__dirname, 'extension-bundle.js')
                        : _toSimulatorPath(path.join(__dirname, 'extension-bundle.js'));

                    const token = `aps-sim-${Date.now()}.json`;
                    const jsonOutputPath = isWindows ? path.join(os.tmpdir(), token) : `/tmp/${token}`;
                    const jsonReadPath = jsonOutputPath;
                    const counter = parseInt(message.buildCounter, 10);
                    const simArgs = ['--simulate', pipelineFile];
                    if (!isNaN(counter)) simArgs.push('--build-counter', String(counter));
                    if (Array.isArray(message.stages) && message.stages.length) {
                        for (const s of message.stages) simArgs.push('--stage', s);
                    }
                    if (message.variables && typeof message.variables === 'object') {
                        for (const [k, v] of Object.entries(message.variables)) {
                            if (k.trim()) simArgs.push('-v', `${k.trim()}=${String(v).trim()}`);
                        }
                    }
                    if (message.parameters && typeof message.parameters === 'object') {
                        for (const [k, v] of Object.entries(message.parameters)) {
                            if (!k || !k.trim()) continue;
                            simArgs.push('-p', `${k.trim()}=${String(v).trim()}`);
                        }
                    }
                    if (message.libraryVariables && typeof message.libraryVariables === 'object') {
                        for (const [groupName, vars] of Object.entries(message.libraryVariables)) {
                            if (!vars || typeof vars !== 'object') continue;
                            for (const [varName, value] of Object.entries(vars)) {
                                if (groupName.trim() && varName.trim()) {
                                    simArgs.push('-l', `${groupName.trim()}.${varName.trim()}=${String(value).trim()}`);
                                }
                            }
                        }
                    }
                    const termResourceOverrides = buildResourceOverridesForDocument(document);
                    if (termResourceOverrides && termResourceOverrides.repositories) {
                        for (const [alias, entry] of Object.entries(termResourceOverrides.repositories)) {
                            const resolvedLocation = entry && entry.location;
                            if (
                                typeof alias === 'string' &&
                                alias.trim() &&
                                typeof resolvedLocation === 'string' &&
                                resolvedLocation.trim()
                            ) {
                                const repoPath = isWindows
                                    ? resolvedLocation.trim()
                                    : _toSimulatorPath(resolvedLocation.trim());
                                simArgs.push('--repo', `${alias.trim()}=${repoPath}`);
                            }
                        }
                    }
                    const termExecPathsRaw = vscode.workspace
                        .getConfiguration('azurePipelineStudio', document.uri)
                        .get('simulation.toolPaths', {});
                    const termExecPaths = _resolveExecPaths(
                        termExecPathsRaw,
                        _isLinuxSimulationContext(document.fileName)
                    );
                    for (const [exeName, exePath] of Object.entries(termExecPaths)) {
                        const rawExePath = String(exePath || '').trim();
                        if (!rawExePath) continue;
                        simArgs.push('--exe', `${exeName}=${rawExePath}`);
                    }
                    simArgs.push('--output-json', jsonOutputPath);
                    if (!simOutputChannel) {
                        simOutputChannel = vscode.window.createOutputChannel('Pipeline Simulation');
                    }
                    simOutputChannel.clear();
                    simOutputChannel.show(true);
                    let child;
                    if (isWindows) {
                        const cliArgs = [bundlePath, ...simArgs]
                            .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
                            .join(' ');
                        simOutputChannel.appendLine(
                            `[aps] Reproducing this run from PowerShell/CMD:\n  node ${cliArgs}\n`
                        );
                        child = spawn('node', [bundlePath, ...simArgs], {
                            cwd: path.dirname(pipelineFile),
                        });
                    } else {
                        const cliArgs = [bundlePath, ...simArgs]
                            .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
                            .join(' ');
                        simOutputChannel.appendLine(`[aps] Reproducing this run from a terminal:\n  node ${cliArgs}\n`);
                        child = spawn('node', [bundlePath, ...simArgs], {
                            shell: '/bin/bash',
                            cwd: path.dirname(pipelineFile),
                        });
                    }
                    const appendProcessOutput = (data) => {
                        let text = '';
                        if (Buffer.isBuffer(data)) {
                            text = data.toString('utf8');
                            if (text.includes('\u0000')) {
                                text = data.toString('utf16le');
                            }
                        } else {
                            text = String(data || '');
                        }
                        text = text.replace(/\u0000/g, '');
                        if (text) simOutputChannel.append(text);
                    };
                    child.stdout.on('data', appendProcessOutput);
                    child.stderr.on('data', appendProcessOutput);
                    child.on('error', (err) => {
                        simOutputChannel.appendLine(`[aps] Failed to start simulation process: ${err.message}`);
                        if (simulationPanel && simulationPanel.webview) {
                            simulationPanel.webview.postMessage({
                                command: 'simulationError',
                                error: `Failed to start simulation process: ${err.message}`,
                            });
                        }
                    });
                    child.on('close', (code, signal) => {
                        simOutputChannel.appendLine(
                            `[aps] Simulation process exited with code=${code} signal=${signal || 'none'}`
                        );
                        try {
                            if (fs.existsSync(jsonReadPath)) {
                                const results = JSON.parse(fs.readFileSync(jsonReadPath, 'utf8'));
                                try {
                                    fs.unlinkSync(jsonReadPath);
                                } catch (_) {}
                                if (simulationPanel && simulationPanel.webview) {
                                    simulationPanel.webview.postMessage({ command: 'simulationResults', results });
                                }
                            } else {
                                if (simulationPanel && simulationPanel.webview) {
                                    simulationPanel.webview.postMessage({
                                        command: 'simulationError',
                                        error: 'Simulation failed — see Output \u203a Pipeline Simulation for details.',
                                    });
                                }
                            }
                        } catch (err) {
                            if (simulationPanel && simulationPanel.webview) {
                                simulationPanel.webview.postMessage({ command: 'simulationError', error: err.message });
                            }
                        }
                    });
                    return;
                }
                if (message.command === 'openResultsInBrowser') {
                    try {
                        const html = String(message.html || '');
                        const os = require('os');
                        const { spawn } = require('child_process');
                        const tempFile = path.join(os.tmpdir(), `pipeline-sim-results-${Date.now()}.html`);
                        fs.writeFileSync(tempFile, html, 'utf8');

                        let openedExternally = false;
                        try {
                            openedExternally = await vscode.env.openExternal(vscode.Uri.file(tempFile));
                        } catch (_) {
                            openedExternally = false;
                        }

                        if (!openedExternally) {
                            // Fallback to OS opener when VS Code external open API fails.
                            if (process.platform === 'win32') {
                                spawn('cmd.exe', ['/c', 'start', '', tempFile], {
                                    detached: true,
                                    stdio: 'ignore',
                                }).unref();
                                openedExternally = true;
                            } else if (process.platform === 'darwin') {
                                spawn('open', [tempFile], { detached: true, stdio: 'ignore' }).unref();
                                openedExternally = true;
                            } else {
                                spawn('xdg-open', [tempFile], { detached: true, stdio: 'ignore' }).unref();
                                openedExternally = true;
                            }
                        }

                        if (!openedExternally) {
                            throw new Error('Unable to open results in an external browser.');
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(`Failed to open results in browser: ${err.message}`);
                    }
                    return;
                }
                if (message.command === 'saveVars') {
                    context.workspaceState.update('aps.vars', message.data || {});
                    return;
                }
                if (message.command === 'saveAzureVars') {
                    const legacy = context.workspaceState.get('aps.vars', null) || {};
                    const existingLibData = Array.isArray(legacy.libData)
                        ? legacy.libData
                        : context.workspaceState.get('aps.libVars', []);
                    const nextAzure =
                        message.data && typeof message.data.overrides === 'object' ? message.data.overrides : {};
                    await context.workspaceState.update('aps.azureVars', { overrides: nextAzure });
                    await context.workspaceState.update('aps.vars', { overrides: nextAzure, libData: existingLibData });
                    return;
                }
                if (message.command === 'saveLibVars') {
                    const legacy = context.workspaceState.get('aps.vars', null) || {};
                    const existingOverrides =
                        legacy.overrides && typeof legacy.overrides === 'object'
                            ? legacy.overrides
                            : (context.workspaceState.get('aps.azureVars', { overrides: {} }) || {}).overrides || {};
                    const nextLibData = message.data && Array.isArray(message.data.libData) ? message.data.libData : [];
                    await context.workspaceState.update('aps.libVars', nextLibData);
                    await context.workspaceState.update('aps.vars', {
                        overrides: existingOverrides,
                        libData: nextLibData,
                    });
                    return;
                }
                if (message.command === 'loadVars') {
                    const legacy = context.workspaceState.get('aps.vars', null) || {};
                    const savedAzure = context.workspaceState.get('aps.azureVars', null);
                    const savedLib = context.workspaceState.get('aps.libVars', null);
                    const savedToolPathsForLoad = context.workspaceState.get('aps.toolPaths', null);
                    const execPathsRawForLoad = vscode.workspace
                        .getConfiguration('azurePipelineStudio', document.uri)
                        .get('simulation.toolPaths', {});
                    const execPathsBaseForLoad = _resolveExecPaths(
                        execPathsRawForLoad,
                        _isLinuxSimulationContext(document.fileName)
                    );
                    const mergedToolPathsForLoad = Object.assign(
                        {},
                        execPathsBaseForLoad,
                        savedToolPathsForLoad && typeof savedToolPathsForLoad === 'object' ? savedToolPathsForLoad : {}
                    );
                    const merged = {
                        overrides:
                            savedAzure && typeof savedAzure.overrides === 'object'
                                ? savedAzure.overrides
                                : legacy.overrides || {},
                        libData: Array.isArray(savedLib)
                            ? savedLib
                            : Array.isArray(legacy.libData)
                              ? legacy.libData
                              : [],
                        toolPaths: mergedToolPathsForLoad,
                    };
                    if (simulationPanel && simulationPanel.webview) {
                        simulationPanel.webview.postMessage({ command: 'varsLoaded', data: merged });
                    }
                    return;
                }
                if (message.command === 'clearAzureVars') {
                    const legacy = context.workspaceState.get('aps.vars', null) || {};
                    const existingLibData = Array.isArray(legacy.libData)
                        ? legacy.libData
                        : context.workspaceState.get('aps.libVars', []);
                    context.workspaceState.update('aps.azureVars', { overrides: {} });
                    context.workspaceState.update('aps.vars', { overrides: {}, libData: existingLibData });
                    return;
                }
                if (message.command === 'clearLibVars') {
                    const legacy = context.workspaceState.get('aps.vars', null) || {};
                    const existingOverrides =
                        legacy.overrides && typeof legacy.overrides === 'object'
                            ? legacy.overrides
                            : (context.workspaceState.get('aps.azureVars', { overrides: {} }) || {}).overrides || {};
                    context.workspaceState.update('aps.libVars', []);
                    context.workspaceState.update('aps.vars', { overrides: existingOverrides, libData: [] });
                    return;
                }
                if (message.command === 'clearVars') {
                    context.workspaceState.update('aps.vars', undefined);
                    context.workspaceState.update('aps.azureVars', undefined);
                    context.workspaceState.update('aps.libVars', undefined);
                    return;
                }
                if (message.command === 'saveToolPaths') {
                    const nextToolPaths =
                        message.data && typeof message.data.toolPaths === 'object' ? message.data.toolPaths : {};
                    await context.workspaceState.update('aps.toolPaths', nextToolPaths);
                    return;
                }
                if (message.command === 'clearToolPaths') {
                    await context.workspaceState.update('aps.toolPaths', {});
                    return;
                }
                if (message.command !== 'runSimulation') return;

                const stages = Array.isArray(message.stages) && message.stages.length ? message.stages : undefined;
                const counter = parseInt(message.buildCounter, 10);
                const counterStr = isNaN(counter) ? '1' : String(counter);

                const userVariables = {};
                if (message.variables && typeof message.variables === 'object') {
                    for (const [k, v] of Object.entries(message.variables)) {
                        if (k.trim() && String(v).trim()) userVariables[k.trim()] = String(v).trim();
                    }
                }

                const libVarsFromMessage =
                    message.libraryVariables && typeof message.libraryVariables === 'object'
                        ? message.libraryVariables
                        : {};

                const topLevelParameterOverrides = {};
                if (message.parameters && typeof message.parameters === 'object') {
                    for (const [key, value] of Object.entries(message.parameters)) {
                        const trimmedKey = String(key || '').trim();
                        if (!trimmedKey) continue;
                        topLevelParameterOverrides[trimmedKey] = value;
                    }
                }

                if (simulationPanel && simulationPanel.webview) {
                    simulationPanel.webview.postMessage({ command: 'simulationStarted' });
                }

                if (!simOutputChannel) {
                    simOutputChannel = vscode.window.createOutputChannel('Pipeline Simulation');
                }
                simOutputChannel.appendLine(
                    `[aps] runSimulation started — stages=${JSON.stringify(stages !== undefined ? stages : 'all')} counter=${counterStr}`
                );
                simOutputChannel.show(true);

                try {
                    const simWorkDir = _toSimulatorPath(path.dirname(document.fileName));
                    const simOutRoot = simWorkDir.replace(/[/\\]$/, '') + '/simulation';
                    simOutputChannel.appendLine(`[aps] workDir=${simWorkDir}`);
                    const execPathsRaw = vscode.workspace
                        .getConfiguration('azurePipelineStudio', document.uri)
                        .get('simulation.toolPaths', {});
                    const execPathsBase = _resolveExecPaths(execPathsRaw, _isLinuxSimulationContext(document.fileName));
                    const panelToolPaths =
                        message.toolPaths && typeof message.toolPaths === 'object' ? message.toolPaths : {};
                    const execPaths = { ...execPathsBase, ...panelToolPaths };
                    const simDistroMatch = document.fileName.match(/^\\\\wsl\.localhost\\([^\\]+)/i);
                    const wslMountRoot =
                        process.platform === 'win32' && simDistroMatch
                            ? `\\\\wsl.localhost\\${simDistroMatch[1]}`
                            : null;

                    const simParser = new AzurePipelineParser({ skipSyntax: skipSyntaxCheck });
                    const simParserOptions = {
                        ...parserOptions,
                        ...(Object.keys(topLevelParameterOverrides).length
                            ? { parameters: topLevelParameterOverrides }
                            : {}),
                    };
                    const { document: docToSimulate } = simParser.expandPipeline(sourceText, simParserOptions);
                    lastExpandedDoc = docToSimulate;

                    simOutputChannel.appendLine(`[aps] calling runPipelineSimulation...`);
                    const results = runPipelineSimulation(docToSimulate, {
                        workingDirectory: simWorkDir,
                        outputRoot: simOutRoot,
                        buildCounter: counterStr,
                        userVariables,
                        libraryVariables: libVarsFromMessage,
                        stages,
                        executablePaths: execPaths,
                        wslMountRoot,
                    });
                    simOutputChannel.appendLine(
                        `[aps] simulation complete — passed=${results.totalPassed} failed=${results.totalFailed} skipped=${results.totalSkipped}`
                    );
                    if (simulationPanel && simulationPanel.webview) {
                        simulationPanel.webview.postMessage({ command: 'simulationResults', results });
                    }
                    simOutputChannel.appendLine(`[aps] simulationResults posted`);
                } catch (err) {
                    simOutputChannel.appendLine(`[aps] ERROR: ${(err && err.stack) || err}`);
                    if (simulationPanel && simulationPanel.webview) {
                        simulationPanel.webview.postMessage({
                            command: 'simulationError',
                            error: String((err && err.message) || err),
                        });
                    }
                }
            });
        }

        const _savedAzure = context.workspaceState.get('aps.azureVars', null);
        const _savedLib = context.workspaceState.get('aps.libVars', null);
        const _legacyVars = context.workspaceState.get('aps.vars', null) || {};
        const _savedToolPaths = context.workspaceState.get('aps.toolPaths', null);
        const _settingsExecPathsRaw = vscode.workspace
            .getConfiguration('azurePipelineStudio', document.uri)
            .get('simulation.toolPaths', {});
        const _settingsExecPaths = _resolveExecPaths(
            _settingsExecPathsRaw,
            _isLinuxSimulationContext(document.fileName)
        );
        const _mergedToolPaths = Object.assign(
            {},
            _settingsExecPaths,
            _savedToolPaths && typeof _savedToolPaths === 'object' ? _savedToolPaths : {}
        );
        const savedVarsJson = JSON.stringify({
            overrides:
                _savedAzure && typeof _savedAzure.overrides === 'object'
                    ? _savedAzure.overrides
                    : _legacyVars.overrides || {},
            libData: Array.isArray(_savedLib)
                ? _savedLib
                : Array.isArray(_legacyVars.libData)
                  ? _legacyVars.libData
                  : [],
            toolPaths: _mergedToolPaths,
        }).replace(/</g, '\\u003c');
        simulationPanel.webview.html = _generateSimulationViewHtml(
            stageTree,
            document.fileName,
            topLevelParameterDefinitions,
            String(Date.now()),
            knownVarsJson,
            savedVarsJson
        );
    };

    const showSimulationViewDisposable = vscode.commands.registerCommand(
        'azurePipelineStudio.showSimulationView',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !shouldRenderDocument(editor.document)) {
                vscode.window.showInformationMessage('Open an Azure Pipeline YAML file to launch the simulation view.');
                return;
            }
            await openSimulationView(editor.document);
        }
    );
    context.subscriptions.push(showSimulationViewDisposable);

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (document.uri.scheme === renderedScheme) {
                renderedContent.delete(document.uri.toString());
            }
        })
    );

    async function handleConfigureResourceLocationRequest(initialAlias) {
        const targetDocument =
            lastRenderedDocument ||
            (vscode.window.activeTextEditor && shouldRenderDocument(vscode.window.activeTextEditor.document)
                ? vscode.window.activeTextEditor.document
                : undefined);

        if (!targetDocument) {
            vscode.window.showInformationMessage(
                'Open an Azure Pipeline YAML file before configuring resource locations.'
            );
            return;
        }

        const config = vscode.workspace.getConfiguration('azurePipelineStudio', targetDocument.uri);
        const configuredResources = config.get('resourceLocations');
        const existingEntries = Array.isArray(configuredResources)
            ? configuredResources.filter((entry) => entry && typeof entry === 'object')
            : [];

        const getRepositoryAlias = (entry) => {
            if (!entry || typeof entry !== 'object') {
                return undefined;
            }
            const candidates = [entry.repository, entry.alias, entry.name];
            for (const candidate of candidates) {
                if (typeof candidate === 'string' && candidate.trim().length) {
                    return candidate.trim();
                }
            }
            return undefined;
        };

        let alias = typeof initialAlias === 'string' && initialAlias.trim().length ? initialAlias.trim() : undefined;
        let existingEntry;

        if (alias) {
            existingEntry = existingEntries.find((entry) => getRepositoryAlias(entry) === alias);
        } else {
            const quickPickItems = existingEntries
                .map((entry) => {
                    const entryAlias = getRepositoryAlias(entry);
                    if (!entryAlias) {
                        return undefined;
                    }
                    return {
                        label: entryAlias,
                        description: pickFirstString(entry.location, entry.path) || '',
                        entry,
                    };
                })
                .filter(Boolean);

            quickPickItems.push({
                label: '$(plus) Add new repository mapping…',
                description: 'Create a new entry for a repository resource.',
                newEntry: true,
            });

            const selection = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: 'Select a repository resource to configure',
            });

            if (!selection) {
                return;
            }

            if (selection.newEntry) {
                const inputAlias = await vscode.window.showInputBox({
                    prompt: 'Repository alias or name',
                    placeHolder: 'Name given under resources.repositories[].repository',
                    ignoreFocusOut: true,
                });

                if (!inputAlias || !inputAlias.trim().length) {
                    return;
                }

                alias = inputAlias.trim();
            } else {
                alias = selection.label;
                existingEntry = selection.entry;
            }
        }

        if (!alias) {
            return;
        }

        if (!existingEntry) {
            existingEntry = existingEntries.find((entry) => getRepositoryAlias(entry) === alias);
        }

        const currentLocation = existingEntry ? pickFirstString(existingEntry.location, existingEntry.path) : undefined;
        const methodChoice = await vscode.window.showQuickPick(
            [
                {
                    label: '$(folder) Browse for folder',
                    description: 'Open a folder picker dialog',
                    method: 'browse',
                },
                {
                    label: '$(edit) Enter path manually',
                    description: 'Type or paste a file path',
                    method: 'manual',
                },
            ],
            {
                placeHolder: `Select how to specify location for repository '${alias}'`,
                ignoreFocusOut: true,
            }
        );

        if (!methodChoice) {
            return;
        }

        let newLocation;

        if (methodChoice.method === 'browse') {
            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: `Select location for '${alias}'`,
                defaultUri: currentLocation ? vscode.Uri.file(currentLocation) : undefined,
            });

            if (!folderUri || folderUri.length === 0) {
                vscode.window.showInformationMessage('Repository location not updated.');
                return;
            }

            newLocation = folderUri[0].fsPath;
        } else {
            newLocation = await vscode.window.showInputBox({
                prompt: `Local path for repository '${alias}'`,
                placeHolder: '${workspaceFolder}/path/to/templates',
                value: currentLocation || '',
                ignoreFocusOut: true,
            });

            if (!newLocation || !newLocation.trim().length) {
                vscode.window.showInformationMessage('Repository location not updated.');
                return;
            }
        }

        const sanitizedLocation = newLocation.trim();
        const updatedEntries = [];
        let updated = false;

        existingEntries.forEach((entry) => {
            const entryAlias = getRepositoryAlias(entry);
            if (entryAlias === alias) {
                const cloned = { ...entry, repository: alias, location: sanitizedLocation };
                delete cloned.path;
                updatedEntries.push(cloned);
                updated = true;
            } else {
                updatedEntries.push({ ...entry });
            }
        });

        if (!updated) {
            updatedEntries.push({ repository: alias, location: sanitizedLocation });
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetDocument.uri);
        const target = vscode.ConfigurationTarget.Workspace;

        try {
            await config.update('resourceLocations', updatedEntries, target);

            vscode.window.showInformationMessage(`Repository '${alias}' location saved.`);

            await renderYamlDocument(targetDocument);
        } catch (error) {
            console.error(`[Azure Pipeline Studio] Error saving repository location:`, error);
            vscode.window.showErrorMessage(`Failed to save repository location: ${error.message}`);
        }
    }

    async function handleConfigurePipelineRootRequest() {
        const targetDocument =
            lastRenderedDocument ||
            (vscode.window.activeTextEditor && shouldRenderDocument(vscode.window.activeTextEditor.document)
                ? vscode.window.activeTextEditor.document
                : undefined);

        const config = vscode.workspace.getConfiguration(
            'azurePipelineStudio',
            targetDocument ? targetDocument.uri : undefined
        );
        const currentRoot = config.get('pipelineRoot', '');

        const methodChoice = await vscode.window.showQuickPick(
            [
                { label: '$(folder) Browse for folder', description: 'Open a folder picker dialog', method: 'browse' },
                { label: '$(edit) Enter path manually', description: 'Type or paste a path', method: 'manual' },
            ],
            { placeHolder: 'Select how to specify the Pipeline Root directory', ignoreFocusOut: true }
        );

        if (!methodChoice) return;

        let newRoot;
        if (methodChoice.method === 'browse') {
            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Pipeline Root directory',
                defaultUri: currentRoot ? vscode.Uri.file(currentRoot) : undefined,
            });
            if (!folderUri || folderUri.length === 0) {
                vscode.window.showInformationMessage('Pipeline root not updated.');
                return;
            }
            newRoot = folderUri[0].fsPath;
        } else {
            newRoot = await vscode.window.showInputBox({
                prompt: 'Local root directory for resolving pipeline templates',
                placeHolder: '${workspaceFolder}/path/to/templates',
                value: currentRoot,
                ignoreFocusOut: true,
            });
            if (newRoot === undefined) {
                vscode.window.showInformationMessage('Pipeline root not updated.');
                return;
            }
        }

        await config.update('pipelineRoot', newRoot.trim(), vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('Pipeline root saved.');

        if (targetDocument) {
            await renderYamlDocument(targetDocument);
        }
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(({ document }) => {
            if (isRelevantDocument(document)) {
                scheduleRender(document, 500);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            // Diagram panel refresh: runs independently of expansion panel
            scheduleDependenciesRefresh(document, 0);
            if (!isRelevantDocument(document)) return;
            const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
            if (config.get('refreshOnSave', true)) {
                scheduleRender(document, 0);
            }
        })
    );
}

function deactivate() {
    extensionRuntimeGeneration++;
    // Clear any pending timers to prevent operations after disposal
    clearTimeout(activeDebounceTimer);
    clearTimeout(activeErrorDebounceTimer);
    clearTimeout(activeDependenciesDebounceTimer);

    // Clear module-level state to prevent any new operations
    activeDebounceTimer = undefined;
    activeErrorDebounceTimer = undefined;
    activeDependenciesDebounceTimer = undefined;

    // Dispose of dependencies panel if still open
    if (activeDependenciesPanel) {
        try {
            activeDependenciesPanel.dispose();
        } catch (e) {
            // Panel may already be disposed, ignore
        }
        activeDependenciesPanel = null;
    }
}

function formatTemplateExpansionError(displayPath, expandError) {
    const msg = expandError && typeof expandError.message === 'string' ? expandError.message : String(expandError);
    const potentialIssuesMatch = msg.match(/Template\s+'([^']+)'\s+potential issues:([\s\S]*)/);
    if (potentialIssuesMatch) {
        const tmpl = potentialIssuesMatch[1];
        const tail = (potentialIssuesMatch[2] || '').trimEnd();
        return `[${displayPath}] Template(${tmpl}) expansion failed. Potential issues:${tail ? `${tail}` : ''}`;
    }

    const lines = msg.split('\n');
    const firstLine = lines[0];
    const restLines = lines
        .slice(1)
        .map((line) => '  ' + line)
        .join('\n');

    return restLines
        ? `[${displayPath}] Template expansion failed\n  ${firstLine}\n${restLines}`
        : `[${displayPath}] Template expansion failed\n  ${firstLine}`;
}

module.exports = {
    activate,
    deactivate,
    AzurePipelineParser,
    formatYaml,
    formatFilesRecursively,
    DependencyAnalyzer,
};

function buildRepositoryOverridesFromCliEntries(entries, cwd) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return undefined;
    }

    const repositories = {};
    entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }

        const alias = entry.alias;
        const rawPath = entry.path;
        if (
            typeof alias !== 'string' ||
            !alias.trim().length ||
            typeof rawPath !== 'string' ||
            !rawPath.trim().length
        ) {
            return;
        }

        const resolved = resolveConfiguredPath(rawPath, cwd, undefined);
        if (!resolved) {
            console.warn(`Skipping repository mapping '${alias}': could not resolve path '${rawPath}'.`);
            return;
        }

        repositories[alias] = {
            repository: alias,
            location: resolved,
        };
    });

    return Object.keys(repositories).length ? repositories : undefined;
}

function tryAssignIntegerOption(target, key, value, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        console.warn(`Ignoring --format ${key}: expected integer between ${min} and ${max}.`);
        return;
    }
    target[key] = parsed;
}

function buildFormatOptionsFromCli(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return undefined;
    }

    const options = {};

    entries.forEach((entry) => {
        if (typeof entry !== 'string') {
            return;
        }

        const separator = entry.indexOf('=');
        if (separator <= 0 || separator === entry.length - 1) {
            console.warn(`Ignoring invalid --format entry '${entry}'. Expected key=value.`);
            return;
        }

        const key = entry.slice(0, separator).trim();
        const value = entry.slice(separator + 1).trim();
        if (!key.length) {
            console.warn(`Ignoring --format entry with empty key: '${entry}'.`);
            return;
        }

        const booleanOptions = ['noArrayIndent', 'forceQuotes', 'sortKeys', 'stepSpacing'];
        const integerOptions = {
            indent: [1, 8],
            lineWidth: [0, Number.MAX_SAFE_INTEGER],
            firstBlockBlankLines: [0, 4],
            blankLinesBetweenSections: [0, 4],
        };

        if (booleanOptions.includes(key)) {
            if (value === 'true' || value === 'false') {
                options[key] = value === 'true';
            } else {
                console.warn(`Ignoring --format ${key}: expected boolean 'true' or 'false'.`);
            }
        } else if (integerOptions[key]) {
            tryAssignIntegerOption(options, key, value, ...integerOptions[key]);
        } else if (key === 'newline' || key === 'newlineFormat') {
            options.newlineFormat = value
                .replace(/\\r\\n/g, '\r\n')
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r');
        } else {
            console.warn(`Ignoring unsupported --format option '${key}'.`);
        }
    });

    return Object.keys(options).length ? options : undefined;
}

function formatFilesRecursively(targets, extensions, formatOptions) {
    const normalizedExtensions = new Set(
        Array.isArray(extensions) ? extensions.map((ext) => normalizeExtension(ext)).filter(Boolean) : []
    );

    if (!normalizedExtensions.size) {
        normalizedExtensions.add('.yml');
        normalizedExtensions.add('.yaml');
    }

    const results = {
        totalFiles: 0,
        formattedFiles: [],
        warnings: [],
        errors: [],
    };

    if (!Array.isArray(targets) || !targets.length) {
        return results;
    }

    const visited = new Set();

    const handleFile = (filePath) => {
        results.totalFiles += 1;
        try {
            const source = fs.readFileSync(filePath, 'utf8');
            const fileFormatOptions = { ...formatOptions, fileName: filePath, suppressConsoleOutput: true };
            const formatResult = formatYaml(source, fileFormatOptions);

            if (formatResult.error) {
                results.errors.push({ filePath, message: formatResult.error });
                return;
            }

            // Always collect warnings (e.g., template hints) even if file wasn't formatted
            if (formatResult.warning) {
                results.warnings.push({ filePath, message: formatResult.warning });
            }

            if (formatResult.text !== source) {
                fs.writeFileSync(filePath, formatResult.text, 'utf8');
                results.formattedFiles.push(filePath);
            }
        } catch (error) {
            results.errors.push({ filePath, message: error.message });
        }
    };

    const walk = (entryPath) => {
        if (!entryPath) return;

        const resolved = path.resolve(process.cwd(), entryPath);
        if (visited.has(resolved)) return;
        visited.add(resolved);

        let stats;
        try {
            stats = fs.lstatSync(resolved);
        } catch (error) {
            results.errors.push({ filePath: resolved, message: `Cannot access: ${error.message}` });
            return;
        }

        if (stats.isSymbolicLink()) return;

        if (stats.isDirectory()) {
            let children;
            try {
                children = fs.readdirSync(resolved);
            } catch (error) {
                results.errors.push({ filePath: resolved, message: `Cannot read directory: ${error.message}` });
                return;
            }
            // Continue processing other children even if one fails
            children.forEach((child) => {
                try {
                    walk(path.join(resolved, child));
                } catch (error) {
                    results.errors.push({
                        filePath: path.join(resolved, child),
                        message: `Unexpected error: ${error.message}`,
                    });
                }
            });
            return;
        }

        if (stats.isFile()) {
            const ext = normalizeExtension(path.extname(resolved));
            if (ext && normalizedExtensions.has(ext)) {
                handleFile(resolved);
            }
        }
    };

    targets.forEach((target) => {
        try {
            walk(target);
        } catch (error) {
            results.errors.push({
                filePath: target,
                message: `Failed to process target: ${error.message}`,
            });
        }
    });

    return results;
}

if (require.main === module) {
    runCli(process.argv.slice(2));
}

function runCli(args) {
    // Only run CLI logic when not in VS Code extension mode
    if (vscode !== undefined) {
        return;
    }

    const usage =
        'Usage: node extension.js <file1> <file2> ...\n' +
        'Options:\n' +
        '  -h, --help                   Show this help message\n' +
        '  -o, --output <file>          Write output to file (default: in-place, only with single file)\n' +
        '  -r, --repo <alias=path>      Map repository alias to local path\n' +
        '  -v, --variables <key=value>  Set compile-time variables (e.g., Build.Reason=Manual)\n' +
        '  -p, --parameter <name=value> Set top-level template parameter override for expansion\n' +
        '  -l, --library-variable <group.variable=value>  Set ADO library variable values for simulation\n' +
        '  -L, --library-variables-file <file>            Load ADO library variable groups from YAML file\n' +
        '  -f, --format-option <key=value>  Set format option (e.g., indent=4)\n' +
        '  -R, --format-recursive <path>    Format files recursively in directory (when used, all paths are treated as recursive targets)\n' +
        '  -e, --extension <ext>        File extensions to format (default: .yml, .yaml)\n' +
        '  -x, --expand-templates       Expand Azure Pipeline template expressions (${{}},$[],$())\n' +
        '  -a, --azure-compatible       Use Azure-compatible expansion mode (adds blank lines, etc.)\n' +
        '  -s, --skip-syntax-check      Skip syntax checking during expansion\n' +
        '  -d, --debug                  Print files being formatted\n' +
        '  -t, --timing                 Print timing breakdown for each expansion phase\n' +
        '      --simulate               Run local pipeline simulation mode\n' +
        '  -c, --build-counter <n>      Set the build counter value used in version expressions (default: 1)\n' +
        '  -S, --stage <name>           Run only the named stage(s); repeat or comma-separate (e.g. -S Build,Test)\n' +
        '      --exe <name=path>        Override executable/tool path for simulation (repeatable)\n' +
        '      --output-json <file>     Write simulation results JSON to the provided path';

    const failWithUsage = (message) => {
        if (message) {
            console.error(message);
        }
        console.error(usage);
        process.exitCode = 1;
    };

    const formatRecursiveIssueMessage = (level, filePathValue, message) => {
        const displayPath = path.relative(process.cwd(), filePathValue) || filePathValue;
        const locationMatch = message.match(/at line (\d+), column (\d+):/);
        if (locationMatch) {
            const line = locationMatch[1];
            const column = locationMatch[2];
            const messageWithoutLocation = message.replace(/ at line \d+, column \d+:/, '');
            return `[${level}] ${displayPath}:${line}:${column}: ${messageWithoutLocation}`;
        }
        return `[${level}] ${displayPath}: ${message}`;
    };

    const argv = minimist(args, {
        string: [
            'output',
            'repo',
            'format-option',
            'format-recursive',
            'extension',
            'variables',
            'parameter',
            'mock-catalog',
            'library-variable',
            'library-variables-file',
            'build-counter',
            'stage',
            'exe',
            'output-json',
            'wsl-mount-root',
        ],
        boolean: ['help', 'expand-templates', 'azure-compatible', 'skip-syntax-check', 'debug', 'simulate', 'timing'],
        alias: {
            h: 'help',
            o: 'output',
            r: 'repo',
            f: 'format-option',
            R: 'format-recursive',
            e: 'extension',
            v: 'variables',
            p: 'parameter',
            l: 'library-variable',
            L: 'library-variables-file',
            x: 'expand-templates',
            a: 'azure-compatible',
            s: 'skip-syntax-check',
            d: 'debug',
            t: 'timing',
            c: 'build-counter',
            S: 'stage',
        },
        default: {
            extension: [],
            'expand-templates': false,
            'azure-compatible': false,
            'skip-syntax-check': false,
            debug: false,
            simulate: false,
            timing: false,
        },
    });

    if (argv.help) {
        console.log(usage);
        process.exit(0);
    }

    const knownArgvKeys = new Set([
        '_',
        'help',
        'h',
        'output',
        'o',
        'repo',
        'r',
        'variables',
        'v',
        'parameter',
        'p',
        'format-option',
        'f',
        'format-recursive',
        'R',
        'extension',
        'e',
        'mock-catalog',
        'library-variable',
        'l',
        'library-variables-file',
        'L',
        'expand-templates',
        'x',
        'azure-compatible',
        'a',
        'skip-syntax-check',
        's',
        'debug',
        'd',
        'simulate',
        'timing',
        't',
        'build-counter',
        'c',
        'stage',
        'S',
        'exe',
        'output-json',
        'wsl-mount-root',
    ]);
    const unknownKeys = Object.keys(argv).filter((k) => !knownArgvKeys.has(k));
    if (unknownKeys.length) {
        const formatted = unknownKeys.map((k) => (k.length === 1 ? `-${k}` : `--${k}`)).join(', ');
        failWithUsage(`Error: Unsupported option(s): ${formatted}`);
        return;
    }

    const toArray = (val) => [].concat(val || []);

    const parseKeyValue = (entries, label) => {
        const map = {};
        const errors = [];
        for (const entry of entries) {
            const [key, ...rest] = entry.split('=');
            const value = rest.join('=').trim();
            if (!key || !key.trim() || !value) {
                errors.push(`Invalid ${label} "${entry}". Expected format "key=value".`);
                continue;
            }
            map[key.trim()] = value;
        }
        return { map, errors };
    };

    const filesToFormat = argv._;
    const formatOption = toArray(argv['format-option']);
    const extension = toArray(argv.extension);
    const formatRecursiveRaw = argv['format-recursive'];
    const formatRecursiveValues = toArray(formatRecursiveRaw).filter((v) => typeof v === 'string' && v.trim().length);
    const formatRecursiveFlag =
        args.includes('-R') || args.includes('--format-recursive') || formatRecursiveRaw === true;

    const { map: variablesMap, errors: variableErrors } = parseKeyValue(toArray(argv.variables), 'variable');
    const { map: parameterMap, errors: parameterErrors } = parseKeyValue(toArray(argv.parameter), 'parameter');
    const { map: repoMap, errors: repoErrors } = parseKeyValue(toArray(argv.repo), 'repository mapping');
    const { map: executablePaths } = parseKeyValue(toArray(argv.exe), 'executable path');
    const repositoryEntries = Object.entries(repoMap).map(([alias, path]) => ({ alias, path }));

    const libraryVariablesMap = {};
    const libraryVariableErrors = [];
    let debugLibVars = process.env.DEBUG_LIB_VARS === 'true';
    const mergeLibraryVariables = (sourceMap) => {
        if (!sourceMap || typeof sourceMap !== 'object' || Array.isArray(sourceMap)) return;
        for (const [groupName, groupVariables] of Object.entries(sourceMap)) {
            if (typeof groupName !== 'string' || !groupName.trim()) continue;
            if (!groupVariables || typeof groupVariables !== 'object' || Array.isArray(groupVariables)) continue;
            const groupKey = groupName.trim();
            libraryVariablesMap[groupKey] = libraryVariablesMap[groupKey] || {};
            for (const [variableName, variableValue] of Object.entries(groupVariables)) {
                if (typeof variableName !== 'string' || !variableName.trim()) continue;
                libraryVariablesMap[groupKey][variableName.trim()] =
                    variableValue === undefined || variableValue === null ? '' : String(variableValue);
            }
        }
    };
    const libraryVariablesFile = pickFirstString(argv['library-variables-file']);
    if (libraryVariablesFile) {
        const resolvedLibraryFile = path.resolve(process.cwd(), libraryVariablesFile);
        try {
            const parsed = yaml.parse(fs.readFileSync(resolvedLibraryFile, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                libraryVariableErrors.push(
                    `Invalid library variables file "${libraryVariablesFile}". Expected a YAML object with group names as keys.`
                );
            } else {
                mergeLibraryVariables(parsed);
            }
        } catch (err) {
            libraryVariableErrors.push(`Invalid library variables file "${libraryVariablesFile}": ${err.message}`);
        }
    }
    for (const entry of toArray(argv['library-variable'])) {
        const [groupAndVariable, ...valueParts] = entry.split('=');
        const value = valueParts.join('=').trim();
        if (!groupAndVariable || !groupAndVariable.trim() || value === undefined) {
            libraryVariableErrors.push(`Invalid library variable "${entry}". Expected format "group.variable=value".`);
            continue;
        }
        const separatorIndex = groupAndVariable.indexOf('.');
        if (separatorIndex <= 0 || separatorIndex === groupAndVariable.length - 1) {
            libraryVariableErrors.push(`Invalid library variable "${entry}". Expected format "group.variable=value".`);
            continue;
        }
        const groupName = groupAndVariable.slice(0, separatorIndex).trim();
        const variableName = groupAndVariable.slice(separatorIndex + 1).trim();
        if (!groupName || !variableName) {
            libraryVariableErrors.push(`Invalid library variable "${entry}". Expected format "group.variable=value".`);
            continue;
        }
        libraryVariablesMap[groupName] = libraryVariablesMap[groupName] || {};
        libraryVariablesMap[groupName][variableName] = value;
    }

    const formatOptionErrors = formatOption
        .filter((entry) => !entry.includes('='))
        .map((entry) => `Invalid format option "${entry}". Expected format "key=value".`);

    const allErrors = [
        ...repoErrors,
        ...variableErrors,
        ...parameterErrors,
        ...formatOptionErrors,
        ...libraryVariableErrors,
    ];
    if (allErrors.length) {
        allErrors.forEach((message) => console.error(message));
        failWithUsage();
        return;
    }

    const recursiveTargets =
        formatRecursiveFlag || formatRecursiveValues.length ? [...formatRecursiveValues, ...filesToFormat] : [];

    if (formatRecursiveFlag && recursiveTargets.length === 0) {
        failWithUsage('Error: --format-recursive requires at least one path.');
        return;
    }

    if (recursiveTargets.length) {
        const formatOverrides = buildFormatOptionsFromCli(formatOption) || {};
        const extensionFilters = extension.length ? extension : ['.yml', '.yaml'];
        const recursiveResult = formatFilesRecursively(recursiveTargets, extensionFilters, formatOverrides);
        recursiveResult.formattedFiles.forEach((filePath) => {
            const displayPath = path.relative(process.cwd(), filePath) || filePath;
            console.log(`Formatted: ${displayPath}`);
        });

        console.log(
            `Processed ${recursiveResult.totalFiles} file(s); formatted ${recursiveResult.formattedFiles.length}.`
        );

        recursiveResult.warnings.forEach((entry) => {
            console.warn(formatRecursiveIssueMessage('warn', entry.filePath, entry.message));
        });

        recursiveResult.errors.forEach((entry) => {
            console.error(formatRecursiveIssueMessage('error', entry.filePath, entry.message));
        });

        if (recursiveResult.errors.length) {
            process.exitCode = 1;
        }
        return;
    }

    const repositories = buildRepositoryOverridesFromCliEntries(repositoryEntries, process.cwd());
    const cliVariables = Object.keys(variablesMap).length > 0 ? variablesMap : undefined;
    const effectiveCliVariables = applyDefaultBuildVariables(cliVariables || {});

    if ((argv['expand-templates'] || argv.simulate) && argv.debug) {
        printCompileTimeVariableSources('CLI', {}, cliVariables || {}, effectiveCliVariables);
    }

    const parseSimulationCheckoutConfig = (gitOptionRaw) => {
        if (gitOptionRaw !== undefined) {
            const raw = String(gitOptionRaw).trim();

            const isRemoteUrl = /^(https?:\/\/|ssh:\/\/|git@)/i.test(raw);
            if (isRemoteUrl) {
                return { checkoutSource: 'git', checkoutRepository: raw };
            }

            return { checkoutSource: 'local', checkoutRepository: path.resolve(process.cwd(), raw) };
        }

        return { checkoutSource: 'local', checkoutRepository: '' };
    };

    const checkoutConfig = parseSimulationCheckoutConfig(argv.git);

    if (argv.simulate) {
        if (filesToFormat.length === 0) {
            failWithUsage('Error: --simulate requires a pipeline file argument.');
            return;
        }

        const simulateFile = path.resolve(process.cwd(), filesToFormat[0]);
        const simulateSource = fs.readFileSync(simulateFile, 'utf8');
        const simulateParser = new AzurePipelineParser({ skipSyntax: argv['skip-syntax-check'] || false });
        const simulationRoot = path.resolve(process.cwd(), path.join(path.dirname(simulateFile), 'simulation'));
        fs.rmSync(simulationRoot, { recursive: true, force: true });
        const buildCounterRaw = argv['build-counter'];
        const buildCounterValue = buildCounterRaw !== undefined ? String(parseInt(buildCounterRaw, 10) || 1) : '1';

        const simulateParserOptions = {
            fileName: simulateFile,
            baseDir: path.dirname(simulateFile),
            templateStack: [simulateFile],
            azureCompatible: false,
        };
        if (repositories) {
            const resourceLocations = {};
            for (const [alias, config] of Object.entries(repositories)) {
                resourceLocations[alias] = config.location || config.path;
            }
            simulateParserOptions.resourceLocations = resourceLocations;
        }
        if (cliVariables) {
            simulateParserOptions.variables = effectiveCliVariables;
        }
        if (Object.keys(parameterMap).length) {
            simulateParserOptions.parameters = parameterMap;
        }

        let mockCatalog = {};
        const mockCatalogPath = argv['mock-catalog'];
        if (mockCatalogPath) {
            const resolvedCatalog = path.resolve(process.cwd(), mockCatalogPath);
            try {
                mockCatalog = JSON.parse(fs.readFileSync(resolvedCatalog, 'utf8'));
            } catch (err) {
                console.error(`Error loading mock catalog "${mockCatalogPath}": ${err.message}`);
                process.exitCode = 1;
                return;
            }
        }

        try {
            const { document } = simulateParser.expandPipeline(simulateSource, simulateParserOptions);
            if (debugLibVars) {
                console.log('[DEBUG] Library Variables Map:', JSON.stringify(libraryVariablesMap, null, 2));
            }
            const results = runPipelineSimulation(document, {
                workingDirectory: path.dirname(simulateFile),
                outputRoot: simulationRoot,
                buildCounter: buildCounterValue,
                userVariables: variablesMap,
                libraryVariables: libraryVariablesMap,
                stages: toArray(argv.stage)
                    .flatMap((s) => s.split(','))
                    .map((s) => s.trim())
                    .filter(Boolean),
                executablePaths,
                wslMountRoot: argv['wsl-mount-root'] || null,
                checkoutSource: checkoutConfig.checkoutSource,
                checkoutRepository: checkoutConfig.checkoutRepository,
                mockCatalog,
            });
            printSimulationResults(results);
            if (argv['output-json']) {
                fs.writeFileSync(argv['output-json'], JSON.stringify(results));
            }
            console.log(`[sim] output root: ${simulationRoot}`);
            if (results.publishedArtifacts.length > 0) {
                console.log(`[sim] pipeline-artifacts:  ${path.join(simulationRoot, 'pipeline-artifacts')}`);
                const packagesArtifact = results.publishedArtifacts.find((a) => a.artifactName === 'Packages');
                if (packagesArtifact) {
                    console.log(`[sim] Packages:      ${packagesArtifact.snapshotPath}`);
                }
            }
            if (results.feedPublishes && results.feedPublishes.length > 0) {
                const nugetPublishes = results.feedPublishes.filter((entry) => entry.type === 'nuget');
                if (nugetPublishes.length > 0) {
                    console.log(`[sim] nuget packages:      ${path.join(simulationRoot, 'feed-publishes', 'nuget')}`);
                    for (const publish of nugetPublishes) {
                        console.log(`[sim]   ${publish.feedPath}`);
                    }
                }
                const universalPublishes = results.feedPublishes.filter((entry) => entry.type === 'universal');
                if (universalPublishes.length > 0) {
                    console.log(
                        `[sim] universal packages:  ${path.join(simulationRoot, 'feed-publishes', 'universal')}`
                    );
                    for (const publish of universalPublishes) {
                        console.log(`[sim]   ${publish.feedPath}`);
                    }
                }
            }
            if (results.totalFailed > 0) {
                process.exitCode = 1;
            }
        } catch (err) {
            console.error(`Simulation failed: ${err.message}`);
            process.exitCode = 1;
        }
        return;
    }

    if (filesToFormat.length === 0) {
        failWithUsage();
        return;
    }

    if (argv.output && filesToFormat.length > 1) {
        failWithUsage('Error: --output option is only supported when formatting a single file.');
        return;
    }

    const formatOverrides = buildFormatOptionsFromCli(formatOption) || {};

    // Create parser instance if template expansion is needed
    const cliParser = argv['expand-templates'] ? new AzurePipelineParser() : null;

    let hasErrors = false;

    for (const filePath of filesToFormat) {
        const absolutePath = path.resolve(process.cwd(), filePath);

        if (argv.debug) {
            console.log(`[DEBUG] Formatting: ${absolutePath}`);
        }

        try {
            const sourceText = fs.readFileSync(absolutePath, 'utf8');

            // Expand templates if requested
            let yamlToFormat = sourceText;
            if (argv['expand-templates'] && cliParser) {
                const parserOptions = {
                    fileName: absolutePath,
                    azureCompatible: argv['azure-compatible'] || false,
                    skipSyntaxCheck: argv['skip-syntax-check'] || false,
                    timing: argv.timing || false,
                };
                if (repositories) {
                    // Convert repository mappings to resourceLocations format
                    const resourceLocations = {};
                    for (const [alias, config] of Object.entries(repositories)) {
                        resourceLocations[alias] = config.location || config.path;
                    }
                    parserOptions.resourceLocations = resourceLocations;
                    if (argv.debug) {
                        console.log('[DEBUG] Resource locations:', JSON.stringify(resourceLocations, null, 2));
                    }
                }
                if (Object.keys(effectiveCliVariables).length > 0) {
                    parserOptions.variables = effectiveCliVariables;
                }
                try {
                    expandedYaml = cliParser.expandPipelineFromString(sourceText, parserOptions);
                    yamlToFormat = expandedYaml;
                } catch (expandError) {
                    console.error(formatTemplateExpansionError(filePath, expandError));
                    if (argv.debug) {
                        console.error('[DEBUG] Full error:', expandError);
                    }
                    hasErrors = true;
                    continue;
                }
            }

            const fileOptions = { ...(formatOverrides || {}), fileName: absolutePath };
            // Don't set expandTemplates in formatter - we already expanded above
            delete fileOptions.expandTemplates;
            // Mark that expansion happened so Microsoft compatibility knows to apply transformations
            if (argv['expand-templates']) {
                fileOptions.wasExpanded = true;
                fileOptions.azureCompatible = argv['azure-compatible'] || false;
            }

            const formatted = formatYaml(yamlToFormat, fileOptions);
            if (formatted.error) {
                const errorLines = formatted.error.split('\n');
                const indentedError = errorLines.map((line, idx) => (idx === 0 ? line : '  ' + line)).join('\n');
                console.error(`[${filePath}] ${indentedError}`);
                hasErrors = true;
                continue;
            }
            if (formatted.warning) {
                const warningLines = formatted.warning.split('\n');
                const indentedWarning = warningLines.map((line, idx) => (idx === 0 ? line : '  ' + line)).join('\n');
                console.warn(`[${filePath}] ${indentedWarning}`);
            }
            let outputText = formatted.text;

            if (argv['expand-templates'] && argv['azure-compatible']) {
                // Preserve intentional blank spacing inside heredoc blocks after formatting
                outputText = cliParser.addHeredocListSpacing(outputText);
            }

            if (argv.output) {
                const absoluteOutput = path.resolve(process.cwd(), argv.output);
                fs.writeFileSync(absoluteOutput, outputText, 'utf8');
                if (sourceText !== outputText) {
                    const action = argv['expand-templates'] ? 'Expanded' : 'Formatted';
                    console.log(`${action} pipeline written to ${absoluteOutput}`);
                }
            } else if (argv['expand-templates']) {
                // In expand mode, never modify files in-place - output to console
                console.log(outputText);
            } else {
                if (sourceText !== outputText) {
                    fs.writeFileSync(absolutePath, outputText, 'utf8');
                    console.log(`Formatted ${filePath} (in-place)`);
                }
            }
        } catch (error) {
            console.error(`[${filePath}] ${error.message}`);
            hasErrors = true;
        }
    }

    if (hasErrors) {
        process.exitCode = 1;
    }
}
