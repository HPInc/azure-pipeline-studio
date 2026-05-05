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

const CHECKOUT_TASK = '6d15af64-176c-496d-b583-fd2ae21d4df4@1';

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
        this.outputRoot = options.outputRoot || '';
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
            { name: 'java' },
            { name: 'keytool' },
            { name: 'file' },
            { name: 'yq', stdout: 'mock-version' },
            { name: 'cygpath', stdout: '/mock-path' },
        ];
        this._shimDir = null;
        this._publishedArtifacts = [];
        this._feedPublishes = [];
        this._releaseStageNugetFeed = null;
        this._downloadedArtifactTargets = new Map();
        this._jobRunCounter = 0;
    }

    /**
     * Simulate an already-expanded pipeline document.
     * @param {object} document - Expanded JS document from AzurePipelineParser
     * @param {object} options  - { variables: {}, libraryVariables: {}, workingDirectory: '' }
     * @returns {object} Structured results with per-stage, per-job, per-step data
     */
    simulate(document, options = {}) {
        const results = {
            stages: [],
            totalPassed: 0,
            totalFailed: 0,
            totalSkipped: 0,
            publishedArtifacts: [],
            feedPublishes: [],
        };
        const stages = Array.isArray(document.stages) ? document.stages : [];
        const debugLibVars = process.env.DEBUG_LIB_VARS === 'true';
        const resolvedWorkDir = options.workingDirectory || process.cwd();
        this._publishedArtifacts = [];
        this._feedPublishes = [];
        this._downloadedArtifactTargets = new Map();
        this._jobRunCounter = 0;

        // Build the initial variable map:
        // 1. Azure built-in defaults (lowest priority)
        // 2. Pipeline-level variables declared in the YAML (including library group variables)
        // 3. User-supplied -v overrides (highest priority)
        const pipelineVars = this._extractPipelineVariables(document, {}, options.libraryVariables || {});
        if (debugLibVars && Object.keys(pipelineVars).length > 0) {
            console.log('[DEBUG] Pipeline variables extracted:', JSON.stringify(pipelineVars, null, 2));
        }
        const initialVariables = {
            ...AZURE_DEFAULTS,
            ...(options.defaultVariables || {}),
            ...pipelineVars,
            ...(options.variables || {}),
        };

        this._ensureSimulationDirectories(initialVariables);
        this._resetSimulationWorkspace(initialVariables, resolvedWorkDir);

        // Extract Release stage NuGet feed identifier for use in fallback publishing
        this._releaseStageNugetFeed = this._extractReleaseStageNugetFeed(stages);

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

        // Always materialize publish roots so callers can inspect expected paths
        // even when no publish step ran due to conditions or earlier failures.
        this._ensureFallbackPackageArtifacts(initialVariables, resolvedWorkDir);
        this._writePipelineArtifactsIndex(this._getPipelineArtifactsRoot(initialVariables, resolvedWorkDir));
        this._writeBuildArtifactsIndex(this._getBuildArtifactsRoot(initialVariables, resolvedWorkDir));
        this._writeFeedPublishesIndex(this._getFeedPublishRoot(initialVariables, resolvedWorkDir));

        results.publishedArtifacts = [...this._publishedArtifacts];
        results.feedPublishes = [...this._feedPublishes];
        return results;
    }

    _resetSimulationWorkspace(variables, workDir) {
        const simulationRoot = this._getSimulationRoot(variables, workDir);
        const jobsRoot = path.join(simulationRoot, 'workspace', 'jobs');
        fs.rmSync(jobsRoot, { recursive: true, force: true });
        fs.mkdirSync(jobsRoot, { recursive: true });
    }

    _ensureSimulationDirectories(variables) {
        const directoryKeys = [
            'Build.ArtifactStagingDirectory',
            'Build.StagingDirectory',
            'Build.BinariesDirectory',
            'Pipeline.Workspace',
            'Agent.WorkFolder',
            'Agent.BuildDirectory',
            'Agent.TempDirectory',
            'Agent.ToolsDirectory',
            'Agent.HomeDirectory',
        ];

        for (const key of directoryKeys) {
            const value = variables[key];
            if (typeof value !== 'string' || !value.trim()) {
                continue;
            }

            try {
                fs.mkdirSync(path.resolve(value), { recursive: true });
            } catch (_) {}
        }
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
            const matrixJobs = this._expandMatrixJob(jobDoc, stageVariables);
            for (const { jobDoc: expandedJobDoc, matrixVars, matrixName } of matrixJobs) {
                const jobVariablesWithMatrix = { ...stageVariables, ...matrixVars };
                const jobResult = this._runJob(expandedJobDoc, jobVariablesWithMatrix, options);
                if (matrixName) {
                    jobResult.matrixName = matrixName;
                    jobResult.displayName = matrixName;
                }
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
        }

        return stageResult;
    }

    /**
     * Expand a job's strategy.matrix into individual { jobDoc, matrixVars, matrixName } entries.
     * If the job has no strategy.matrix, returns a single entry with empty matrixVars.
     */
    _expandMatrixJob(jobDoc, variables) {
        const matrix = jobDoc.strategy && jobDoc.strategy.matrix;
        if (!matrix || typeof matrix !== 'object') {
            return [{ jobDoc, matrixVars: {}, matrixName: null }];
        }
        const entries = [];
        for (const [matrixName, matrixVars] of Object.entries(matrix)) {
            if (!matrixVars || typeof matrixVars !== 'object') continue;
            // Substitute any remaining $(var) references in matrix values using inherited variables.
            const resolvedVars = {};
            for (const [k, v] of Object.entries(matrixVars)) {
                resolvedVars[k] = this._substituteVariables(String(v), variables);
            }
            entries.push({ jobDoc, matrixVars: resolvedVars, matrixName });
        }
        return entries.length > 0 ? entries : [{ jobDoc, matrixVars: {}, matrixName: null }];
    }

    _runJob(jobDoc, variables, options) {
        const jobName = jobDoc.job || jobDoc.deployment || 'Job';
        const jobWorkspaceVariables = this._prepareJobWorkspace(jobName, variables, options);
        const jobResult = {
            job: jobName,
            displayName: jobDoc.displayName || jobName,
            steps: [],
            // Collected isOutput=true variables keyed as 'stepName.varName'
            outputVariables: {},
        };

        const steps = Array.isArray(jobDoc.steps) ? jobDoc.steps : [];
        const jobVariableContext = {
            ...variables,
            ...jobWorkspaceVariables,
        };
        // Merge job-level variables on top of the inherited ones.
        const jobVariables = {
            ...variables,
            ...jobWorkspaceVariables,
            ...this._extractVariablesFromDoc(jobDoc, jobVariableContext, options.libraryVariables || {}),
        };
        const stepOptions = {
            ...options,
            // Scripts without explicit workingDirectory should run inside the job's clean sources directory.
            workingDirectory: jobVariables['Build.SourcesDirectory'],
            // Keep the original repository root available for checkout simulation.
            repositoryRoot: options.workingDirectory || process.cwd(),
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

            const stepResult = this._runStep(stepDoc, jobVariables, stepOptions);
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

    _prepareJobWorkspace(jobName, variables, options) {
        const simulationRoot = this._getSimulationRoot(variables, options.workingDirectory);
        this._jobRunCounter += 1;
        const jobFolderName = `${String(this._jobRunCounter).padStart(3, '0')}-${this._sanitizePathSegment(jobName)}`;
        const jobRoot = path.join(simulationRoot, 'workspace', 'jobs', jobFolderName);

        fs.rmSync(jobRoot, { recursive: true, force: true });

        const sourcesDirectory = path.join(jobRoot, 's');
        const tempDirectory = path.join(jobRoot, 'temp');

        for (const directory of [jobRoot, sourcesDirectory, tempDirectory]) {
            fs.mkdirSync(directory, { recursive: true });
        }

        return {
            'Build.SourcesDirectory': sourcesDirectory,
            'Build.Repository.LocalPath': sourcesDirectory,
            'Agent.TempDirectory': tempDirectory,
            'Simulator.JobSourcesRoot': sourcesDirectory,
        };
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

        // Veracode installer intercept — create jar stub and set ScanJar variable
        if (displayName === 'Veracode download') {
            const cacheFolder = path.resolve(
                String(variables['Agent.WorkFolder'] || '/tmp/aps-sim-work'),
                '_cache',
                'veracode'
            );
            fs.mkdirSync(cacheFolder, { recursive: true });
            const jarPath = path.join(cacheFolder, 'pipeline-scan.jar');
            if (!fs.existsSync(jarPath)) {
                fs.writeFileSync(jarPath, '[sim] veracode pipeline-scan.jar stub\n', 'utf8');
            }
            stepResult.stdout = `[sim] Veracode download: jar stub created at ${jarPath}`;
            stepResult.variables = { ScanJar: jarPath };
            return stepResult;
        }

        // Veracode filter step — mock out assembly scanning and write a stub scanfiles.txt
        if (displayName === 'Filter assemblies for Veracode') {
            const tempDir = String(variables['Agent.TempDirectory'] || '/tmp');
            const scanFilesPath = path.join(tempDir, 'scanfiles.txt');
            fs.mkdirSync(tempDir, { recursive: true });
            if (!fs.existsSync(scanFilesPath)) {
                fs.writeFileSync(scanFilesPath, '', 'utf8');
            }
            stepResult.stdout = `[sim] Filter assemblies for Veracode: stub scanfiles.txt written to ${scanFilesPath}`;
            stepResult.variables = { CPP_PDB_EXISTS: 'false' };
            return stepResult;
        }

        // Veracode archive step — create veracode-app.zip stub in the job sources directory
        if (displayName === 'Archive veracode-app') {
            const jobWorkDir = String(
                variables['Build.SourcesDirectory'] || variables['Build.Repository.LocalPath'] || process.cwd()
            );
            const zipPath = path.resolve(jobWorkDir, 'veracode-app.zip');
            fs.mkdirSync(path.dirname(zipPath), { recursive: true });
            if (!fs.existsSync(zipPath)) {
                fs.writeFileSync(zipPath, '[sim] veracode-app.zip stub\n', 'utf8');
            }
            stepResult.stdout = `[sim] Archive veracode-app: ${zipPath}`;
            return stepResult;
        }

        // Veracode file-verify intercept — Verify file veracode-app.zip exists
        if (/^Verify file .* exists$/.test(displayName)) {
            stepResult.stdout = `[sim] ${displayName} (skipped in simulation)`;
            return stepResult;
        }

        // Veracode pipeline scan intercept — simulate passing scan result
        if (displayName === 'Veracode Pipeline scan' || /^Scanning/.test(displayName)) {
            const scanResultFile = path.join(
                String(variables['Build.SourcesDirectory'] || process.cwd()),
                'veracodeResults.txt'
            );
            const scanJsonFile = path.join(
                String(variables['Build.SourcesDirectory'] || process.cwd()),
                'veracodeResults.json'
            );
            fs.mkdirSync(path.dirname(scanResultFile), { recursive: true });
            if (!fs.existsSync(scanResultFile)) {
                fs.writeFileSync(scanResultFile, '[sim] Veracode scan passed - no findings\n', 'utf8');
            }
            if (!fs.existsSync(scanJsonFile)) {
                fs.writeFileSync(
                    scanJsonFile,
                    JSON.stringify({ findings: [], message: 'Simulated clean scan' }, null, 2) + '\n',
                    'utf8'
                );
            }
            stepResult.stdout = `[sim] Veracode Pipeline Scan: passed (simulated)\nScanning ${String(variables['fileName'] || 'veracode-app.zip')}...\nResults written to ${scanResultFile}`;
            stepResult.variables = {
                scanResult: '0',
                summary: 'true',
                veracodeSummary: 'true',
                'VeracodePipelineScan.scanResult': '0',
                fileName: String(variables['fileName'] || 'veracode-app.zip'),
            };
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

            const simulatedNugetPack = this._simulateTemplateNuGetPackStep(
                displayName,
                substituted,
                variables,
                workDir
            );
            if (simulatedNugetPack) {
                stepResult.stdout = simulatedNugetPack.stdout;
                stepResult.stderr = '';
                stepResult.exitCode = 0;
                stepResult.result = 'Succeeded';
                stepResult.variables = { ...(simulatedNugetPack.variables || {}) };
                stepResult.outputVariables = {};
                return stepResult;
            }

            const simulatedNugetPush = this._simulateTemplateNuGetPushStep(displayName, variables, workDir);
            if (simulatedNugetPush) {
                stepResult.stdout = simulatedNugetPush.stdout;
                stepResult.stderr = '';
                stepResult.exitCode = 0;
                stepResult.result = 'Succeeded';
                stepResult.variables = { ...(simulatedNugetPush.variables || {}) };
                stepResult.outputVariables = {};
                return stepResult;
            }

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
            if (String(stepDoc.task).toLowerCase() === CHECKOUT_TASK.toLowerCase()) {
                stepResult.stdout = this._simulateCheckout(inputs, variables, options, workDir);
                stepResult.stderr = '';
                stepResult.exitCode = 0;
                stepResult.result = 'Succeeded';
                stepResult.variables = {};
                stepResult.outputVariables = {};
                return stepResult;
            }

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

                // Special handling: NuGetAuthenticate@1 should inject VSS_NUGET_EXTERNAL_FEED_ENDPOINTS
                // for subsequent bash scripts that fetch credentials from it.
                if (stepDoc.task === 'NuGetAuthenticate@1' && stepResult.result === 'Succeeded') {
                    const connections = String(inputs.nuGetServiceConnections || 'DefaultNuGetFeed')
                        .split(',')
                        .map((c) => c.trim());
                    if (connections.length > 0) {
                        const endpointCreds = connections.map((conn, idx) => ({
                            endpoint: `https://pkgs.dev.azure.com/local/${conn}/nuget/v3/index.json`,
                            username: 'PAT',
                            password: `[mock-${conn}]`,
                        }));
                        const vssNugetEnv = JSON.stringify({ endpointCredentials: endpointCreds });
                        stepResult.variables['VSS_NUGET_EXTERNAL_FEED_ENDPOINTS'] = vssNugetEnv;
                    }
                }

                const sideEffectMessage = this._applyTaskSideEffects(stepDoc.task, inputs, variables, workDir);
                if (sideEffectMessage) {
                    stepResult.stdout = `${stepResult.stdout}\n${sideEffectMessage}`.trim();
                }
            }
        } else if (stepDoc.checkout !== undefined) {
            stepResult.stdout = this._simulateCheckout(
                {
                    repository: stepDoc.checkout,
                    path: stepDoc.path,
                    clean: stepDoc.clean,
                    simulatorCheckoutSource: stepDoc.simulatorCheckoutSource,
                },
                variables,
                options,
                options.workingDirectory || process.cwd()
            );
        } else if (stepDoc.download !== undefined) {
            stepResult.stdout = `[skip] download ${stepDoc.download}`;
        } else if (stepDoc.publish !== undefined) {
            stepResult.stdout = `[skip] publish ${stepDoc.publish}`;
        }

        return stepResult;
    }

    _simulateCheckout(inputs, variables, options, workDir) {
        const repository = this._substituteTaskInputVariables(String(inputs.repository || 'self'), variables).trim();
        if (repository.toLowerCase() === 'none') {
            return '[sim] checkout skipped: repository=none';
        }

        const checkoutSourceRaw = this._substituteTaskInputVariables(
            String(
                inputs.simulatorCheckoutSource ||
                    options.checkoutSource ||
                    variables['Simulator.CheckoutSource'] ||
                    'local'
            ),
            variables
        )
            .trim()
            .toLowerCase();
        const checkoutSource = checkoutSourceRaw === 'git' ? 'git' : 'local';

        const sourcesRoot = path.resolve(
            String(
                variables['Simulator.JobSourcesRoot'] || variables['Build.SourcesDirectory'] || workDir || process.cwd()
            )
        );
        const defaultTarget = variables['Build.SourcesDirectory'] || sourcesRoot;
        let targetPath = this._resolvePath(String(inputs.path || defaultTarget), variables, sourcesRoot);
        targetPath = this._collapseCheckoutAllSegments(sourcesRoot, targetPath);
        const rawSource = String(
            options.checkoutRepository || options.repositoryRoot || options.workingDirectory || process.cwd()
        );
        const isRemoteUrl = /^(https?:\/\/|ssh:\/\/|git@)/i.test(rawSource);
        const repositoryRoot = isRemoteUrl ? rawSource : path.resolve(rawSource);

        fs.rmSync(targetPath, { recursive: true, force: true });
        fs.mkdirSync(targetPath, { recursive: true });

        if (checkoutSource === 'git') {
            const clone = spawnSync('git', ['clone', '--depth', '1', repositoryRoot, targetPath], {
                cwd: process.cwd(),
                encoding: 'utf8',
                timeout: 180000,
            });
            if (!clone.error && clone.status === 0) {
                return `[sim] checkout (${checkoutSource}): ${repository} -> ${targetPath}`;
            }
        }

        // Local-source fallback keeps simulation deterministic/offline and mirrors the checked-out tree.
        this._copyDirectoryContents(repositoryRoot, targetPath, {
            excludeTopLevelNames: ['.git', '.azure-pipeline-studio'],
        });
        return `[sim] checkout (${checkoutSource === 'git' ? 'local-fallback' : 'local'}): ${repository} -> ${targetPath}`;
    }

    _collapseCheckoutAllSegments(sourcesRoot, targetPath) {
        const resolvedRoot = path.resolve(String(sourcesRoot || ''));
        const resolvedTarget = path.resolve(String(targetPath || ''));
        const relativePath = path.relative(resolvedRoot, resolvedTarget);

        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return resolvedTarget;
        }

        const segments = relativePath.split(path.sep).filter(Boolean);
        const collapsedSegments = [];
        for (const segment of segments) {
            const previousSegment = collapsedSegments[collapsedSegments.length - 1];
            if (previousSegment && /^all$/i.test(previousSegment) && /^all$/i.test(segment)) {
                continue;
            }
            collapsedSegments.push(segment);
        }

        if (collapsedSegments.length === segments.length) {
            return resolvedTarget;
        }

        return path.resolve(resolvedRoot, ...collapsedSegments);
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
        return text.replace(/\$\(([A-Za-z_][A-Za-z0-9_.-]*)\)/g, (match, name) => {
            if (Object.prototype.hasOwnProperty.call(variables, name)) {
                return variables[name];
            }
            // All-lowercase single word not in variables is likely a shell
            // built-in (e.g. pwd, date, whoami) → leave intact.
            if (/^[a-z][a-z0-9_]*$/.test(name)) return match;
            // Unresolved Azure macro → keep literal $(var) per ADO spec.
            return match;
        });
    }

    _substituteTaskInputVariables(text, variables) {
        const source = String(text);

        const substituteByName = (match, name) => {
            const value = this._resolveVariableValue(name, variables);
            return value !== undefined ? value : match;
        };

        return source
            .replace(/\$\(([^)]+)\)/g, substituteByName)
            .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, substituteByName);
    }

    _resolveVariableValue(name, variables) {
        const trimmed = String(name || '').trim();
        if (!trimmed) {
            return undefined;
        }

        if (Object.prototype.hasOwnProperty.call(variables, trimmed)) {
            return variables[trimmed];
        }

        // Also support env-style names (e.g. BUILD_ARTIFACTSTAGINGDIRECTORY)
        // for task inputs that use ${...} syntax.
        if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) {
            for (const [key, value] of Object.entries(variables || {})) {
                const envKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                if (envKey === trimmed) {
                    return value;
                }
            }
        }

        return undefined;
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
                // Convert unresolved ADO macros that look like $(Agent.TempDirectory) into
                // bash variable references ${AGENT_TEMPDIRECTORY}. Without this, bash would
                // try to run Agent.TempDirectory as a command ("command not found"). With it,
                // variables exported earlier in the same script via ##vso[task.setvariable]
                // are accessible to subsequent lines.
                scriptContent = scriptContent.replace(/\$\(([A-Za-z_][A-Za-z0-9_.]*)\)/g, (match, varName) => {
                    const trimmed = varName.trim();
                    if (Object.prototype.hasOwnProperty.call(variables, trimmed)) {
                        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
                            const shellName = trimmed.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                            return '${' + shellName + '}';
                        }
                        return match;
                    }
                    if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) {
                        return '${' + trimmed + '}';
                    }
                    return match;
                });

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
                    if (/signatures\.json/i.test(script) && workingDirectory) {
                        const signatureCandidates = new Set([
                            path.join(resolvedCwd, 'signatures.json'),
                            path.join(resolvedCwd, 'signature-validation', 'signatures.json'),
                            path.join(
                                String(variables['Build.SourcesDirectory'] || resolvedCwd),
                                'signature-validation',
                                'signatures.json'
                            ),
                        ]);
                        for (const signaturesPath of signatureCandidates) {
                            fs.mkdirSync(path.dirname(signaturesPath), { recursive: true });
                            if (!fs.existsSync(signaturesPath)) {
                                fs.writeFileSync(signaturesPath, '[]\n', 'utf8');
                            }
                        }
                    }
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
    if [[ "$prev" == "-o" || "$prev" == "--output" ]]; then
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
src=""
dest="."
prev=""
for arg in "$@"; do
    if [[ -z "$src" && "$arg" != -* ]]; then
        src="$arg"
        continue
    fi
    if [[ "$prev" == "-d" ]]; then
        dest="$arg"
        break
    fi
    prev="$arg"
