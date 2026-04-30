'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Shell step keys in order of priority
const SCRIPT_STEP_KEYS = ['bash', 'script', 'pwsh', 'powershell'];

// Built-in Azure task aliases that are really just script runners.
// After pipeline expansion bash:/script:/pwsh: become task: Bash@3 etc.
const NATIVE_TASK_SHELLS = Object.freeze({
    'Bash@3': 'bash',
    'CmdLine@2': 'bash',
    'PowerShell@2': 'pwsh',
    'PowerShell@1': 'pwsh',
});

// Default values for Azure DevOps built-in variables when running locally.
// Users can override any of these via -v flags on the CLI.
const AZURE_DEFAULTS = Object.freeze({
    // Build system variables
    'Build.Reason': 'Manual',
    'Build.SourceBranch': 'refs/heads/main',
    'Build.SourceBranchName': 'main',
    'Build.Repository.Name': 'local-repo',
    'Build.Repository.LocalPath': process.cwd(),
    'Build.ArtifactStagingDirectory': '/tmp/aps-sim-artifacts',
    'Build.StagingDirectory': '/tmp/aps-sim-staging',
    'Build.BinariesDirectory': '/tmp/aps-sim-binaries',
    'Build.SourcesDirectory': process.cwd(),
    'Build.DefinitionName': 'local-pipeline',
    'Build.DefinitionId': '0',
    'Build.BuildId': '0',
    'Build.BuildNumber': '0.0.0',
    'Build.QueuedBy': 'local',
    'Build.QueuedById': '0',
    'Build.RequestedFor': 'local',
    'Build.RequestedForEmail': 'local@localhost',
    'Build.TriggeredBy.BuildId': '',
    'Build.Repository.Provider': 'Git',
    'Build.Repository.Uri': '',
    'Build.Repository.ID': '',
    'Build.SourceVersionMessage': '',
    'Build.SourceVersion': 'HEAD',
    // PR variables (empty by default; set via -v if simulating a PR build)
    'System.PullRequest.SourceBranch': '',
    'System.PullRequest.TargetBranch': '',
    'System.PullRequest.PullRequestId': '',
    'System.PullRequest.PullRequestNumber': '',
    // Agent variables
    'Agent.OS': 'Linux',
    'Agent.OSArchitecture': 'X64',
    'Agent.Name': 'local-agent',
    'Agent.MachineName': 'localhost',
    'Agent.WorkFolder': '/tmp/aps-sim-work',
    'Agent.BuildDirectory': '/tmp/aps-sim-work',
    'Agent.TempDirectory': '/tmp/aps-sim-temp',
    'Agent.ToolsDirectory': '/tmp/aps-sim-tools',
    'Agent.HomeDirectory': '/tmp/aps-sim-home',
    // System variables
    'System.TeamProject': 'local-project',
    'System.TeamFoundationCollectionUri': 'https://dev.azure.com/local/',
    'System.DefinitionId': '0',
    'System.JobId': '00000000-0000-0000-0000-000000000000',
    'System.JobName': 'Job',
    'System.JobDisplayName': 'Job',
    'System.StageId': '00000000-0000-0000-0000-000000000000',
    'System.StageName': 'Stage',
    'System.StageDisplayName': 'Stage',
    'System.JobAttempt': '1',
    'System.StageAttempt': '1',
    'System.PhaseAttempt': '1',
    'System.PhaseDisplayName': 'Job',
    'System.AccessToken': 'local-access-token',
    'System.Debug': 'false',
    // Pipeline variables
    'Pipeline.Workspace': '/tmp/aps-sim-work',
    // Common build counter variable (Azure uses $[counter()] which cannot run locally)
    buildCounter: '1',
});

class PipelineSimulator {
    constructor(options = {}) {
        this.mockCatalog = options.mockCatalog || {};
        // Tools to shim when they are not present on the local machine.
        // Each entry: { name, exitCode, stdout }. exitCode defaults to 0.
        this.mockTools = options.mockTools || [
            { name: 'nuget' },
            { name: 'msbuild' },
            { name: 'MSBuild' },
            { name: 'vstest.console' },
            { name: 'signtool' },
            { name: '7z' },
            { name: 'curl' },
            { name: 'unzip' },
            { name: 'zip' },
            { name: 'aws' },
            { name: 'file' },
            { name: 'yq', stdout: 'mock-version' },
            { name: 'cygpath', stdout: '/mock-path' },
        ];
        this._shimDir = null;
    }