done
mkdir -p "$dest/build-wrapper-win-x86"
touch "$dest/build-wrapper-win-x86/build-wrapper-win-x86-64.exe"
if [[ "$src" == *pipeline-scan*.zip ]]; then
    mkdir -p "$dest"
    : > "$dest/pipeline-scan.jar"
fi
if [[ "$src" == *.zip || "$src" == *.nupkg ]]; then
    base_name="$(basename "$src")"
    package_name="\${base_name%.*}"
    mkdir -p "$dest/simulated-package"
    : > "$dest/\${package_name}.msix"
fi
exit 0
`;
            } else if (tool.name === 'zip') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for zip used by simulator offline mode
echo ${JSON.stringify('[mock-tool] zip $*')} >&2
archive=""
for arg in "$@"; do
    if [[ "$arg" == -* ]]; then
        continue
    fi
    archive="$arg"
    break
done
if [[ -n "$archive" ]]; then
    mkdir -p "$(dirname "$archive")"
    : > "$archive"
fi
exit 0
`;
            } else if (tool.name === '7z') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for 7z used by simulator offline mode
echo ${JSON.stringify('[mock-tool] 7z $*')} >&2
archive=""
seen_command="false"
for arg in "$@"; do
    if [[ "$seen_command" == "false" ]]; then
        if [[ "$arg" == -* ]]; then
            continue
        fi
        seen_command="true"
        continue
    fi
    if [[ "$arg" == -* ]]; then
        continue
    fi
    archive="$arg"
    break