    /**
     * Simulate an already-expanded pipeline document.
     * @param {object} document - Expanded JS document from AzurePipelineParser
     * @param {object} options  - { variables: {}, libraryVariables: {}, workingDirectory: '' }
     * @returns {object} Structured results with per-stage, per-job, per-step data
     */
    simulate(document, options = {}) {
        const results = { stages: [], totalPassed: 0, totalFailed: 0, totalSkipped: 0 };
        const stages = Array.isArray(document.stages) ? document.stages : [];
        const debugLibVars = process.env.DEBUG_LIB_VARS === 'true';

        // Build the initial variable map:
        // 1. Azure built-in defaults (lowest priority)
        // 2. Pipeline-level variables declared in the YAML (including library group variables)
        // 3. User-supplied -v overrides (highest priority)
        const pipelineVars = this._extractPipelineVariables(document, {}, options.libraryVariables || {});
        if (debugLibVars && Object.keys(pipelineVars).length > 0) {
            console.log('[DEBUG] Pipeline variables extracted:', JSON.stringify(pipelineVars, null, 2));
        }
        const initialVariables = { ...AZURE_DEFAULTS, ...pipelineVars, ...(options.variables || {}) };

        // Ensure all simulator temp directories exist before any step runs.
        for (const value of Object.values(initialVariables)) {
            if (typeof value === 'string' && value.startsWith('/tmp/aps-sim-')) {
                try {
                    fs.mkdirSync(value, { recursive: true });
                } catch (_) {}
            }
        }

        // stageDeps accumulates stageDependencies.* keys from completed stages
        // so that downstream stages can resolve $[ stageDependencies.S.J.outputs['...'] ].
        const stageDeps = {};

        for (const stageDoc of stages) {
            // Merge stageDeps into the base variables so each stage sees prior outputs.
            // User-supplied -v overrides (already in initialVariables) take precedence.
            const stageVars = { ...initialVariables, ...stageDeps };
            const stageResult = this._runStage(stageDoc, stageVars, options);
            results.stages.push(stageResult);

            // Publish this stage's outputs for subsequent stages.
            const stageName = stageResult.stage;
            for (const jobResult of stageResult.jobs) {
                const jobName = jobResult.job;
                stageDeps[`stageDependencies.${stageName}.${jobName}.result`] = jobResult.result || 'Succeeded';
                for (const [key, value] of Object.entries(jobResult.outputVariables)) {
                    stageDeps[`stageDependencies.${stageName}.${jobName}.outputs['${key}']`] = value;
                }
            }

            for (const jobResult of stageResult.jobs) {
                for (const stepResult of jobResult.steps) {
                    if (stepResult.result === 'Succeeded') results.totalPassed++;
                    else if (stepResult.result === 'Failed') results.totalFailed++;
                    else results.totalSkipped++;
                }
            }
        }

        return results;
    }

    _runStage(stageDoc, variables, options) {
        const stageName = stageDoc.stage || 'Stage';
        const stageResult = {
            stage: stageName,
            displayName: stageDoc.displayName || stageName,
            jobs: [],
        };

        const jobs = Array.isArray(stageDoc.jobs) ? stageDoc.jobs : [];
        // Merge stage-level variables on top of the pipeline-level ones.
        const stageVariables = {
            ...variables,
            ...this._extractVariablesFromDoc(stageDoc, variables, options.libraryVariables || {}),
        };

        for (const jobDoc of jobs) {
            const jobResult = this._runJob(jobDoc, { ...stageVariables }, options);
            stageResult.jobs.push(jobResult);

            // Publish this job's result and isOutput variables so subsequent jobs
            // in the same stage can resolve $[ dependencies.JobName.result ] and
            // $[ dependencies.JobName.outputs['stepName.varName'] ].
            const jobName = jobResult.job;
            stageVariables[`dependencies.${jobName}.result`] = jobResult.result || 'Succeeded';
            for (const [key, value] of Object.entries(jobResult.outputVariables)) {
                stageVariables[`dependencies.${jobName}.outputs['${key}']`] = value;
            }
        }

        return stageResult;
    }

    _runJob(jobDoc, variables, options) {
        const jobName = jobDoc.job || jobDoc.deployment || 'Job';
        const jobResult = {
            job: jobName,
            displayName: jobDoc.displayName || jobName,
            steps: [],
            // Collected isOutput=true variables keyed as 'stepName.varName'
            outputVariables: {},
        };

        const steps = Array.isArray(jobDoc.steps) ? jobDoc.steps : [];
        // Merge job-level variables on top of the inherited ones.
        const jobVariables = {
            ...variables,
            ...this._extractVariablesFromDoc(jobDoc, variables, options.libraryVariables || {}),
        };

        for (const stepDoc of steps) {
            if (!this._shouldRunStep(stepDoc, jobVariables)) {
                jobResult.steps.push({
                    displayName: stepDoc.displayName || 'Step',
                    stepName: stepDoc.name || null,
                    result: 'Skipped',
                    variables: {},
                    outputVariables: {},
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                });
                continue;
            }

            const stepResult = this._runStep(stepDoc, jobVariables, options);
            jobResult.steps.push(stepResult);

            // Propagate all set variables to subsequent steps in this job
            Object.assign(jobVariables, stepResult.variables);

            // isOutput=true variables are ALSO accessible as 'stepName.varName'
            // within the same job and published for downstream jobs.
            if (stepResult.stepName && Object.keys(stepResult.outputVariables).length) {
                for (const [varName, value] of Object.entries(stepResult.outputVariables)) {
                    const key = `${stepResult.stepName}.${varName}`;
                    jobVariables[key] = value;
                    jobResult.outputVariables[key] = value;
                }
            }

            if (stepResult.result === 'Failed' && !stepDoc.continueOnError) {
                break;
            }
        }

        jobResult.result = jobResult.steps.some((s) => s.result === 'Failed') ? 'Failed' : 'Succeeded';

        return jobResult;
    }