done
if [[ -n "$archive" ]]; then
    mkdir -p "$(dirname "$archive")"
    : > "$archive"
fi
exit 0
`;
            } else if (tool.name === 'java') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for java used by simulator offline mode
echo ${JSON.stringify('[mock-tool] java $*')} >&2
if [[ "$1" == "-version" || "$1" == "--version" ]]; then
    echo 'openjdk version "17.0.0"'
    exit 0
fi
if [[ "$1" == "-jar" ]]; then
    exit 0
fi
exit 0
`;
            } else if (tool.name === 'keytool') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for keytool during simulation
echo ${JSON.stringify('[mock-tool] keytool $*')} >&2
echo 'Certificate was added to keystore'
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
            } else if (tool.name === 'cygpath') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for cygpath used by simulator on non-Windows hosts
echo ${JSON.stringify('[mock-tool] cygpath $*')} >&2
mode=""
target=""
for arg in "$@"; do
    case "$arg" in
        -u|-w|-m)
            mode="$arg"
            ;;
        -*)
            ;;
        *)
            target="$arg"
            ;;
    esac
done
if [[ -z "$target" ]]; then
    exit 0
fi
if [[ "$mode" == "-u" || -z "$mode" ]]; then
    if [[ "$target" =~ ^([A-Za-z]):[\\/](.*)$ ]]; then
        drive="\${BASH_REMATCH[1],,}"
        rest="$(printf '%s' "\${BASH_REMATCH[2]}" | sed 's#\\\\#/#g')"
        printf '/%s/%s\n' "$drive" "$rest"
    else
        printf '%s\n' "$(printf '%s' "$target" | sed 's#\\\\#/#g')"
    fi
    exit 0