    _runStep(stepDoc, variables, options) {
        const displayName = stepDoc.displayName || 'Step';
        const stepResult = {
            displayName,
            stepName: stepDoc.name || null,
            result: 'Succeeded',
            variables: {},
            outputVariables: {},
            stdout: '',
            stderr: '',
            exitCode: 0,
        };

        if (
            displayName === 'Create report' ||
            displayName === 'HPSS Signing' ||
            displayName === 'Convert .coverage to XML and Prepare for ReportGenerator'
        ) {
            stepResult.stdout = `[mock] ${displayName} (offline simulation)`;
            stepResult.variables = { PIPELINE_STATUS: 'Success' };
            return stepResult;
        }

        // Check for a display-name mock (keyed as "step:Display Name") before running anything.
        // This allows mocking bash steps by name without needing a task ID.
        const displayNameMock = this.mockCatalog[`step:${displayName}`];
        if (displayNameMock) {
            stepResult.result = displayNameMock.result || 'Succeeded';
            stepResult.stdout =
                displayNameMock.output !== undefined ? String(displayNameMock.output) : `[mock] ${displayName}`;
            stepResult.stderr = displayNameMock.stderr || '';
            stepResult.exitCode = stepResult.result === 'Succeeded' ? 0 : 1;
            stepResult.variables = { ...(displayNameMock.variables || {}) };
            const parsed = this._parseVsoDirectives(stepResult.stdout);
            Object.assign(stepResult.variables, parsed.local, parsed.output);
            stepResult.outputVariables = { ...parsed.output };
            return stepResult;
        }

        const scriptKey = SCRIPT_STEP_KEYS.find((k) => stepDoc[k] !== undefined);

        // Helper: apply parsed directives to step result
        const applyDirectives = (parsed) => {
            stepResult.variables = { ...parsed.local, ...parsed.output };
            stepResult.outputVariables = parsed.output;
        };

        if (scriptKey !== undefined) {
            // Native execution: bare bash: / script: / pwsh: / powershell: keys
            const scriptContent = String(stepDoc[scriptKey]);
            const substituted = this._substituteVariables(scriptContent, variables);
            const isPowerShell = scriptKey === 'pwsh' || scriptKey === 'powershell';
            const shell = isPowerShell ? 'pwsh' : 'bash';
            const rawWorkDir = stepDoc.workingDirectory || (options && options.workingDirectory) || '';
            const workDir = rawWorkDir
                ? this._substituteVariables(rawWorkDir, variables) || process.cwd()
                : process.cwd();

            const stepEnv = this._resolveStepEnv(stepDoc.env, variables);
            const run = this._executeScript(shell, substituted, variables, workDir, stepEnv);
            stepResult.stdout = run.stdout;
            stepResult.stderr = run.stderr;
            stepResult.exitCode = run.exitCode;
            stepResult.result = run.exitCode === 0 ? 'Succeeded' : 'Failed';
            applyDirectives(this._parseVsoDirectives(run.stdout));
        } else if (stepDoc.task) {
            // After template expansion, bash:/script:/pwsh: become task: Bash@3/CmdLine@2/PowerShell@2.
            // Detect these and run them natively; all other tasks go to the mock catalog.
            const nativeShell = NATIVE_TASK_SHELLS[stepDoc.task];
            const inputs = stepDoc.inputs || {};
            const rawWorkDir = inputs.workingDirectory || (options && options.workingDirectory) || '';
            const workDir = rawWorkDir
                ? this._substituteVariables(rawWorkDir, variables) || process.cwd()
                : process.cwd();

            if (nativeShell && inputs.script !== undefined) {
                const substituted = this._substituteVariables(String(inputs.script), variables);
                const stepEnv = this._resolveStepEnv(stepDoc.env, variables);
                const run = this._executeScript(nativeShell, substituted, variables, workDir, stepEnv);
                stepResult.stdout = run.stdout;
                stepResult.stderr = run.stderr;
                stepResult.exitCode = run.exitCode;
                stepResult.result = run.exitCode === 0 ? 'Succeeded' : 'Failed';
                applyDirectives(this._parseVsoDirectives(run.stdout));
            } else if (nativeShell && inputs.filePath) {
                const scriptPath = path.resolve(workDir, inputs.filePath);
                const env = { ...process.env };
                for (const [key, value] of Object.entries(variables)) {
                    env[key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')] = String(value);
                }
                const run = spawnSync(nativeShell, [scriptPath], {
                    env,
                    cwd: workDir,
                    encoding: 'utf8',
                    timeout: 60000,
                });

                if (run.error && run.error.code === 'ENOENT') {
                    if (nativeShell === 'pwsh') {
                        stepResult.stdout = '[mock] pwsh not available locally; step simulated.';
                        stepResult.stderr = '';
                        stepResult.exitCode = 0;
                    } else if (nativeShell === 'bash') {
                        stepResult.stdout = '[mock] bash not available locally; step simulated.';
                        stepResult.stderr = '';
                        stepResult.exitCode = 0;
                    } else {
                        stepResult.stdout = run.stdout || '';
                        stepResult.stderr = run.stderr || run.error.message;
                        stepResult.exitCode = 1;
                    }
                } else {
                    stepResult.stdout = run.stdout || '';
                    stepResult.stderr = run.stderr || (run.error ? run.error.message : '');
                    stepResult.exitCode = run.status !== null ? run.status : 1;
                }
                stepResult.result = stepResult.exitCode === 0 ? 'Succeeded' : 'Failed';
                applyDirectives(this._parseVsoDirectives(stepResult.stdout));
            } else {
                // Non-script task: look up mock catalog.
                // mock.variables     → local job-scoped variables
                // mock.outputVariables → isOutput=true variables (keyed as varName;
                //                       _runJob will prepend stepName. when the step
                //                       has a name: field)
                const mock = this._resolveMock(stepDoc.task, inputs);
                stepResult.result = mock.result || 'Succeeded';
                stepResult.stdout = mock.output !== undefined ? String(mock.output) : `[mock] Task: ${stepDoc.task}`;
                stepResult.stderr = mock.stderr || '';
                stepResult.exitCode = stepResult.result === 'Succeeded' ? 0 : 1;
                stepResult.variables = { ...(mock.variables || {}), ...(mock.outputVariables || {}) };
                stepResult.outputVariables = mock.outputVariables || {};
                this._applyTaskSideEffects(stepDoc.task, inputs, variables, workDir);
            }
        } else if (stepDoc.checkout !== undefined) {
            stepResult.stdout = `[skip] checkout ${stepDoc.checkout}`;
        } else if (stepDoc.download !== undefined) {
            stepResult.stdout = `[skip] download ${stepDoc.download}`;
        } else if (stepDoc.publish !== undefined) {
            stepResult.stdout = `[skip] publish ${stepDoc.publish}`;
        }

        return stepResult;
    }

    _shouldRunStep(stepDoc, variables) {
        if (!stepDoc || typeof stepDoc !== 'object') return true;
        const condition = stepDoc.condition;
        if (!condition || typeof condition !== 'string') return true;
        return this._evaluateCondition(condition, variables);
    }

    _evaluateCondition(expr, variables) {
        const condition = String(expr || '').trim();
        if (!condition) return true;

        if (condition === 'always()') return true;
        if (condition === 'succeeded()' || condition === 'succeededOrFailed()') return true;
        if (condition === 'failed()' || condition === 'canceled()') return false;

        const fnMatch = /^(and|or|not|eq|ne)\((.*)\)$/i.exec(condition);
        if (!fnMatch) return true;

        const fn = fnMatch[1].toLowerCase();
        const args = this._splitConditionArgs(fnMatch[2]);

        if (fn === 'not') {
            if (!args.length) return true;
            return !this._evaluateCondition(args[0], variables);
        }

        if (fn === 'and') {
            return args.every((a) => this._evaluateCondition(a, variables));
        }

        if (fn === 'or') {
            return args.some((a) => this._evaluateCondition(a, variables));
        }

        if (fn === 'eq' || fn === 'ne') {
            if (args.length < 2) return true;
            const left = this._resolveConditionValue(args[0], variables);
            const right = this._resolveConditionValue(args[1], variables);
            const isEqual = String(left) === String(right);
            return fn === 'eq' ? isEqual : !isEqual;
        }

        return true;
    }

    _splitConditionArgs(inner) {
        const args = [];
        let depth = 0;
        let quote = null;
        let current = '';
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if ((ch === "'" || ch === '"') && inner[i - 1] !== '\\') {
                if (quote === ch) quote = null;
                else if (!quote) quote = ch;
                current += ch;
                continue;
            }
            if (!quote) {
                if (ch === '(') depth++;
                if (ch === ')') depth--;
                if (ch === ',' && depth === 0) {
                    args.push(current.trim());
                    current = '';
                    continue;
                }
            }
            current += ch;
        }
        if (current.trim()) args.push(current.trim());
        return args;
    }