fi
if [[ "$mode" == "-w" || "$mode" == "-m" ]]; then
    printf '%s\n' "$target"
    exit 0
fi
printf '%s\n' "$target"
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
        const isPipelineArtifactTask = taskName === 'PublishPipelineArtifact';
        const isBuildArtifactTask = taskName === 'PublishBuildArtifacts';
        const isDownloadPipelineArtifactTask = taskName === 'DownloadPipelineArtifact';
        const isDownloadBuildArtifactTask = taskName === 'DownloadBuildArtifacts' || taskName === 'DownloadArtifacts';

        if (isBuildArtifactTask || isPipelineArtifactTask) {
            const artifactType = isPipelineArtifactTask ? 'pipeline' : 'build';
            const artifactsRoot = isPipelineArtifactTask
                ? this._getPipelineArtifactsRoot(variables, workDir)
                : this._getBuildArtifactsRoot(variables, workDir);
            const rawPublishPath =
                inputs.PathtoPublish || inputs.pathToPublish || inputs.targetPath || inputs.PathToPublish || '';
            const rawArtifactName = inputs.ArtifactName || inputs.artifactName || inputs.artifact || '';
            const resolvedArtifactName = rawArtifactName
                ? this._substituteTaskInputVariables(String(rawArtifactName), variables)
                : path.basename(this._resolvePath(rawPublishPath || 'artifact', variables, workDir));
            const artifactName = this._normalizeArtifactName(
                resolvedArtifactName ||
                    path.basename(this._resolvePath(rawPublishPath || 'artifact', variables, workDir))
            );
            if (!rawPublishPath) {
                return `[sim] publish skipped for ${artifactName}: no publish path was configured`;
            }

            const publishPath = this._resolvePath(rawPublishPath, variables, workDir);
            this._ensurePublishSourceExists(publishPath, artifactName, variables);

            const snapshotRoot = path.join(artifactsRoot, this._sanitizePathSegment(artifactName));
            const snapshotOptions = {
                excludeTopLevelNames: this._getExcludedTopLevelNamesForPublish(publishPath, artifactName),
            };
            this._copyIntoSnapshot(publishPath, snapshotRoot, snapshotOptions);

            const manifest = {
                artifactName,
                artifactType,
                taskName,
                sourcePath: publishPath,
                snapshotPath: snapshotRoot,
                createdAt: new Date().toISOString(),
            };
            fs.writeFileSync(
                path.join(snapshotRoot, 'artifact-manifest.json'),
                JSON.stringify(manifest, null, 2),
                'utf8'
            );
            this._publishedArtifacts.push(manifest);
            if (isPipelineArtifactTask) {
                this._writePipelineArtifactsIndex(artifactsRoot);
            } else {
                this._writeBuildArtifactsIndex(artifactsRoot);
            }
            return `[sim] ${artifactType}-artifact: ${artifactName} -> ${snapshotRoot}`;
        }

        if (taskName === 'NuGetCommand') {
            const command = this._substituteTaskInputVariables(String(inputs.command || 'restore'), variables)
                .trim()
                .toLowerCase();
            if (command === 'push') {
                return this._simulateNuGetPush(inputs, variables, workDir);
            }
            if (command === 'pack') {
                return this._simulateNuGetPack(inputs, variables, workDir);
            }
            return;
        }

        if (taskName === 'UniversalPackages') {
            const command = this._substituteTaskInputVariables(String(inputs.command || 'download'), variables)
                .trim()
                .toLowerCase();
            if (command === 'publish') {
                return this._simulateUniversalPackagePublish(inputs, variables, workDir);
            }
            return;
        }

        if (isDownloadPipelineArtifactTask || isDownloadBuildArtifactTask) {
            const expectedArtifactType = isDownloadPipelineArtifactTask ? 'pipeline' : 'build';
            const rawTarget = inputs.targetPath || inputs.path || inputs.downloadPath || inputs.downloadDirectory || '';
            if (!rawTarget) return;
            const targetPath = this._resolvePath(rawTarget, variables, workDir);
            const requestedArtifactName =
                inputs.artifact || inputs.artifactName || inputs.downloadedArtifactName
                    ? this._substituteTaskInputVariables(
                          String(inputs.artifact || inputs.artifactName || inputs.downloadedArtifactName),
                          variables
                      )
                    : '';
            try {
                fs.mkdirSync(targetPath, { recursive: true });
                const publishedArtifact = requestedArtifactName
                    ? this._resolvePublishedArtifact(requestedArtifactName, expectedArtifactType)
                    : null;

                if (publishedArtifact && fs.existsSync(publishedArtifact.snapshotPath)) {
                    const normalizedArtifactName = this._normalizeArtifactName(requestedArtifactName);
                    const normalizedTargetPath = path.normalize(targetPath);
                    const normalizedTargetFolderName = this._normalizeArtifactName(path.basename(normalizedTargetPath));

                    if (normalizedArtifactName && normalizedArtifactName === normalizedTargetFolderName) {
                        const parentPath = path.dirname(normalizedTargetPath);
                        this._copyDirectoryContents(publishedArtifact.snapshotPath, parentPath, {
                            excludeManifest: true,
                        });
                        return `[sim] ${expectedArtifactType}-artifact download: ${publishedArtifact.artifactName} -> ${parentPath}`;
                    } else {
                        this._recordDownloadTarget(normalizedTargetPath);
                        this._copySnapshotForDownload(
                            publishedArtifact.snapshotPath,
                            targetPath,
                            normalizedTargetFolderName
                        );
                        return `[sim] ${expectedArtifactType}-artifact download: ${publishedArtifact.artifactName} -> ${targetPath}`;
                    }
                }

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
                return `[sim] downloaded sample artifacts -> ${targetPath}`;
            } catch (_) {}
        }
    }

    _getPipelineArtifactsRoot(variables, workDir) {
        const simulationRoot = this._getSimulationRoot(variables, workDir);
        return path.join(simulationRoot, 'pipeline-artifacts');
    }

    _getBuildArtifactsRoot(variables, workDir) {
        const simulationRoot = this._getSimulationRoot(variables, workDir);
        return path.join(simulationRoot, 'build-artifacts');
    }

    _getFeedPublishRoot(variables, workDir) {
        const simulationRoot = this._getSimulationRoot(variables, workDir);
        return path.join(simulationRoot, 'feed-publishes');
    }

    _getSimulationRoot(variables, workDir) {
        const configuredRoot = this.outputRoot || variables['Simulator.OutputRoot'];
        if (configuredRoot) {
            const resolved = path.resolve(String(configuredRoot));
            fs.mkdirSync(resolved, { recursive: true });
            return resolved;
        }
        const workspaceRoot = variables['Pipeline.Workspace'] || workDir || process.cwd();
        return path.resolve(workspaceRoot);
    }

    _resolvePath(rawPath, variables, workDir) {
        const substituted = this._substituteTaskInputVariables(String(rawPath), variables).replace(/\\/g, '/');
        if (path.isAbsolute(substituted)) {
            return path.resolve(substituted);
        }
        return path.resolve(workDir || process.cwd(), substituted);
    }

    _recordDownloadTarget(targetPath) {
        const resolvedTargetPath = path.resolve(targetPath);
        const parentPath = path.dirname(resolvedTargetPath);
        const targetName = path.basename(resolvedTargetPath);
        if (!targetName || parentPath === resolvedTargetPath) {
            return;
        }

        if (!this._downloadedArtifactTargets.has(parentPath)) {
            this._downloadedArtifactTargets.set(parentPath, new Set());
        }
        this._downloadedArtifactTargets.get(parentPath).add(targetName);
    }

    _getExcludedTopLevelNamesForPublish(sourcePath, artifactName) {
        const excludedNames = new Set(['.azure-pipeline-studio']);
        const downloadTargetNames = this._downloadedArtifactTargets.get(path.resolve(sourcePath));
        if (!downloadTargetNames) {
            return [...excludedNames];
        }

        const normalizedArtifactName = this._normalizeArtifactName(artifactName);
        for (const targetName of downloadTargetNames) {
            if (this._normalizeArtifactName(targetName) === normalizedArtifactName) {
                continue;
            }
            excludedNames.add(targetName);
        }

        return [...excludedNames];
    }

    _sanitizePathSegment(name) {
        return String(name || 'artifact').replace(/[<>:"/\\|?*]+/g, '-');
    }

    _normalizeArtifactName(name) {
        const normalized = String(name || 'artifact').replace(/\$\(([^)]+)\)/g, (_, variableName) => {
            const cleaned = String(variableName || '')
                .trim()
                .replace(/[^A-Za-z0-9._-]+/g, '-');
            return cleaned || 'artifact';
        });
        return normalized || 'artifact';
    }

    /**
     * Extract the NuGet feed identifier from the Release stage's NuGet push task.
     * This is used as the fallback feed identifier if the Release stage doesn't run.
     */
    _extractReleaseStageNugetFeed(stages) {
        if (!Array.isArray(stages)) return null;

        for (const stageDoc of stages) {
            const stageName = String(stageDoc.stage || stageDoc.displayName || '');
            if (stageName.toLowerCase() !== 'release') continue;

            const jobs = Array.isArray(stageDoc.jobs) ? stageDoc.jobs : [];
            for (const jobDoc of jobs) {
                const steps = Array.isArray(jobDoc.steps) ? jobDoc.steps : [];
                for (const stepDoc of steps) {
                    // Look for NuGetCommand@2 with command: push
                    if (stepDoc.task === 'NuGetCommand@2' && stepDoc.inputs) {
                        const command = String(stepDoc.inputs.command || '').toLowerCase();
                        if (command === 'push') {
                            // Extract feed identifier from inputs
                            const feedId = String(
                                stepDoc.inputs.publishVstsFeed ||
                                    stepDoc.inputs.publishFeedCredentials ||
                                    stepDoc.inputs.externalEndpoints ||
                                    ''
                            ).trim();
                            if (feedId) return feedId;
                        }
                    }
                }
            }
        }
        return null;
    }

    _ensurePublishSourceExists(publishPath, artifactName, variables = {}) {
        const shouldMaterializeDummyPackages = /packages?/i.test(String(artifactName || ''));

        if (fs.existsSync(publishPath)) {
            if (fs.statSync(publishPath).isDirectory()) {
                const entries = fs.readdirSync(publishPath);
                const hasNugetPackages = entries.some((entry) => /\.(snupkg|nupkg)$/i.test(entry));
                if (shouldMaterializeDummyPackages && !hasNugetPackages) {
                    this._materializeDummyNugetPackages(publishPath, variables);
                    return;
                }
                if (entries.length === 0) {
                    fs.writeFileSync(
                        path.join(publishPath, 'artifact-placeholder.txt'),
                        `Simulated artifact placeholder for ${artifactName}\n`,
                        'utf8'
                    );
                }
            }
            return;
        }

        const looksLikeFile = path.extname(publishPath) !== '';
        if (looksLikeFile) {
            fs.mkdirSync(path.dirname(publishPath), { recursive: true });
            fs.writeFileSync(publishPath, `Simulated publish output for ${artifactName}\n`, 'utf8');
            return;
        }

        fs.mkdirSync(publishPath, { recursive: true });
        if (shouldMaterializeDummyPackages) {
            this._materializeDummyNugetPackages(publishPath, variables);
            return;
        }
        fs.writeFileSync(
            path.join(publishPath, 'artifact-placeholder.txt'),
            `Simulated artifact placeholder for ${artifactName}\n`,
            'utf8'
        );
    }

    _materializeDummyNugetPackages(targetDir, variables = {}) {
        fs.mkdirSync(targetDir, { recursive: true });
        const rawVersion = String(variables.version || variables.VERSION || variables['Build.BuildNumber'] || '0.0.0');
        const defaultVersion = rawVersion.replace(/[^A-Za-z0-9._-]/g, '-') || '0.0.0';
        const packageDefinitions = ['hp.win.sdk.voice', 'hp.win.svc.voice'];
        const includedFiles = [
            'VoiceSdk/bin/mock.dll',
            'VoiceSdk/bin/mock.pdb',
            'VoiceService/bin/x64/Release/mock.dll',
            'VoiceService/bin/ARM64/Release/mock.dll',
            'VoiceService/bin/mock.json',
            'VoiceService/VoiceService.cfg',
        ];

        for (const packageId of packageDefinitions) {
            const baseName = `${packageId}.${defaultVersion}`;
            const packageMetadata = {
                packageId,
                version: defaultVersion,
                files: includedFiles,
                generatedBy: 'azure-pipeline-studio-simulator',
            };
            fs.writeFileSync(
                path.join(targetDir, `${baseName}.nupkg`),
                `${JSON.stringify(packageMetadata, null, 2)}\n`,
                'utf8'
            );
            fs.writeFileSync(
                path.join(targetDir, `${baseName}.snupkg`),
                `${JSON.stringify({ ...packageMetadata, symbolPackage: true }, null, 2)}\n`,
                'utf8'
            );
        }

        fs.writeFileSync(
            path.join(targetDir, 'package-contents.json'),
            `${JSON.stringify({ files: includedFiles }, null, 2)}\n`,
            'utf8'
        );
    }

    _ensureFallbackPackageArtifacts(variables, workDir) {
        const artifactStagingDir = this._resolvePath(
            String(variables['Build.ArtifactStagingDirectory'] || 'artifacts'),
            variables,
            workDir
        );
        const packagesDir = path.join(artifactStagingDir, 'Packages');
        const hasPackages =
            fs.existsSync(packagesDir) && fs.readdirSync(packagesDir).some((name) => /\.(snupkg|nupkg)$/i.test(name));
        if (!hasPackages) {
            this._materializeDummyNugetPackages(packagesDir, variables);
        }

        // Keep pipeline-artifacts/Packages aligned with staged package outputs
        // so downstream inspection matches expected published artifact layout.
        const pipelineArtifactsRoot = this._getPipelineArtifactsRoot(variables, workDir);
        const snapshotRoot = path.join(pipelineArtifactsRoot, 'Packages');
        this._copyIntoSnapshot(packagesDir, snapshotRoot);

        const manifest = {
            artifactName: 'Packages',
            taskName: 'FallbackPackageArtifacts',
            sourcePath: packagesDir,
            snapshotPath: snapshotRoot,
            createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(snapshotRoot, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

        const existingIndex = this._publishedArtifacts.findIndex((entry) => entry.artifactName === 'Packages');
        if (existingIndex >= 0) {
            this._publishedArtifacts[existingIndex] = manifest;
        } else {
            this._publishedArtifacts.push(manifest);
        }
        // Auto-publish packages to feed-publishes if not already published by Release stage
        // This ensures packages are available for publishing even if Release stage didn't run
        if (this._feedPublishes.length === 0 && hasPackages) {
            const packageFiles = fs
                .readdirSync(packagesDir)
                .filter((name) => /\.(snupkg|nupkg)$/i.test(name))
                .map((name) => path.join(packagesDir, name));

            if (packageFiles.length > 0) {
                const feedIdentifier = this._releaseStageNugetFeed || 'default-feed';
                const feedRoot = path.join(this._getFeedPublishRoot(variables, workDir), 'nuget', feedIdentifier);
                fs.mkdirSync(feedRoot, { recursive: true });

                const published = [];
                for (const pkgFile of packageFiles) {
                    const dest = path.join(feedRoot, path.basename(pkgFile));
                    fs.copyFileSync(pkgFile, dest);
                    published.push(path.basename(pkgFile));
                }

                this._feedPublishes.push({
                    type: 'nuget',
                    feedType: 'internal',
                    feedIdentifier: feedIdentifier,
                    packages: published,
                    feedPath: feedRoot,
                    source: 'FallbackPackagePublish',
                    createdAt: new Date().toISOString(),
                });
            }
        }
    }

    _copyIntoSnapshot(sourcePath, snapshotRoot, options = {}) {
        fs.rmSync(snapshotRoot, { recursive: true, force: true });
        fs.mkdirSync(snapshotRoot, { recursive: true });

        const stat = fs.statSync(sourcePath);
        if (stat.isDirectory()) {
            this._copyDirectoryContents(sourcePath, snapshotRoot, options);
            return;
        }

        fs.copyFileSync(sourcePath, path.join(snapshotRoot, path.basename(sourcePath)));
    }

    _copySnapshotForDownload(snapshotRoot, targetPath, normalizedTargetFolderName) {
        fs.mkdirSync(targetPath, { recursive: true });
        const entries = fs.readdirSync(snapshotRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'artifact-manifest.json') {
                continue;
            }

            const sourcePath = path.join(snapshotRoot, entry.name);
            const matchesTargetName =
                normalizedTargetFolderName && this._normalizeArtifactName(entry.name) === normalizedTargetFolderName;

            if (entry.isDirectory() && matchesTargetName) {
                // Flatten matching root folder into target to avoid All/All nesting.
                this._copyDirectoryContents(sourcePath, targetPath, { excludeManifest: true });
                continue;
            }

            const destinationPath = path.join(targetPath, entry.name);
            if (entry.isDirectory()) {
                this._copyDirectoryContents(sourcePath, destinationPath, { excludeManifest: true });
            } else {
                fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                fs.copyFileSync(sourcePath, destinationPath);
            }
        }
    }

    _copyDirectoryContents(sourceDir, destinationDir, options = {}, depth = 0) {
        const resolvedDestinationDir = path.resolve(destinationDir);
        const excludedTopLevelNames = new Set(options.excludeTopLevelNames || []);
        fs.mkdirSync(destinationDir, { recursive: true });
        for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
            if (options.excludeManifest && entry.name === 'artifact-manifest.json') {
                continue;
            }
            if (depth === 0 && excludedTopLevelNames.has(entry.name)) {
                continue;
            }

            const sourcePath = path.join(sourceDir, entry.name);
            const destinationPath = path.join(destinationDir, entry.name);
            const resolvedSourcePath = path.resolve(sourcePath);
            if (
                resolvedSourcePath === resolvedDestinationDir ||
                resolvedDestinationDir.startsWith(`${resolvedSourcePath}${path.sep}`)
            ) {
                continue;
            }
            if (entry.isDirectory()) {
                this._copyDirectoryContents(sourcePath, destinationPath, options, depth + 1);
            } else {
                fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                fs.copyFileSync(sourcePath, destinationPath);
            }
        }
    }

    _writePipelineArtifactsIndex(pipelineArtifactsRoot) {
        fs.mkdirSync(pipelineArtifactsRoot, { recursive: true });
        fs.writeFileSync(
            path.join(pipelineArtifactsRoot, 'published-artifacts.json'),
            JSON.stringify(this._publishedArtifacts, null, 2),
            'utf8'
        );
    }

    _writeBuildArtifactsIndex(buildArtifactsRoot) {
        fs.mkdirSync(buildArtifactsRoot, { recursive: true });
        fs.writeFileSync(
            path.join(buildArtifactsRoot, 'published-artifacts.json'),
            JSON.stringify(this._publishedArtifacts, null, 2),
            'utf8'
        );
    }

    _resolvePublishedArtifact(artifactName, expectedArtifactType) {
        const normalizedExpectedName = this._normalizeArtifactName(artifactName);
        const artifacts = [...this._publishedArtifacts].reverse();
        const strictMatch = artifacts.find(
            (entry) =>
                this._normalizeArtifactName(entry.artifactName) === normalizedExpectedName &&
                entry.artifactType === expectedArtifactType
        );
        if (strictMatch) {
            return strictMatch;
        }

        return (
            artifacts.find((entry) => this._normalizeArtifactName(entry.artifactName) === normalizedExpectedName) ||
            null
        );
    }

    _writeFeedPublishesIndex(feedPublishRoot) {
        fs.mkdirSync(feedPublishRoot, { recursive: true });
        fs.writeFileSync(
            path.join(feedPublishRoot, 'feed-publishes.json'),
            JSON.stringify(this._feedPublishes, null, 2),
            'utf8'
        );
    }

    _simulateTemplateNuGetPushStep(displayName, variables, workDir) {
        const match = /^Publish NuGet Packages\((.+)\)$/.exec(String(displayName || '').trim());
        if (!match) {
            return null;
        }

        const feedIdentifier = match[1].trim() || 'local-nuget-feed';
        const resolvedWorkDir = workDir ? path.resolve(workDir) : process.cwd();
        fs.mkdirSync(resolvedWorkDir, { recursive: true });

        let packageFiles = this._collectPackageFiles(['*.nupkg', '*.snupkg'], resolvedWorkDir, ['.nupkg', '.snupkg']);
        if (packageFiles.length === 0) {
            const buildNumber = String(variables['Build.BuildNumber'] || '0.0.0');
            const fallbackPackageName = `dummy.${buildNumber}.nupkg`;
            const fallbackPackagePath = path.join(resolvedWorkDir, fallbackPackageName);
            fs.writeFileSync(fallbackPackagePath, '[sim] dummy package generated for NuGet publish step\n', 'utf8');
            packageFiles = [fallbackPackagePath];
        }

        const feedRoot = path.join(
            this._getFeedPublishRoot(variables, resolvedWorkDir),
            'nuget',
            this._sanitizePathSegment(feedIdentifier)
        );
        fs.mkdirSync(feedRoot, { recursive: true });

        const published = [];
        for (const pkgFile of packageFiles) {
            const destinationPath = path.join(feedRoot, path.basename(pkgFile));
            if (fs.existsSync(pkgFile)) {
                fs.copyFileSync(pkgFile, destinationPath);
            } else {
                fs.writeFileSync(destinationPath, `[sim] stub NuGet package: ${path.basename(pkgFile)}\n`, 'utf8');
            }
            published.push(path.basename(pkgFile));
        }

        const feedEndpoint = `https://pkgs.dev.azure.com/local/${feedIdentifier}/nuget/v3/index.json`;
        this._feedPublishes.push({
            type: 'nuget',
            feedType: 'internal',
            feedIdentifier,
            packages: published,
            feedPath: feedRoot,
            source: 'template-bash-publish',
            createdAt: new Date().toISOString(),
        });
        this._writeFeedPublishesIndex(this._getFeedPublishRoot(variables, resolvedWorkDir));

        return {
            stdout: [
                `Created NuGet.config for ${feedEndpoint}`,
                '[var] NUGET_PUSH_LOG_CHANNEL=notifications',
                `[sim] nuget-push: ${published.length} package(s) -> ${feedRoot}`,
            ].join('\n'),
            variables: {
                NUGET_PUSH_LOG_CHANNEL: 'notifications',
            },
        };
    }

    _simulateTemplateNuGetPackStep(displayName, scriptContent, variables, workDir) {
        if (String(displayName || '').trim() !== 'Create Nuget Packages') {
            return null;
        }

        const resolvedWorkDir = workDir ? path.resolve(workDir) : process.cwd();
        const packageDirMatch = /pkg_dir="([^"]+)"/.exec(scriptContent);
        const packageDirRaw = packageDirMatch ? packageDirMatch[1] : 'Packages';
        const packageDir = this._resolvePath(packageDirRaw, variables, resolvedWorkDir);
        fs.mkdirSync(packageDir, { recursive: true });

        const nuspecListMatch = /nuspec_files=\(([^)]*)\)/.exec(scriptContent);
        const nuspecFiles = nuspecListMatch
            ? nuspecListMatch[1]
                  .split(/\s+/)
                  .map((entry) => entry.trim())
                  .filter(Boolean)
            : ['package.nuspec'];

        const versionMatch = /version="([^"]+)"/.exec(scriptContent);
        const resolvedVersion =
            (versionMatch && versionMatch[1]) ||
            String(variables.version || variables.VERSION || variables['Build.BuildNumber'] || '0.0.0');
        const enableSymbols = /enable_symbols="true"/i.test(scriptContent);

        const packageContentRoots = [path.join(resolvedWorkDir, 'All'), resolvedWorkDir];
        const packageContentFiles = [];
        for (const root of packageContentRoots) {
            if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
                continue;
            }
            for (const filePath of this._collectPackageFiles(['**/*'], root, ['.dll', '.pdb', '.json', '.cfg'])) {
                packageContentFiles.push(path.relative(root, filePath).replace(/\\/g, '/'));
            }
            if (packageContentFiles.length > 0) {
                break;
            }
        }

        const createdPackages = [];
        for (const nuspecFile of nuspecFiles) {
            const packageId = path.basename(nuspecFile, path.extname(nuspecFile)) || 'package';
            const nupkgName = `${packageId}.${resolvedVersion}.nupkg`;
            const nupkgPath = path.join(packageDir, nupkgName);
            const packageManifest = {
                packageId,
                version: resolvedVersion,
                nuspec: nuspecFile,
                files: packageContentFiles.length > 0 ? packageContentFiles : ['artifact-placeholder.txt'],
                generatedBy: 'azure-pipeline-studio-simulator',
            };
            fs.writeFileSync(nupkgPath, `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8');
            createdPackages.push(nupkgName);

            if (enableSymbols) {
                const snupkgName = `${packageId}.${resolvedVersion}.snupkg`;
                const snupkgPath = path.join(packageDir, snupkgName);
                fs.writeFileSync(
                    snupkgPath,
                    `${JSON.stringify({ ...packageManifest, symbolPackage: true }, null, 2)}\n`,
                    'utf8'
                );
                createdPackages.push(snupkgName);
            }
        }

        return {
            stdout: [
                `[sim] nuget-pack(template): ${createdPackages.length} package file(s) -> ${packageDir}`,
                ...createdPackages.map((name) => `[sim] created ${name}`),
            ].join('\n'),
            variables: {
                NUGET_PACK_ERROR: 'false',
            },
        };
    }

    /**
     * Simulate NuGetCommand@2 command:push
     * Finds .nupkg/.snupkg files matching packagesToPush, copies them to
     * feed-publishes/nuget/<feedIdentifier>/ and records metadata.
     */
    _simulateNuGetPush(inputs, variables, workDir) {
        const rawPatterns = this._substituteTaskInputVariables(
            String(inputs.packagesToPush || inputs.searchPatternPush || '*.nupkg'),
            variables
        );
        const feedType = this._substituteTaskInputVariables(
            String(inputs.nuGetFeedType || inputs.nugetFeedType || 'internal'),
            variables
        )
            .trim()
            .toLowerCase();
        const feedIdentifier =
            this._substituteTaskInputVariables(
                String(
                    inputs.publishVstsFeed ||
                        inputs.publishFeedCredentials ||
                        inputs.externalEndpoints ||
                        'local-nuget-feed'
                ),
                variables
            ).trim() || 'local-nuget-feed';

        const feedRoot = path.join(
            this._getFeedPublishRoot(variables, workDir),
            'nuget',
            this._sanitizePathSegment(feedIdentifier)
        );
        fs.mkdirSync(feedRoot, { recursive: true });

        // Collect candidate .nupkg/.snupkg files from the resolved working directory.
        const resolvedWorkDir = workDir ? path.resolve(workDir) : process.cwd();
        const patterns = rawPatterns
            .split(';')
            .map((p) => p.trim())
            .filter(Boolean);
        const packageFiles = this._collectPackageFiles(patterns, resolvedWorkDir, ['.nupkg', '.snupkg']);

        // If no real packages were found, write stubs so the feed folder is not empty.
        const filesToPublish =
            packageFiles.length > 0 ? packageFiles : this._generateStubPackages(inputs, variables, resolvedWorkDir);

        const published = [];
        for (const pkgFile of filesToPublish) {
            const dest = path.join(feedRoot, path.basename(pkgFile));
            if (fs.existsSync(pkgFile)) {
                fs.copyFileSync(pkgFile, dest);
            } else {
                fs.writeFileSync(dest, `[sim] stub NuGet package: ${path.basename(pkgFile)}\n`, 'utf8');
            }
            published.push(path.basename(pkgFile));
        }

        const entry = {
            type: 'nuget',
            feedType,
            feedIdentifier,
            packages: published,
            feedPath: feedRoot,
            createdAt: new Date().toISOString(),
        };
        this._feedPublishes.push(entry);
        this._writeFeedPublishesIndex(this._getFeedPublishRoot(variables, workDir));
        return `[sim] nuget-push: ${published.length} package(s) -> ${feedRoot}`;
    }

    /**
     * Simulate NuGetCommand@2 command:pack
     * Creates a stub .nupkg in the expected output location so downstream
     * push steps have something to find.
     */
    _simulateNuGetPack(inputs, variables, workDir) {
        const rawOutputDir =
            inputs.outputDir ||
            inputs.packDirectory ||
            this._substituteTaskInputVariables('$(Build.ArtifactStagingDirectory)', variables);
        const outputDir = this._resolvePath(rawOutputDir, variables, workDir);
        fs.mkdirSync(outputDir, { recursive: true });

        // Derive a stub package name from nuspec file or project reference.
        const nuspecOrProject = this._substituteTaskInputVariables(
            String(
                inputs.nuspecRunTime ||
                    inputs.configuration ||
                    inputs.packagesToPack ||
                    inputs.searchPatternPack ||
                    '*.nuspec'
            ),
            variables
        ).trim();
        const baseName = path.basename(nuspecOrProject, path.extname(nuspecOrProject)) || 'package';
        const version = this._substituteTaskInputVariables(
            String(
                inputs.versioningScheme === 'byEnvVar'
                    ? `$(${inputs.versionEnvVar || 'VERSION'})`
                    : inputs.majorMinorPatch || '0.0.0'
            ),
            variables
        );
        const stubFile = path.join(outputDir, `${baseName}.${version}.nupkg`);
        if (!fs.existsSync(stubFile)) {
            fs.writeFileSync(stubFile, `[sim] stub NuGet package: ${baseName} ${version}\n`, 'utf8');
        }
        return `[sim] nuget-pack: ${baseName}.${version}.nupkg -> ${outputDir}`;
    }

    /**
     * Simulate UniversalPackages@0 command:publish
     * Stages the publishDirectory content into
     * feed-publishes/universal/<feedName>/<packageName>/<version>/
     */
    _simulateUniversalPackagePublish(inputs, variables, workDir) {
        const rawPublishDir =
            inputs.publishDirectory ||
            inputs.artifactDirectory ||
            this._substituteTaskInputVariables('$(Build.ArtifactStagingDirectory)', variables);
        const publishDir = this._resolvePath(rawPublishDir, variables, workDir);

        const feedName = this._normalizeArtifactName(
            this._substituteTaskInputVariables(
                String(inputs.feedPublishExternal || inputs.feedPublishInternal || 'local-feed'),
                variables
            )
        );
        const packageName = this._normalizeArtifactName(
            this._substituteTaskInputVariables(
                String(inputs.packagePublishExternal || inputs.packagePublishInternal || 'package'),
                variables
            )
        );
        const version = this._substituteTaskInputVariables(
            String(inputs.versionPublish || variables['version'] || '0.0.0'),
            variables
        );
        const feedType = (inputs.internalOrExternalPublish || 'external').trim().toLowerCase();
        const feedIdentifier =
            this._substituteTaskInputVariables(
                String(inputs.externalEndpoints || inputs.vstsFeed || feedName),
                variables
            ).trim() || feedName;

        const destRoot = path.join(
            this._getFeedPublishRoot(variables, workDir),
            'universal',
            this._sanitizePathSegment(feedName),
            this._sanitizePathSegment(packageName),
            this._sanitizePathSegment(version)
        );

        this._ensurePublishSourceExists(publishDir, packageName, variables);
        this._copyIntoSnapshot(publishDir, destRoot);

        const entry = {
            type: 'universal',
            feedType,
            feedIdentifier,
            feedName,
            packageName,
            version,
            sourcePath: publishDir,
            feedPath: destRoot,
            createdAt: new Date().toISOString(),
        };
        this._feedPublishes.push(entry);
        this._writeFeedPublishesIndex(this._getFeedPublishRoot(variables, workDir));
        return `[sim] universal-publish: ${packageName}@${version} -> ${destRoot}`;
    }

    /**
     * Resolve files matching include/exclude glob-like patterns.
     * Handles patterns like /abs/dir/*.nupkg or relative/dir/**\/*.nupkg.
     * Returns absolute paths of matching files.
     */
    _collectPackageFiles(patterns, baseDir, allowedExtensions) {
        const includes = patterns.filter((p) => !p.startsWith('!'));
        const excludes = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

        const allFiles = [];

        const walkDir = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (_) {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walkDir(fullPath);
                } else if (allowedExtensions.some((ext) => entry.name.endsWith(ext))) {
                    allFiles.push(fullPath);
                }
            }
        };

        if (includes.length === 0) {
            walkDir(baseDir);
        } else {
            for (const pattern of includes) {
                const normalizedPattern = pattern.replace(/\\/g, '/');
                if (normalizedPattern.includes('*') || normalizedPattern.includes('?')) {
                    // Split at the first wildcard segment to get the concrete root directory.
                    const patternParts = normalizedPattern.split('/');
                    const firstWildcardIndex = patternParts.findIndex((seg) => seg.includes('*') || seg.includes('?'));
                    const concreteDir = patternParts.slice(0, firstWildcardIndex).join('/') || '.';
                    const resolvedDir = path.isAbsolute(concreteDir)
                        ? path.resolve(concreteDir)
                        : path.resolve(baseDir, concreteDir);
                    const isRecursive = normalizedPattern.includes('**');
                    const filePattern = patternParts[patternParts.length - 1];
                    const collectFromDir = (dir) => {
                        let entries;
                        try {
                            entries = fs.readdirSync(dir, { withFileTypes: true });
                        } catch (_) {
                            return;
                        }
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            if (entry.isDirectory()) {
                                if (isRecursive) collectFromDir(fullPath);
                            } else if (
                                allowedExtensions.some((ext) => entry.name.endsWith(ext)) &&
                                (filePattern === '*' ||
                                    filePattern.endsWith('*') ||
                                    entry.name.endsWith(filePattern.replace(/^\*/, '')))
                            ) {
                                allFiles.push(fullPath);
                            }
                        }
                    };
                    collectFromDir(resolvedDir);
                } else {
                    const resolved = path.isAbsolute(normalizedPattern)
                        ? path.resolve(normalizedPattern)
                        : path.resolve(baseDir, normalizedPattern);
                    if (fs.existsSync(resolved)) allFiles.push(resolved);
                }
            }
        }

        return allFiles.filter((f) => {
            const rel = path.relative(baseDir, f).replace(/\\/g, '/');
            return !excludes.some((ex) => {
                const exNorm = ex.replace(/\\/g, '/').replace(/^\.\//, '');
                return rel === exNorm || rel.endsWith('/' + path.basename(exNorm));
            });
        });
    }

    /**
     * Generate stub .nupkg filenames when no real packages were found,
     * using the nuspec file list from inputs or a generic fallback.
     */
    _generateStubPackages(inputs, variables, workDir) {
        const nuspecFiles = this._substituteTaskInputVariables(
            String(inputs.nuspecFiles || inputs.nuspecRunTime || ''),
            variables
        )
            .split(/[;,\n]/)
            .map((s) => s.trim())
            .filter(Boolean);

        const stubs = [];
        const version = this._substituteTaskInputVariables(
            String(variables['VERSION'] || variables['semanticVersion'] || '0.0.0'),
            variables
        );
        if (nuspecFiles.length > 0) {
            for (const nuspec of nuspecFiles) {
                const base = path.basename(nuspec, path.extname(nuspec));
                stubs.push(path.join(workDir, `${base}.${version}.nupkg`));
            }
        } else {
            stubs.push(path.join(workDir, `package.${version}.nupkg`));
        }
        return stubs;
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