    _resolveConditionValue(token, variables) {
        const v = String(token || '').trim();
        if (/^'.*'$/.test(v) || /^".*"$/.test(v)) {
            return v.slice(1, -1);
        }
        if (/^(true|false)$/i.test(v)) return v.toLowerCase();

        const varMatch = /^variables\[['"]([^'"]+)['"]\]$/i.exec(v);
        if (varMatch) {
            const key = varMatch[1];
            return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : '';
        }

        if (Object.prototype.hasOwnProperty.call(variables, v)) return variables[v];
        return v;
    }

    /**
     * Extract the `variables:` block from any pipeline doc node (pipeline, stage, job).
     * Works for both array ([{name, value}]) and object ({key: value}) formats.
     * Applies runtime expression mocking.
     * @param {object} parentVariables - Already-resolved variables to use when a value references $(anotherVar)
     */
    _extractVariablesFromDoc(doc, parentVariables = {}, libraryVariables = {}) {
        return this._extractPipelineVariables(doc, parentVariables, libraryVariables);
    }

    /**
     * Extract top-level pipeline variables from the expanded document.
     * Handles both object format ({ varName: value }) and array format
     * ([{ name, value }, { name, value }]).
     */
    _extractPipelineVariables(document, parentVariables = {}, libraryVariables = {}) {
        const vars = {};
        const raw = document.variables;
        if (!raw) return vars;

        if (Array.isArray(raw)) {
            for (const entry of raw) {
                if (entry && typeof entry === 'object' && typeof entry.group === 'string' && entry.group.trim()) {
                    const groupVariables =
                        libraryVariables && typeof libraryVariables === 'object' ? libraryVariables[entry.group] : null;
                    if (groupVariables && typeof groupVariables === 'object' && !Array.isArray(groupVariables)) {
                        for (const [name, value] of Object.entries(groupVariables)) {
                            const ctx = { ...parentVariables, ...vars };
                            vars[name] = this._substituteVariables(
                                this._normalizeValue(value !== undefined ? String(value) : '', ctx),
                                ctx
                            );
                        }
                    }
                    continue;
                }
                if (entry && typeof entry === 'object' && entry.name !== undefined) {
                    const strValue = entry.value !== undefined ? String(entry.value) : '';
                    const ctx = { ...parentVariables, ...vars };
                    vars[entry.name] = this._substituteVariables(this._normalizeValue(strValue, ctx), ctx);
                }
            }
        } else if (typeof raw === 'object') {
            for (const [key, value] of Object.entries(raw)) {
                if (key === 'group') continue;
                const ctx = { ...parentVariables, ...vars };
                vars[key] = this._substituteVariables(
                    this._normalizeValue(value !== undefined ? String(value) : '', ctx),
                    ctx
                );
            }
        }
        return vars;
    }

    /**
     * Normalize a variable value from the expanded document:
     * - Convert parser boolean sentinels __TRUE__/__FALSE__ to 'true'/'false'
     * - Resolve runtime expressions $[...] against the current variable map
     *
     * @param {string} value
     * @param {object} variables - Current variable map (used to resolve $[...] expressions)
     */
    _normalizeValue(value, variables = {}) {
        const lower = value.toLowerCase();
        if (lower === '__true__') return 'true';
        if (lower === '__false__') return 'false';
        return this._resolveRuntimeExpression(value, variables);
    }

    /**
     * Resolve a $[...] runtime expression against the current variable map.
     * Also handles ${{ }} template expression remnants.
     *
     * Processing rules (mirrors Azure DevOps behaviour):
     *   Syntax    : $[ expression ]
     *   Timing    : runtime
     *   Not found : empty string
     *
     *   $[ counter(...) ]                               → '1'  (mock)
     *   $[ stageDependencies.S.J.outputs['s.v'] ]       → resolved from variables map
     *   $[ dependencies.J.outputs['s.v'] ]              → resolved from variables map
     *   $[ variables.foo ]                              → variables['foo']
     *   $[ <any other expression not in map> ]          → ''
     *   ${{ ... }}  (template expression remnant)       → ''
     */
    _resolveRuntimeExpression(value, variables) {
        if (/^\$\[\s*counter\b/.test(value)) return '1';
        if (/^\$\{\{/.test(value)) return ''; // template expression remnant → empty string
        if (!/^\$\[/.test(value)) return value; // not a runtime expression, pass through

        // Strip $[ and ] with optional surrounding whitespace.
        const inner = value
            .replace(/^\$\[\s*/, '')
            .replace(/\s*\]$/, '')
            .trim();

        // $[ variables.x ] → look up 'x' directly in the variables map.
        const varsPrefixMatch = /^variables\.(.+)$/i.exec(inner);
        if (varsPrefixMatch) {
            const varName = varsPrefixMatch[1].trim();
            return Object.prototype.hasOwnProperty.call(variables, varName) ? variables[varName] : '';
        }

        // Direct lookup: handles stageDependencies.S.J.outputs['s.v'],
        // dependencies.J.outputs['s.v'], and any other keyed expression.
        if (Object.prototype.hasOwnProperty.call(variables, inner)) {
            return variables[inner];
        }

        return ''; // Unresolved runtime expression → empty string
    }

    /**
     * Substitute $(varName) macro references using the current variable map.
     *
     * Processing rules (mirrors Azure DevOps behaviour):
     *   Syntax    : $(var)
     *   Timing    : runtime, before a task executes
     *   Not found : prints $(var)  ← macro keeps its literal text when unresolved
     *
     * Bash command substitutions that share the $(...) syntax are left untouched
     * because their inner content contains whitespace or shell operators, or is
     * an all-lowercase single word (e.g. $(pwd), $(date)).
     *
     * Template expressions ${{ }} are compile-time and are fully resolved by the
     * parser before simulate() is called — they never appear here.
     * Runtime expressions $[...] are handled by _mockRuntimeExpression().
     */
    _substituteVariables(text, variables) {
        return text.replace(/\$\(([^)]+)\)/g, (match, name) => {
            const trimmed = name.trim();
            // Bash command substitution: contains spaces or shell operators → leave intact.
            if (/[\s|>&;`]/.test(trimmed)) return match;
            if (Object.prototype.hasOwnProperty.call(variables, trimmed)) {
                return variables[trimmed];
            }
            // All-lowercase single word not in variables is likely a shell
            // built-in (e.g. pwd, date, whoami) → leave intact.
            if (/^[a-z][a-z0-9_]*$/.test(trimmed)) return match;
            // Unresolved Azure macro → keep literal $(var) per ADO spec.
            return match;
        });
    }

    _resolveStepEnv(envBlock, variables) {
        const resolved = {};
        if (!envBlock || typeof envBlock !== 'object') return resolved;
        for (const [key, value] of Object.entries(envBlock)) {
            resolved[key] = this._substituteVariables(String(value), variables);
        }
        return resolved;
    }

    _executeScript(shell, script, variables, workingDirectory, extraEnv = {}) {
        const shimDir = this._getShimDir();
        const ext = shell === 'bash' ? '.sh' : '.ps1';
        const tmpFile = path.join(os.tmpdir(), `aps-sim-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);

        try {
            let scriptContent = script;

            if (shell === 'bash') {
                // Convert unresolved ADO macros that look like $(UPPER_CASE_VAR) into
                // bash variable references ${UPPER_CASE_VAR}. Without this, bash would
                // try to run UPPER_CASE_VAR as a command ("command not found"). With it,
                // variables exported earlier in the same script via ##vso[task.setvariable]
                // are accessible to subsequent lines.
                scriptContent = scriptContent.replace(/\$\(([A-Z_][A-Z0-9_]*)\)/g, '$${$1}');

                // Inject a preamble that intercepts each echo "##vso[task.setvariable...]"
                // call and exports the variable as a real bash variable. This makes
                // ##vso-set variables available to later lines in the same script.
                const preamble = [
                    '# APS Simulator preamble: export ##vso[task.setvariable] variables as bash variables',
                    'echo() {',
                    '    command echo "$@"',
                    '    local _aps_line="$*" _aps_var _aps_val',
                    "    if [[ \"$_aps_line\" =~ ^'##vso[task.setvariable'[^]]*'variable='([A-Za-z_][A-Za-z0-9_]*)[^]]*']'(.*) ]]; then",
                    '        _aps_var="${BASH_REMATCH[1]}"',
                    '        _aps_val="${BASH_REMATCH[2]}"',
                    '        declare -g "$_aps_var=$_aps_val" 2>/dev/null || true',
                    '        export "$_aps_var" 2>/dev/null || true',
                    '    fi',
                    '}',
                    '',
                ].join('\n');
                scriptContent = preamble + scriptContent;
            }

            fs.writeFileSync(tmpFile, scriptContent, { mode: 0o755 });

            // Expose pipeline variables as env vars using Azure DevOps convention:
            // dot/special chars → underscore, all uppercase (e.g. Build.Reason → BUILD_REASON)
            const env = { ...process.env };
            for (const [key, value] of Object.entries(variables)) {
                const safeKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                env[safeKey] = String(value);
            }
            // Step-level env: (from YAML `env:` block) — applied with their original key names
            for (const [key, value] of Object.entries(extraEnv)) {
                env[key] = String(value);
            }
            // Prepend shim dir so mock tools shadow any missing real tools
            env.PATH = shimDir + path.delimiter + (env.PATH || '');

            const resolvedCwd = workingDirectory
                ? path.resolve(String(workingDirectory).replace(/\\/g, '/'))
                : process.cwd();

            const tryRun = (shellName) =>
                spawnSync(shellName, [tmpFile], {
                    env,
                    cwd: resolvedCwd,
                    encoding: 'utf8',
                    timeout: 60000,
                });

            let run = tryRun(shell);
            if (run.error && run.error.code === 'ENOENT') {
                if (shell === 'bash') {
                    // Some hosts expose bash only via /bin/bash or sh.
                    run = tryRun('/bin/bash');
                    if (run.error && run.error.code === 'ENOENT') {
                        run = tryRun('sh');
                        if (run.error && run.error.code === 'ENOENT') {
                            return {
                                stdout: '[mock] bash/sh not available locally; step simulated.',
                                stderr: '',
                                exitCode: 0,
                            };
                        }
                    }
                } else if (shell === 'pwsh') {
                    // Keep simulation moving when pwsh is unavailable locally.
                    return {
                        stdout: '[mock] pwsh not available locally; step simulated.',
                        stderr: '',
                        exitCode: 0,
                    };
                }
            }

            return {
                stdout: run.stdout || '',
                stderr: run.stderr || (run.error ? run.error.message : ''),
                exitCode: run.status !== null ? run.status : 1,
            };
        } finally {
            try {
                fs.unlinkSync(tmpFile);
            } catch (_) {}
        }
    }

    /**
     * Lazily create (once per simulator instance) a temp directory of no-op
     * shim scripts for tools listed in this.mockTools that aren't on the PATH.
     */
    _getShimDir() {
        if (this._shimDir) return this._shimDir;

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-shims-'));
        this._shimDir = dir;

        for (const tool of this.mockTools) {
            const toolPath = path.join(dir, tool.name);
            const exitCode = tool.exitCode !== undefined ? tool.exitCode : 0;
            const stdout = tool.stdout || '';
            let shimContent = `#!/usr/bin/env bash
# Mock shim for ${tool.name}
echo ${JSON.stringify(`[mock-tool] ${tool.name} $*`)} >&2
${stdout ? `echo ${JSON.stringify(stdout)}` : ''}
exit ${exitCode}
`;

            if (tool.name === 'curl') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for curl used by simulator offline mode
echo ${JSON.stringify('[mock-tool] curl $*')} >&2
out=""
prev=""
for arg in "$@"; do
    if [[ "$prev" == "-o" ]]; then
        out="$arg"
        break
    fi
    prev="$arg"
done
if [[ -n "$out" ]]; then
    mkdir -p "$(dirname "$out")"
    : > "$out"
fi
exit 0
`;
            } else if (tool.name === 'unzip') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for unzip used by simulator offline mode
echo ${JSON.stringify('[mock-tool] unzip $*')} >&2
dest="."
prev=""
for arg in "$@"; do
    if [[ "$prev" == "-d" ]]; then
        dest="$arg"
        break
    fi
    prev="$arg"
done
mkdir -p "$dest/build-wrapper-win-x86"
touch "$dest/build-wrapper-win-x86/build-wrapper-win-x86-64.exe"
exit 0
`;
            } else if (tool.name === 'file') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for file to classify dummy .dll/.exe artifacts for scanners
target="$1"
case "$target" in
    *.dll|*.exe)
        echo "$target: PE32+ executable (console) x86-64, for MS Windows, Mono/.Net assembly"
        ;;
    *.pdb)
        echo "$target: data"
        ;;
    *)
        echo "$target: data"
        ;;
esac
exit 0
`;
            }
            fs.writeFileSync(toolPath, shimContent, { mode: 0o755 });
        }

        // Clean up on process exit
        process.once('exit', () => {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (_) {}
        });

        return dir;
    }

    /**
     * Parse ##vso[task.setvariable variable=X;isOutput=true]value directives.
     * Returns { local, output } where:
     *   local  – variables with isOutput=false (or unset), scoped to the current job
     *   output – variables with isOutput=true, also published for downstream jobs
     */
    _parseVsoDirectives(stdout) {
        const local = {};
        const output = {};
        const pattern = /##vso\[task\.setvariable\s+([^\]]+)\]([^\n]*)/g;
        let match;
        while ((match = pattern.exec(stdout)) !== null) {
            const attrs = match[1];
            const value = match[2].trim();
            const varNameMatch = /variable=([^;\]]+)/i.exec(attrs);
            if (!varNameMatch) continue;
            const varName = varNameMatch[1].trim();
            const isOutput = /isOutput=true/i.test(attrs);
            if (isOutput) {
                output[varName] = value;
            } else {
                local[varName] = value;
            }
        }
        return { local, output };
    }

    /**
     * Resolve a task mock from the catalog.
     * Tries exact "TaskName@Version" first, then just "TaskName".
     * Falls back to a default pass-through mock so pipelines don't break.
     */
    _resolveMock(taskRef, inputs) {
        const taskName = taskRef.split('@')[0];
        return (
            this.mockCatalog[taskRef] ||
            this.mockCatalog[taskName] || { result: 'Succeeded', output: `[mock] Task: ${taskRef}`, variables: {} }
        );
    }

    _applyTaskSideEffects(taskRef, inputs, variables, workDir) {
        if (!taskRef || !inputs || typeof inputs !== 'object') return;
        const taskName = String(taskRef).split('@')[0];

        if (taskName === 'DownloadPipelineArtifact') {
            const rawTarget = inputs.targetPath || inputs.path || '';
            if (!rawTarget) return;
            const resolvedTarget = this._substituteVariables(String(rawTarget), variables).replace(/\\/g, '/');
            const targetPath = path.resolve(workDir || process.cwd(), resolvedTarget);
            try {
                fs.mkdirSync(targetPath, { recursive: true });
                fs.writeFileSync(path.join(targetPath, 'readme.txt'), 'PipelineStatusLogs');
                const sampleArtifacts = [
                    'VoiceSdk/bin/mock.dll',
                    'VoiceSdk/bin/mock.pdb',
                    'VoiceSdk/bin/Any.Tests.dll',
                    'VoiceService/bin/x64/Release/mock.dll',
                    'VoiceService/bin/ARM64/Release/mock.dll',
                    'VoiceService/bin/mock.json',
                    'VoiceService/VoiceService.cfg',
                    'nuget/hp.win.sdk.voice.nuspec',
                    'nuget/hp.win.svc.voice.nuspec',
                ];
                for (const rel of sampleArtifacts) {
                    const abs = path.join(targetPath, rel);
                    fs.mkdirSync(path.dirname(abs), { recursive: true });
                    if (!fs.existsSync(abs)) fs.writeFileSync(abs, 'mock');
                }
            } catch (_) {}
        }
    }
}

function printSimulationResults(results) {
    const ICON = { Succeeded: '\u2714', Failed: '\u2716', Skipped: '\u29d8' };
    const COLOR = { Succeeded: '\x1b[32m', Failed: '\x1b[31m', Skipped: '\x1b[33m' };
    const RESET = '\x1b[0m';
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[2m';

    for (const stageResult of results.stages) {
        console.log();
        console.log(`${BOLD}${'═'.repeat(64)}${RESET}`);
        console.log(`${BOLD} Stage: ${stageResult.displayName || stageResult.stage}${RESET}`);
        console.log(`${BOLD}${'═'.repeat(64)}${RESET}`);

        for (const jobResult of stageResult.jobs) {
            console.log();
            console.log(`  ${BOLD}▶ Job: ${jobResult.displayName || jobResult.job}${RESET}`);

            for (const stepResult of jobResult.steps) {
                const res = stepResult.result;
                const icon = ICON[res] || '?';
                const color = COLOR[res] || '';

                console.log();
                console.log(`    ${color}${icon} ${stepResult.displayName}${RESET}`);
                console.log(`    ${DIM}${'─'.repeat(58)}${RESET}`);

                if (stepResult.stdout) {
                    stepResult.stdout
                        .split('\n')
                        .filter((l) => l.trim() && !l.startsWith('##vso['))
                        .forEach((l) => console.log(`      ${l}`));
                }
                if (stepResult.stderr) {
                    stepResult.stderr
                        .split('\n')
                        .filter((l) => l.trim())
                        .forEach((l) => console.error(`      ${DIM}[stderr]${RESET} ${l}`));
                }
                const localVars = Object.entries(stepResult.variables).filter(
                    ([k]) => !Object.prototype.hasOwnProperty.call(stepResult.outputVariables, k)
                );
                const outputVars = Object.entries(stepResult.outputVariables || {});
                for (const [k, v] of localVars) {
                    console.log(`      ${DIM}[var]${RESET} ${k}=${v}`);
                }
                for (const [k, v] of outputVars) {
                    console.log(`      ${DIM}[out]${RESET} ${k}=${v}`);
                }
            }
        }
    }

    const total = results.totalPassed + results.totalFailed + results.totalSkipped;
    console.log();
    console.log(`${BOLD}${'═'.repeat(64)}${RESET}`);
    console.log(
        ` ${BOLD}Summary${RESET}: ${total} step(s)  ` +
            `${COLOR.Succeeded}${results.totalPassed} passed${RESET}  ` +
            `${COLOR.Failed}${results.totalFailed} failed${RESET}  ` +
            `${COLOR.Skipped}${results.totalSkipped} skipped${RESET}`
    );
    console.log(`${BOLD}${'═'.repeat(64)}${RESET}`);
    console.log();
}

module.exports = { PipelineSimulator, printSimulationResults };
