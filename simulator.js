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

// Pre-compiled regex for Azure Pipelines variable substitution syntax: $(VarName)
const RE_SUBSTITUTE_VARS = /\$\(([A-Za-z_][A-Za-z0-9_.-]*)\)/g;

// wsl.exe prints this diagnostic banner to its own stderr on some Windows hosts
// (localhost proxy detected but not mirrored into WSL NAT). It is not related
// to the simulated pipeline and must never surface in step output. The banner
// may end up concatenated onto the end of unrelated output (no guaranteed
// leading newline), so this pattern is intentionally not anchored to line start.
const RE_WSL_PROXY_WARNING =
    /\s*(?:wsl:\s*A localhost proxy configuration was detected[^\n]*|WSL in NAT mode does not support localhost proxies[^\n]*)\n?/gi;

const WINDOWS_WSL_EXE = 'C:\\Windows\\System32\\wsl.exe';

function stripWslProxyWarning(text) {
    // wsl.exe sometimes writes this banner to its stderr as UTF-16LE while the
    // rest of the stream is UTF-8; when captured with encoding:'utf8' each
    // character ends up interleaved with a stray NUL byte (e.g. "w\0s\0l\0:\0"),
    // which defeats the regex above. NUL bytes never legitimately appear in
    // step output, so stripping them first fixes the encoding mismatch.
    const str = String(text || '').replace(/\u0000/g, '');
    return str.replace(RE_WSL_PROXY_WARNING, '');
}

/**
 * Rewrite bash-specific constructs to POSIX sh / BusyBox ash equivalents:
 *
 * Arithmetic:
 *   if (( EXPR )); then  →  if [ "$(( EXPR ))" -ne 0 ]; then
 *   standalone (( EXPR ))  →  : $(( EXPR ))
 *
 * Arrays (bash arrays are not supported in BusyBox ash; replace with no-ops
 * so the script does not crash; array contents will be empty during simulation):
 *   arr=()               →  arr=''
 *   arr+=("$x")          →  : # aps: array append
 *   arr+=( ... )         →  : # aps: array append
 *   "${arr[@]}"          →  $arr  (best-effort approximation)
 *   "${!arr[@]}"         →  ''    (index expansion — dropped)
 *   "${#arr[@]}"         →  0
 *
 * Process substitution (not supported in BusyBox ash):
 *   done < <(cmd)        →  done < /dev/null  # cmd not executed; loop gets empty input
 */
function _rewriteArithmeticForPosixAsh(s) {
    // ── Arithmetic ──────────────────────────────────────────────────────────
    s = s.replace(
        /\b(if|elif|while|until)([ \t]+)\(\([ \t]*(.*?)[ \t]*\)\)([ \t]*;?[ \t]*)(then|do)\b/g,
        (m, kw, sp1, expr, sp2, td) => {
            const cmp = kw === 'until' ? '-eq' : '-ne';
            return `${kw}${sp1}[ "$(( ${expr.trim()} ))" ${cmp} 0 ]${sp2}${td}`;
        }
    );
    s = s.replace(
        /^([ \t]*)\(\([ \t]*(.*?)[ \t]*\)\)[ \t]*$/gm,
        (m, indent, expr) => `${indent}: $(( ${expr.trim()} ))`
    );

    // ── Arrays ───────────────────────────────────────────────────────────────
    // varname=()  →  varname=''
    s = s.replace(
        /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)=(\(\))[ \t]*$/gm,
        (m, indent, name) => `${indent}${name}='' # aps: array init`
    );

    // varname+=( ... )  →  : # aps: array append
    s = s.replace(
        /^([ \t]*)[A-Za-z_][A-Za-z0-9_]*\+=(\([^)]*\))[ \t]*$/gm,
        (m, indent) => `${indent}: # aps: array append`
    );

    // "${arr[@]}"  →  $arr  (approximation)
    s = s.replace(/"\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]}"/g, '"$$$1"');

    // "${!arr[@]}"  →  ''
    s = s.replace(/"\$\{![A-Za-z_][A-Za-z0-9_]*\[@\]}"/g, "''");

    // "${#arr[@]}"  →  0
    s = s.replace(/"\$\{#[A-Za-z_][A-Za-z0-9_]*\[@\]}"/g, '0');

    // ── Process substitution ─────────────────────────────────────────────────
    // done < <(cmd)  →  done < /dev/null  (loop body runs 0 times)
    s = s.replace(
        /\bdone([ \t]*)<([ \t]*)<\([^)]+\)/g,
        (m, sp1, sp2) => `done${sp1}< /dev/null # aps: process subst. skipped`
    );

    return s;
}

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
    'System.DefaultWorkingDirectory': process.cwd(),
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
        this.outputRoot = options.outputRoot || '';
        this.mockCatalog = options.mockCatalog || {};
        this.executablePaths = options.executablePaths || {};
        this.toolsDirectory = options.toolsDirectory || '';
        this.wslMountRoot = options.wslMountRoot || null;
        this.debugScript = options.debugScript || false;
        // e.g. "\\\\wsl.localhost\\Ubuntu-22.04" — Windows UNC prefix used to
        // convert Linux working directories to Windows-accessible paths for Git Bash.
        // Tools to shim when they are not present on the local machine.
        // Each entry: { name, exitCode, stdout }. exitCode defaults to 0.
        this.mockTools = options.mockTools || [
            { name: 'nuget' },
            { name: 'msbuild' },
            { name: 'MSBuild' },
            { name: 'vstest.console' },
            { name: 'signtool' },
            { name: 'curl' },
            { name: 'unzip' },
            { name: '7z' },
            { name: 'zip' },
            { name: 'aws' },
            { name: 'java', emitToStderr: false },
            { name: 'keytool' },
            { name: 'kinit' },
            { name: 'file' },
            { name: 'yq', stdout: 'mock-version' },
            { name: 'cygpath', stdout: '/mock-path' },
            { name: 'git', onlyIfMissing: true },
        ];
        this._shimDir = null;
        this._failedConfiguredShells = new Set();
        this._publishedArtifacts = [];
        this._feedPublishes = [];
        this._releaseStageNugetFeed = null;
        this._downloadedArtifactTargets = new Map();
        this._jobRunCounter = 0;
        this._resolvedToolsPaths = null;
        this._createdBuildFiles = new Set();
        this._currentRepositoryRoot = '';
        this._windowsGitBashCandidates = [];
        this._windowsShellDiscoveryDone = false;
        this._wslAvailable = false;
    }

    _buildWindowsGitBashCandidateList() {
        if (process.platform !== 'win32') return [];
        const configuredBashPath = this.executablePaths && this.executablePaths.bash;
        const candidates = [
            configuredBashPath && /[/\\]usr[/\\]bin[/\\]bash\.exe$/i.test(configuredBashPath)
                ? path.normalize(configuredBashPath)
                : null,
            process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe') : null,
            process.env['ProgramFiles(x86)']
                ? path.join(process.env['ProgramFiles(x86)'], 'Git', 'usr', 'bin', 'bash.exe')
                : null,
            process.env.LOCALAPPDATA
                ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'bash.exe')
                : null,
        ].filter(Boolean);
        return [...new Set(candidates)];
    }

    _initializeWindowsShellDiscovery() {
        if (this._windowsShellDiscoveryDone) return;
        this._windowsShellDiscoveryDone = true;

        if (process.platform !== 'win32') {
            this._windowsGitBashCandidates = [];
            this._wslAvailable = false;
            return;
        }

        const discovered = [];
        for (const candidate of this._buildWindowsGitBashCandidateList()) {
            try {
                if (!fs.existsSync(candidate)) continue;
                const probe = spawnSync(candidate, ['--version'], {
                    encoding: 'utf8',
                    timeout: 5000,
                });
                if (probe.error) continue;
                discovered.push(candidate);
            } catch (_) {
                // Ignore probe failures; we'll continue with remaining candidates.
            }
        }

        this._windowsGitBashCandidates = discovered;
        try {
            this._wslAvailable = fs.existsSync(WINDOWS_WSL_EXE);
        } catch (_) {
            this._wslAvailable = false;
        }
    }

    _getWindowsGitBashPathEntries(bashExePath = '') {
        if (process.platform !== 'win32') return [];
        const candidatePaths = [];
        if (bashExePath && /[/\\]usr[/\\]bin[/\\]bash\.exe$/i.test(String(bashExePath))) {
            candidatePaths.push(path.normalize(String(bashExePath)));
        }
        for (const candidate of this._windowsGitBashCandidates || []) {
            candidatePaths.push(path.normalize(String(candidate)));
        }

        const uniqueCandidates = [...new Set(candidatePaths.filter(Boolean))];
        const dirs = [];
        for (const bashPath of uniqueCandidates) {
            // Git for Windows layout: <git-root>/usr/bin/bash.exe
            const usrBinDir = path.dirname(bashPath);
            const gitRoot = path.resolve(usrBinDir, '..', '..');
            const gitBinDir = path.join(gitRoot, 'bin');
            dirs.push(this._toBashPath(usrBinDir));
            dirs.push(this._toBashPath(gitBinDir));
        }
        return [...new Set(dirs.filter(Boolean))];
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
        this._createdBuildFiles = new Set();
        this._currentRepositoryRoot = '';
        this._resolvedToolsPaths = null;
        this._windowsShellDiscoveryDone = false;
        this._initializeWindowsShellDiscovery();

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

        this._printSimulationContext(initialVariables, pipelineVars, options, resolvedWorkDir);

        this._ensureSimulationDirectories(initialVariables);
        this._resetSimulationWorkspace(initialVariables, resolvedWorkDir);

        // Extract Release stage NuGet feed identifier for use in fallback publishing
        this._releaseStageNugetFeed = this._extractReleaseStageNugetFeed(stages);

        // Build a case-insensitive set of stage names to run, if the caller restricted them.
        const stageFilter =
            Array.isArray(options.stages) && options.stages.length
                ? new Set(options.stages.map((s) => String(s).toLowerCase()))
                : null;

        const selectedStages = stageFilter
            ? stages.filter((stageDoc) => {
                  const stageName = stageDoc.stage || 'Stage';
                  return stageFilter.has(stageName.toLowerCase());
              })
            : stages;

        const stageOrdering = this._orderByDependencies(
            selectedStages,
            (stageDoc) => stageDoc.stage || 'Stage',
            (stageDoc) => stageDoc.dependsOn,
            'stage'
        );

        // stageDeps accumulates stageDependencies.* keys from completed stages
        // so that downstream stages can resolve $[ stageDependencies.S.J.outputs['...'] ].
        const stageDeps = {};
        const stageResultsByName = {};

        for (const stageDoc of stageOrdering.ordered) {
            const stageName = stageDoc.stage || 'Stage';
            const stageDependencies = this._normalizeDependsOn(stageDoc.dependsOn);
            const nonSucceededStageDependencies = stageDependencies.filter((dependencyName) => {
                const dependencyResult = stageResultsByName[dependencyName];
                return dependencyResult !== undefined && dependencyResult !== 'Succeeded';
            });

            if (
                nonSucceededStageDependencies.length > 0 &&
                !this._conditionAllowsFailedDependencies(stageDoc.condition)
            ) {
                const stageResult = this._buildSkippedStageResult(stageDoc);
                results.stages.push(stageResult);
                stageResultsByName[stageResult.stage] = stageResult.result;
                continue;
            }

            // Merge stageDeps into the base variables so each stage sees prior outputs.
            // User-supplied -v overrides (already in initialVariables) take precedence.
            const stageVars = { ...initialVariables, ...stageDeps };
            const stageResult = this._runStage(stageDoc, stageVars, options);
            results.stages.push(stageResult);
            stageResultsByName[stageResult.stage] = stageResult.result;

            // Publish this stage's outputs for subsequent stages.
            const stageResultName = stageResult.stage;
            for (const jobResult of stageResult.jobs) {
                const jobName = jobResult.job;
                stageDeps[`stageDependencies.${stageResultName}.${jobName}.result`] = jobResult.result || 'Succeeded';
                for (const [key, value] of Object.entries(jobResult.outputVariables)) {
                    stageDeps[`stageDependencies.${stageResultName}.${jobName}.outputs['${key}']`] = value;
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

        if (stageOrdering.skipped.length > 0) {
            console.warn(
                '[sim-deps] Skipped stages due to unresolved/cyclic dependencies:',
                stageOrdering.skipped.join(', ')
            );
        }

        // Always materialize publish roots so callers can inspect expected paths
        // even when no publish step ran due to conditions or earlier failures.
        this._ensureFallbackPackageArtifacts(initialVariables, resolvedWorkDir);
        this._writePipelineArtifactsIndex(this._getPipelineArtifactsRoot(initialVariables, resolvedWorkDir));
        this._writeBuildArtifactsIndex(this._getBuildArtifactsRoot(initialVariables, resolvedWorkDir));
        this._writeFeedPublishesIndex(this._getFeedPublishRoot(initialVariables, resolvedWorkDir));

        results.publishedArtifacts = [...this._publishedArtifacts];
        results.feedPublishes = [...this._feedPublishes];
        results.createdBuildFiles = [...this._createdBuildFiles].sort();
        return results;
    }

    _printSimulationContext(initialVariables, pipelineVars, options, resolvedWorkDir) {
        const simulationRoot = this._getSimulationRoot(initialVariables, resolvedWorkDir);
        const shimDir = this._getShimDir();
        const toolsPaths = this._getResolvedToolsPaths();

        const context = {
            platform: process.platform,
            nodeVersion: process.version,
            processCwd: process.cwd(),
            workingDirectory: this._formatContextPath(resolvedWorkDir),
            simulationRoot: this._formatContextPath(simulationRoot),
            outputRoot: this.outputRoot ? this._formatContextPath(this.outputRoot) : null,
            wslMountRoot: this.wslMountRoot || null,
            stageFilter: Array.isArray(options.stages) ? options.stages : null,
            debugFlags: {
                debugScript: this.debugScript,
                apsDebugScript: process.env.APS_DEBUG_SCRIPT === 'true',
                debugLibVars: process.env.DEBUG_LIB_VARS === 'true',
            },
            shimToolPath: this._formatContextPath(shimDir),
            toolsPaths: { ...this.executablePaths },
            resolvedToolsPaths: toolsPaths,
            variableSummary: {
                pipelineVariableCount: Object.keys(pipelineVars || {}).length,
                totalVariableCount: Object.keys(initialVariables || {}).length,
            },
            variables: this._formatContextVariables(initialVariables),
        };

        console.log('[sim-context]', JSON.stringify(context, null, 2));
    }

    _isBusyBoxShell(shellPath) {
        const cacheKey = String(shellPath || 'default');
        if (!this._busyboxCache) this._busyboxCache = new Map();
        if (this._busyboxCache.has(cacheKey)) return this._busyboxCache.get(cacheKey);
        // WSL is a full Linux environment, never BusyBox — skip the check to avoid WSL startup
        if (shellPath && /[/\\]wsl\.exe$/i.test(shellPath)) {
            this._busyboxCache.set(cacheKey, false);
            return false;
        }
        let result = false;
        try {
            const r = spawnSync(shellPath || 'bash', ['--version'], { encoding: 'utf8', timeout: 2000 });
            result = /busybox/i.test((r.stdout || '') + (r.stderr || ''));
        } catch (_) {}
        this._busyboxCache.set(cacheKey, result);
        return result;
    }

    _getNativeTaskShell(taskRef, inputs = {}, platform = process.platform) {
        const taskName = String(taskRef || '').trim();
        if (taskName === 'PowerShell@1' || taskName === 'PowerShell@2') {
            const rawPwsh = inputs && Object.prototype.hasOwnProperty.call(inputs, 'pwsh') ? inputs.pwsh : undefined;
            const normalizedPwsh = String(rawPwsh === undefined ? '' : rawPwsh)
                .trim()
                .toLowerCase();
            const usePwsh = rawPwsh === true || normalizedPwsh === 'true' || normalizedPwsh === '1';
            if (platform === 'win32') {
                return usePwsh ? 'pwsh' : 'powershell';
            }
            return 'pwsh';
        }

        return NATIVE_TASK_SHELLS[taskName];
    }

    _buildPowerShellUnavailableResult(shellName, extraStdout = '') {
        const unavailableShell = String(shellName || '').trim() || 'powershell';
        const mockNote = `[mock] ${unavailableShell} not available locally; step simulated.`;
        return {
            stdout: extraStdout ? `${extraStdout}\n${mockNote}` : mockNote,
            stderr: '',
            exitCode: 0,
        };
    }

    _resolveShellCommand(shellName) {
        const normalizedShell = String(shellName || '').trim();
        if (!normalizedShell) return normalizedShell;

        if (normalizedShell === 'pwsh' || normalizedShell === 'powershell') {
            return this._resolveCommandPath(normalizedShell) || normalizedShell;
        }

        const configuredPath = this.executablePaths && this.executablePaths[normalizedShell];
        return configuredPath ? path.normalize(String(configuredPath)) : normalizedShell;
    }

    _resolveCommandPath(commandName) {
        const configuredPath = this.executablePaths && this.executablePaths[commandName];
        if (configuredPath) {
            return path.normalize(String(configuredPath));
        }

        const toolsDir = String(this.toolsDirectory || '').trim();
        if (toolsDir) {
            const candidates =
                process.platform === 'win32'
                    ? [
                          path.join(toolsDir, commandName),
                          path.join(toolsDir, `${commandName}.exe`),
                          path.join(toolsDir, `${commandName}.cmd`),
                          path.join(toolsDir, `${commandName}.bat`),
                      ]
                    : [path.join(toolsDir, commandName)];
            for (const candidate of candidates) {
                try {
                    if (fs.existsSync(candidate)) {
                        return path.normalize(candidate);
                    }
                } catch (_) {
                    // Ignore tools-directory probing errors and keep resolving.
                }
            }
        }

        const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
        const lookup = spawnSync(lookupCommand, [commandName], { encoding: 'utf8' });
        if (lookup.status === 0) {
            const firstLine = String(lookup.stdout || '')
                .split(/\r?\n/)
                .map((line) => line.trim())
                .find((line) => line);
            return firstLine ? path.normalize(firstLine) : '';
        }
        return '';
    }

    _rewritePowerShellMacros(scriptContent, variables = {}) {
        const text = String(scriptContent || '');
        if (!text) return text;

        const variablesLower = Object.create(null);
        for (const key of Object.keys(variables || {})) {
            variablesLower[String(key).toLowerCase()] = key;
        }

        const toEnvRef = (name) => {
            const safeName = String(name || '')
                .toUpperCase()
                .replace(/[^A-Z0-9_]/g, '_');
            return `$env:${safeName}`;
        };

        let rewritten = text.replace(/\$\(([A-Za-z_][A-Za-z0-9_.-]*)\)/g, (match, name) => {
            const trimmed = String(name || '').trim();
            if (!trimmed) return match;

            if (Object.prototype.hasOwnProperty.call(variables, trimmed)) {
                return toEnvRef(trimmed);
            }

            const foundKey = variablesLower[trimmed.toLowerCase()];
            if (foundKey) {
                return toEnvRef(foundKey);
            }

            // Leave common PowerShell command substitutions intact (e.g. $(Get-Date)).
            if (trimmed.includes('-')) {
                return match;
            }

            // Treat unresolved ADO-like macros as env variable references to avoid
            // PowerShell subexpression invocation errors.
            if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(trimmed)) {
                return toEnvRef(trimmed);
            }

            return match;
        });

        rewritten = rewritten.replace(/\b__TRUE__\b/g, '$true').replace(/\b__FALSE__\b/g, '$false');

        // Some expanded YAML emits over-escaped regex literals for -match/-notmatch,
        // e.g. "\\Av\\d+\.\\d+\.\\d+\\Z". In PowerShell that pattern matches
        // literal backslashes instead of regex anchors/classes. Normalize those
        // sequences inside match-pattern string literals only.
        const normalizeMatchPattern = (pattern) =>
            String(pattern || '')
                .replace(/\\\\([AbBdDsSwWZz])/g, '\\$1')
                .replace(/\\\\\./g, '\\.')
                .replace(/\\\\\+/g, '\\+')
                .replace(/\\\\\*/g, '\\*')
                .replace(/\\\\\?/g, '\\?')
                .replace(/\\\\\{/g, '\\{')
                .replace(/\\\\\}/g, '\\}')
                .replace(/\\\\\(/g, '\\(')
                .replace(/\\\\\)/g, '\\)');

        rewritten = rewritten.replace(/(-(?:not)?match\s+")([^"\r\n]*)(")/gi, (m, pre, body, post) => {
            return `${pre}${normalizeMatchPattern(body)}${post}`;
        });
        rewritten = rewritten.replace(/(-(?:not)?match\s+')([^'\r\n]*)(')/gi, (m, pre, body, post) => {
            return `${pre}${normalizeMatchPattern(body)}${post}`;
        });
        return rewritten;
    }

    _normalizeShellEnvValue(shell, key, value) {
        const normalizedShell = String(shell || '')
            .trim()
            .toLowerCase();
        const envKey = String(key || '').trim();
        const raw = String(value === undefined || value === null ? '' : value);

        if (normalizedShell !== 'pwsh' && normalizedShell !== 'powershell') {
            return raw;
        }

        // Preserve multiline env values as-is (e.g. cert blobs).
        if (/\r|\n/.test(raw)) {
            return raw;
        }

        // Normalization for common version-style env vars passed to PowerShell.
        // This prevents hidden whitespace/quoting from failing strict validators.
        if (/_VERSION$/i.test(envKey)) {
            let trimmed = raw.trim();
            if (
                (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
                (trimmed.startsWith('"') && trimmed.endsWith('"'))
            ) {
                trimmed = trimmed.slice(1, -1).trim();
            }
            // Strip ANSI escapes/control chars/zero-width Unicode that can leak
            // into env values during local simulation and break strict regex checks.
            trimmed = trimmed
                .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
                .replace(/[\u0000-\u001F\u007F]/g, '')
                .replace(/[\u200B-\u200D\uFEFF]/g, '')
                .trim();
            return trimmed;
        }

        return raw;
    }

    _shouldMockBuildWrapperExecution(scriptContent) {
        const text = String(scriptContent || '');
        if (!text) return false;
        return /build-wrapper[^\r\n]*win[^\r\n]*x86[^\r\n]*64\.exe/i.test(text);
    }

    _getResolvedToolsPaths() {
        if (this._resolvedToolsPaths) {
            return { ...this._resolvedToolsPaths };
        }

        const resolved = {};
        for (const [toolName, configuredPath] of Object.entries(this.executablePaths || {})) {
            const name = String(toolName || '').trim();
            const value = String(configuredPath || '').trim();
            if (!name || !value) continue;
            resolved[name] = path.normalize(value);
        }

        const gitFromLookup = this._resolveCommandPath('git');
        if (gitFromLookup) {
            resolved.git = gitFromLookup;
        }

        this._resolvedToolsPaths = resolved;
        return { ...resolved };
    }

    _formatContextPath(rawPath) {
        if (rawPath === null || rawPath === undefined) return rawPath;
        const input = String(rawPath).trim();
        if (!input) return input;
        const resolved = this._resolveHostPath(input);
        return String(resolved).replace(/\\/g, '/');
    }

    _formatContextVariables(variables) {
        const formatted = { ...(variables || {}) };
        const pathVariableKeys = [
            'Build.Repository.LocalPath',
            'Build.ArtifactStagingDirectory',
            'Build.StagingDirectory',
            'Build.BinariesDirectory',
            'Build.SourcesDirectory',
            'System.DefaultWorkingDirectory',
            'Agent.WorkFolder',
            'Agent.BuildDirectory',
            'Agent.TempDirectory',
            'Agent.ToolsDirectory',
            'Agent.HomeDirectory',
            'Pipeline.Workspace',
            'Simulator.OutputRoot',
            'Simulator.RepositoryRoot',
        ];

        for (const variableKey of pathVariableKeys) {
            if (!Object.prototype.hasOwnProperty.call(formatted, variableKey)) {
                continue;
            }
            formatted[variableKey] = this._formatContextPath(formatted[variableKey]);
        }

        return formatted;
    }

    _resetSimulationWorkspace(variables, workDir) {
        const simulationRoot = this._getSimulationRoot(variables, workDir);
        const jobsRoot = path.join(simulationRoot, 'workspace', 'jobs');
        this._removeDirectoryWithFallback(jobsRoot);
        fs.mkdirSync(jobsRoot, { recursive: true });
    }

    _removeDirectoryWithFallback(targetDirectory) {
        try {
            fs.rmSync(targetDirectory, { recursive: true, force: true });
            return;
        } catch (error) {
            const code = error && error.code;
            if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
                throw error;
            }
        }

        // Single fallback: clear child entries individually.
        if (fs.existsSync(targetDirectory)) {
            try {
                for (const childName of fs.readdirSync(targetDirectory)) {
                    const childPath = path.join(targetDirectory, childName);
                    try {
                        fs.rmSync(childPath, { recursive: true, force: true });
                    } catch (_) {}
                }
                return;
            } catch (_) {}
        }

        // Files are locked — ask the user to delete the folder manually.
        throw new Error(
            `Simulation workspace is locked by another process.\n` +
                `Please delete the simulation folder and try again:\n  ${targetDirectory}`
        );
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
        // Re-apply userOverrides last so that YAML counter() expressions cannot
        // overwrite explicit user-supplied values (e.g. --build-counter / -v flags).
        const stageVariables = {
            ...variables,
            ...this._extractPipelineVariables(stageDoc, variables, options.libraryVariables || {}),
            ...(options.userOverrides || {}),
        };

        const jobOrdering = this._orderByDependencies(
            jobs,
            (jobDoc) => jobDoc.job || jobDoc.deployment || 'Job',
            (jobDoc) => jobDoc.dependsOn,
            'job'
        );
        const jobResultsByName = {};

        for (const jobDoc of jobOrdering.ordered) {
            const jobName = jobDoc.job || jobDoc.deployment || 'Job';
            const jobDependencies = this._normalizeDependsOn(jobDoc.dependsOn);
            const nonSucceededJobDependencies = jobDependencies.filter((dependencyName) => {
                const dependencyResult = jobResultsByName[dependencyName];
                return dependencyResult !== undefined && dependencyResult !== 'Succeeded';
            });

            if (nonSucceededJobDependencies.length > 0 && !this._conditionAllowsFailedDependencies(jobDoc.condition)) {
                const skippedJobResult = this._buildSkippedJobResult(jobDoc);
                stageResult.jobs.push(skippedJobResult);
                jobResultsByName[jobName] = skippedJobResult.result;
                stageVariables[`dependencies.${jobName}.result`] = skippedJobResult.result;
                continue;
            }

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
                jobResultsByName[jobName] = jobResult.result || 'Succeeded';
                for (const [key, value] of Object.entries(jobResult.outputVariables)) {
                    stageVariables[`dependencies.${jobName}.outputs['${key}']`] = value;
                }
            }
        }

        if (jobOrdering.skipped.length > 0) {
            console.warn(
                `[sim-deps] Stage ${stageName}: skipped jobs due to unresolved/cyclic dependencies: ${jobOrdering.skipped.join(', ')}`
            );
        }

        if (stageResult.jobs.some((jobResult) => jobResult.result === 'Failed')) {
            stageResult.result = 'Failed';
        } else if (
            stageResult.jobs.length > 0 &&
            stageResult.jobs.every((jobResult) => jobResult.result === 'Skipped')
        ) {
            stageResult.result = 'Skipped';
        } else {
            stageResult.result = 'Succeeded';
        }

        return stageResult;
    }

    _conditionAllowsFailedDependencies(condition) {
        if (!condition || typeof condition !== 'string') return false;
        const normalizedCondition = condition.toLowerCase().replace(/\s+/g, '');
        return (
            normalizedCondition.includes('always()') ||
            normalizedCondition.includes('failed()') ||
            normalizedCondition.includes('succeededorfailed()')
        );
    }

    _buildSkippedJobResult(jobDoc) {
        const jobName = jobDoc.job || jobDoc.deployment || 'Job';
        const steps = Array.isArray(jobDoc.steps) ? jobDoc.steps : [];
        return {
            job: jobName,
            displayName: jobDoc.displayName || jobName,
            result: 'Skipped',
            outputVariables: {},
            steps: steps.map((stepDoc) => ({
                displayName: stepDoc.displayName || 'Step',
                stepName: stepDoc.name || null,
                result: 'Skipped',
                variables: {},
                outputVariables: {},
                stdout: '',
                stderr: '',
                exitCode: 0,
            })),
        };
    }

    _buildSkippedStageResult(stageDoc) {
        const stageName = stageDoc.stage || 'Stage';
        const jobs = Array.isArray(stageDoc.jobs) ? stageDoc.jobs : [];
        return {
            stage: stageName,
            displayName: stageDoc.displayName || stageName,
            result: 'Skipped',
            jobs: jobs.map((jobDoc) => this._buildSkippedJobResult(jobDoc)),
        };
    }

    _orderByDependencies(items, getName, getDependsOn, kindLabel) {
        const pending = [...(items || [])];
        const ordered = [];
        const completed = new Set();
        const inScopeNames = new Set(pending.map((item) => String(getName(item) || '')));

        let madeProgress = true;
        while (pending.length > 0 && madeProgress) {
            madeProgress = false;

            for (let idx = 0; idx < pending.length; idx++) {
                const item = pending[idx];
                const dependencies = this._normalizeDependsOn(getDependsOn(item));
                const inScopeDependencies = dependencies.filter((dependencyName) => inScopeNames.has(dependencyName));
                const ready = inScopeDependencies.every((dependencyName) => completed.has(dependencyName));
                if (!ready) {
                    continue;
                }

                const itemName = String(getName(item) || '');
                ordered.push(item);
                completed.add(itemName);
                pending.splice(idx, 1);
                idx -= 1;
                madeProgress = true;
            }
        }

        const skipped = pending.map((item) => String(getName(item) || kindLabel || 'item'));
        return { ordered, skipped };
    }

    _normalizeDependsOn(dependsOn) {
        if (Array.isArray(dependsOn)) {
            return dependsOn.map((dependencyName) => String(dependencyName).trim()).filter(Boolean);
        }
        if (typeof dependsOn === 'string' && dependsOn.trim()) {
            return [dependsOn.trim()];
        }
        return [];
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
        // Re-apply userOverrides last so that YAML counter() expressions cannot
        // overwrite explicit user-supplied values (e.g. --build-counter / -v flags).
        const jobVariables = {
            ...variables,
            ...jobWorkspaceVariables,
            ...this._extractPipelineVariables(jobDoc, jobVariableContext, options.libraryVariables || {}),
            ...(options.userOverrides || {}),
        };
        const stepOptions = {
            ...options,
            // Scripts without explicit workingDirectory should run inside the job's clean sources directory.
            workingDirectory: jobVariables['Build.SourcesDirectory'],
            // Keep the original repository root available for checkout simulation.
            repositoryRoot: options.workingDirectory || process.cwd(),
        };
        this._currentRepositoryRoot = stepOptions.repositoryRoot;

        let jobFailed = false;
        for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
            const stepDoc = steps[stepIdx];

            // Steps after a job failure are not started (emit as Skipped so they appear in output).
            if (jobFailed) {
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
                jobFailed = true;
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

        try {
            fs.rmSync(jobRoot, { recursive: true, force: true });
        } catch (rmErr) {
            try {
                fs.rmSync(simulationRoot, { recursive: true, force: true });
            } catch (_) {
                const err = new Error(
                    `Simulation failed: permission denied. Please remove the simulation folder manually and try again: ${simulationRoot}`
                );
                err.code = rmErr.code;
                err.path = simulationRoot;
                throw err;
            }
        }

        const sourcesDirectory = path.join(jobRoot, 's');
        const tempDirectory = path.join(jobRoot, 'temp');

        for (const directory of [jobRoot, sourcesDirectory, tempDirectory]) {
            fs.mkdirSync(directory, { recursive: true });
        }

        return {
            'Build.SourcesDirectory': sourcesDirectory,
            'System.DefaultWorkingDirectory': sourcesDirectory,
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

        // Check mockCatalog for a display-name handler or mock descriptor.
        // Handlers are keyed as 'step:Display Name'; values may be a function
        // (called with (stepResult, variables)) or a plain mock descriptor object.
        const displayNameMock = this.mockCatalog[`step:${displayName}`];
        if (typeof displayNameMock === 'function') {
            return displayNameMock.call(this, stepResult, variables);
        }
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

            const debugEnabled = this.debugScript || !!process.env.APS_DEBUG_SCRIPT;
            if (debugEnabled) {
                process.stderr.write(
                    `[aps-debug][_runStep] "${displayName}" shell=${shell} scriptKey=${scriptKey} workDir=${workDir}\n`
                );
            }

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
            const executionStart = Date.now();
            console.log(`[sim-exec] START shell=${shell} step="${displayName}" cwd=${workDir}`);
            const run = this.executePreparedStep(shell, substituted, variables, workDir, stepEnv, displayName);
            const elapsedMs = Date.now() - executionStart;
            console.log(
                `[sim-exec] END shell=${shell} step="${displayName}" exit=${run.exitCode} durationMs=${elapsedMs}`
            );
            stepResult.stdout = run.stdout;
            stepResult.stderr = run.stderr;
            stepResult.exitCode = run.exitCode;
            stepResult.result = run.result;
            if (run.result === 'Failed') {
                // Build a diagnostic block visible in the simulation panel
                const _scriptLines = run._scriptContent ? run._scriptContent.split('\n') : [];
                const _lineMatch = /line (\d+):/i.exec(run.stderr || '');
                let _scriptContext = '';
                if (_lineMatch && _scriptLines.length) {
                    const _errLine = parseInt(_lineMatch[1], 10);
                    const _s = Math.max(0, _errLine - 4);
                    const _e = Math.min(_scriptLines.length, _errLine + 3);
                    _scriptContext =
                        '\n--- script context ---\n' +
                        _scriptLines
                            .slice(_s, _e)
                            .map((l, i) => `${_s + i + 1}${_s + i + 1 === _errLine ? ' >>>' : '    '} ${l}`)
                            .join('\n');
                }
                const _debugBlock =
                    `\n--- aps-debug: "${displayName}" exit=${run.rawExitCode} shell=${shell} ---` +
                    `\nworkDir: ${workDir}` +
                    `\nscript (substituted):\n${substituted}` +
                    _scriptContext;
                stepResult.stderr = (run.stderr || '') + _debugBlock;
                const debugEnabled = this.debugScript || !!process.env.APS_DEBUG_SCRIPT;
                if (debugEnabled) {
                    process.stderr.write(
                        '[aps-debug][_runStep] "' + displayName + '" FAILED exit=' + run.rawExitCode + '\n'
                    );
                }
            }
            stepResult.variables = { ...run.variables };
            stepResult.outputVariables = { ...run.outputVariables };
        } else if (stepDoc.task) {
            // After template expansion, bash:/script:/pwsh: become task: Bash@3/CmdLine@2/PowerShell@2.
            // Detect these and run them natively; all other tasks go to the mock catalog.
            const inputs = stepDoc.inputs || {};
            const nativeShell = this._getNativeTaskShell(stepDoc.task, inputs);
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
                const executionStart = Date.now();
                console.log(`[sim-exec] START shell=${nativeShell} step="${displayName}" cwd=${workDir}`);
                const run = this.executePreparedStep(
                    nativeShell,
                    substituted,
                    variables,
                    workDir,
                    stepEnv,
                    displayName
                );
                const elapsedMs = Date.now() - executionStart;
                console.log(
                    `[sim-exec] END shell=${nativeShell} step="${displayName}" exit=${run.exitCode} durationMs=${elapsedMs}`
                );
                stepResult.stdout = run.stdout;
                stepResult.stderr = run.stderr;
                stepResult.exitCode = run.exitCode;
                stepResult.result = run.result;
                stepResult.variables = { ...run.variables };
                stepResult.outputVariables = { ...run.outputVariables };
            } else if (nativeShell && inputs.filePath) {
                const scriptPath = path.resolve(workDir, inputs.filePath);
                const env = { ...process.env };
                const nativeShellCommand = this._resolveShellCommand(nativeShell);
                for (const [key, value] of Object.entries(variables)) {
                    env[key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')] = String(value);
                }
                const run = spawnSync(nativeShellCommand, [scriptPath], {
                    env,
                    cwd: workDir,
                    encoding: 'utf8',
                    timeout: 60000,
                });

                if (run.error && run.error.code === 'ENOENT') {
                    if (nativeShell === 'pwsh' || nativeShell === 'powershell') {
                        stepResult.stdout = this._buildPowerShellUnavailableResult(nativeShell).stdout;
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

                const baseTaskName = String(stepDoc.task || '').split('@')[0];
                if (baseTaskName === 'DownloadSecureFile' && stepResult.result === 'Succeeded') {
                    const secureFileInputRaw = String(inputs.secureFile || inputs.secureFileName || 'secure-file.dat');
                    const secureFileNameRaw = this._substituteTaskInputVariables(
                        String(inputs.secureFile || inputs.secureFileName || 'secure-file.dat'),
                        variables
                    );
                    const rawMacroMatch = /^\$\(([A-Za-z_][A-Za-z0-9_.]*)\)$/.exec(secureFileInputRaw.trim());
                    const macroVariableName = rawMacroMatch ? rawMacroMatch[1] : undefined;
                    const normalizedSecureFileName = path
                        .basename(secureFileNameRaw)
                        .replace(/[\\$()]/g, '')
                        .trim();
                    const secureFileName = normalizedSecureFileName || macroVariableName || 'secure-file.dat';
                    const tempDir = this._resolvePath(
                        String(variables['Agent.TempDirectory'] || workDir || process.cwd()),
                        variables,
                        workDir
                    );
                    const secureFilePath = path.join(tempDir, secureFileName);

                    try {
                        fs.mkdirSync(path.dirname(secureFilePath), { recursive: true });
                        if (!fs.existsSync(secureFilePath)) {
                            fs.writeFileSync(secureFilePath, 'simulated secure file\n', 'utf8');
                        }
                    } catch (_) {}

                    stepResult.variables = { ...stepResult.variables, secureFilePath };
                    if (macroVariableName) {
                        stepResult.variables[macroVariableName] = secureFileName;
                    }
                    if (stepResult.stepName) {
                        stepResult.outputVariables = { ...stepResult.outputVariables, secureFilePath };
                    }
                    stepResult.stdout = `${stepResult.stdout}\n[var] secureFilePath=${secureFilePath}`.trim();
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

        // Strip WSL proxy warning from step output regardless of which code path set it
        if (stepResult.stderr) {
            stepResult.stderr = stripWslProxyWarning(stepResult.stderr);
        }
        if (stepResult.stdout) {
            stepResult.stdout = stripWslProxyWarning(stepResult.stdout);
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
        const hasLocalGitMetadata = !isRemoteUrl && this._hasLocalGitMetadata(repositoryRoot);
        const shouldAttemptGitClone = checkoutSource === 'git' || (checkoutSource === 'local' && hasLocalGitMetadata);

        fs.rmSync(targetPath, { recursive: true, force: true });
        fs.mkdirSync(targetPath, { recursive: true });

        if (shouldAttemptGitClone) {
            const cloneArgs = ['clone'];
            if (isRemoteUrl) {
                cloneArgs.push('--depth', '1');
            }
            cloneArgs.push(repositoryRoot, targetPath);

            const clone = spawnSync('git', cloneArgs, {
                cwd: process.cwd(),
                encoding: 'utf8',
                timeout: 180000,
            });
            if (!clone.error && clone.status === 0) {
                const cloneMode = checkoutSource === 'git' ? 'git' : 'auto-git';
                return `[sim] checkout (${cloneMode}): ${repository} -> ${targetPath}`;
            }
        }

        // Local-source fallback keeps simulation deterministic/offline and mirrors the checked-out tree.
        const excludeTopLevelNames = ['.azure-pipeline-studio'];
        if (!hasLocalGitMetadata) {
            excludeTopLevelNames.push('.git');
        }
        this._copyDirectoryContents(repositoryRoot, targetPath, {
            excludeTopLevelNames,
        });
        const fallbackMode =
            checkoutSource === 'git' ? 'local-fallback' : hasLocalGitMetadata ? 'local-with-git' : 'local';
        return `[sim] checkout (${fallbackMode}): ${repository} -> ${targetPath}`;
    }

    _hasLocalGitMetadata(repositoryRoot) {
        if (!repositoryRoot || typeof repositoryRoot !== 'string') {
            return false;
        }

        try {
            const dotGitPath = path.join(repositoryRoot, '.git');
            return fs.existsSync(dotGitPath);
        } catch (_) {
            return false;
        }
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

    /**
     * Look up a variable by name, case-insensitively, matching Azure DevOps
     * behaviour (variable names are not case-sensitive — e.g. a variable set
     * as VERSION is also reachable via $(version) or $(Version)).
     * Exact-case matches win when present; otherwise the first case-insensitive
     * match is returned. Returns undefined if no match exists at all.
     */
    _lookupVariable(variables, name) {
        if (!variables || !name) return undefined;
        if (Object.prototype.hasOwnProperty.call(variables, name)) return variables[name];
        const lower = name.toLowerCase();
        for (const key of Object.keys(variables)) {
            if (key.toLowerCase() === lower) return variables[key];
        }
        return undefined;
    }

    _resolveConditionValue(token, variables) {
        const v = String(token || '').trim();
        if (/^'.*'$/.test(v) || /^".*"$/.test(v)) {
            return v.slice(1, -1);
        }
        if (/^(true|false)$/i.test(v)) return v.toLowerCase();

        const varMatch = /^variables\[['"]([^'"]+)['"]\]$/i.exec(v);
        if (varMatch) {
            const found = this._lookupVariable(variables, varMatch[1]);
            return found !== undefined ? found : '';
        }

        const found = this._lookupVariable(variables, v);
        return found !== undefined ? found : v;
    }

    /**
     * Extract the `variables:` block from any pipeline doc node (pipeline, stage, job).
     * Works for both array ([{name, value}]) and object ({key: value}) formats.
     * Applies runtime expression mocking.
     * @param {object} parentVariables - Already-resolved variables to use when a value references $(anotherVar)
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

        // $[ coalesce(arg1, arg2, ...) ] → return first non-empty resolved argument.
        const coalesceMatch = /^coalesce\((.+)\)$/i.exec(inner);
        if (coalesceMatch) {
            const args = this._splitExpressionArgs(coalesceMatch[1]);
            for (const arg of args) {
                const resolved = this._resolveExpressionArg(arg.trim(), variables);
                if (resolved !== undefined && resolved !== '') return resolved;
            }
            return '';
        }

        // $[ variables.x ] → look up 'x' directly in the variables map.
        const varsPrefixMatch = /^variables\.(.+)$/i.exec(inner);
        if (varsPrefixMatch) {
            const varName = varsPrefixMatch[1].trim();
            const found = this._lookupVariable(variables, varName);
            return found !== undefined ? found : '';
        }

        // Direct lookup: handles stageDependencies.S.J.outputs['s.v'],
        // dependencies.J.outputs['s.v'], and any other keyed expression.
        const found = this._lookupVariable(variables, inner);
        if (found !== undefined) return found;

        return ''; // Unresolved runtime expression → empty string
    }

    /**
     * Split a comma-separated expression argument list, respecting brackets and quotes.
     * e.g. "stageDependencies.A.B.outputs['x.y'], '0.0.0'" → two args
     */
    _splitExpressionArgs(str) {
        const args = [];
        let depth = 0;
        let current = '';
        let inQuote = false;
        let quoteChar = '';
        for (const ch of str) {
            if (inQuote) {
                current += ch;
                if (ch === quoteChar) inQuote = false;
            } else if (ch === "'" || ch === '"') {
                inQuote = true;
                quoteChar = ch;
                current += ch;
            } else if (ch === '(' || ch === '[') {
                depth++;
                current += ch;
            } else if (ch === ')' || ch === ']') {
                depth--;
                current += ch;
            } else if (ch === ',' && depth === 0) {
                args.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        if (current.trim()) args.push(current.trim());
        return args;
    }

    /**
     * Resolve a single expression argument (used by coalesce and similar functions).
     * Handles string literals ('value'), variables.x references, and direct variable lookups.
     */
    _resolveExpressionArg(arg, variables) {
        // String literal: 'value' or "value"
        const literalMatch = /^['"](.*)['"]$/.exec(arg);
        if (literalMatch) return literalMatch[1];

        // variables.x reference
        const varsPrefixMatch = /^variables\.(.+)$/i.exec(arg);
        if (varsPrefixMatch) {
            const resolvedKey = varsPrefixMatch[1].trim();
            const resolvedValue = this._lookupVariable(variables, resolvedKey);
            return resolvedValue !== undefined && resolvedValue !== null ? resolvedValue : '';
        }

        // Direct lookup: stageDependencies.S.J.outputs['key'], etc.
        const found = this._lookupVariable(variables, arg);
        if (found !== undefined) return found;

        return '';
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
        return text.replace(RE_SUBSTITUTE_VARS, (match, name) => {
            const found = this._lookupVariable(variables, name);
            if (found !== undefined) return found;
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

        const found = this._lookupVariable(variables, trimmed);
        if (found !== undefined) return found;

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
            resolved[key] = this._substituteVariables(this._normalizeValue(String(value), variables), variables);
        }
        return resolved;
    }

    /**
     * Public wrapper for script execution used by CLI and UI paths.
     * Keeps call sites decoupled from internal/private method names.
     */
    executeScript(shell, script, variables, workingDirectory, extraEnv = {}, displayName = '') {
        this._ensureSimulationDirectories(variables || {});
        this._initializeWindowsShellDiscovery();
        return this._executeScript(shell, script, variables, workingDirectory, extraEnv, displayName);
    }

    executePreparedStep(shell, script, variables, workingDirectory, extraEnv = {}, displayName = '') {
        const run = this.executeScript(shell, script, variables, workingDirectory, extraEnv, displayName);
        const outputText = `${run.stdout || ''}\n${run.stderr || ''}`;
        const ignoreCoverageConversionFailure =
            run.exitCode !== 0 &&
            /Microsoft\.CodeCoverage\.Console not found - skipping coverage conversion/i.test(outputText);
        const ignoreSignCommandFailure = run.exitCode !== 0 && /Error in sign command:/i.test(outputText);
        const ignoreFailure = ignoreCoverageConversionFailure || ignoreSignCommandFailure;

        const parsed = this._parseVsoDirectives(
            (run.stdout || '') +
                (run.stderr || '')
                    .split('\n')
                    .filter((line) => !/^\+/.test(line))
                    .join('\n')
        );

        return {
            ...run,
            rawExitCode: run.exitCode,
            exitCode: ignoreFailure ? 0 : run.exitCode,
            result: run.exitCode === 0 || ignoreFailure ? 'Succeeded' : 'Failed',
            variables: { ...parsed.local, ...parsed.output },
            outputVariables: { ...parsed.output },
            ignoreFailure,
        };
    }

    _toWslPath(rawPath) {
        const normalized = String(rawPath || '').replace(/\\/g, '/');
        // \\wsl.localhost\Distro\path -> /path (strip mount root prefix)
        if (this.wslMountRoot) {
            const mountNorm = String(this.wslMountRoot).replace(/\\/g, '/');
            if (normalized.toLowerCase().startsWith(mountNorm.toLowerCase() + '/')) {
                return normalized.slice(mountNorm.length) || '/';
            }
        }
        // //wsl.localhost/Distro/path -> /path
        const uncWslMatch = /^\/\/wsl\.localhost\/[^/]+(.*)/.exec(normalized);
        if (uncWslMatch) return uncWslMatch[1] || '/';
        // C:\path -> /mnt/c/path
        return normalized.replace(/^([A-Za-z]):[/\\]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`);
    }

    _runScriptViaWsl(scriptPath, effectiveCwd, env, extraEnv) {
        const wslScript = this._toWslPath(scriptPath);
        const wslCwd = this._toWslPath(String(effectiveCwd || ''));

        // WSL does not inherit custom Windows env vars (only those in WSLENV).
        // Export step-level env vars explicitly and only convert real Windows paths.
        const extraExports = Object.entries(extraEnv)
            .map(([k, v]) => `export ${k}=${JSON.stringify(this._normalizeWslExtraEnvValue(v))}`)
            .join('; ');

        // Read stdout/stderr through explicit temp files and markers because
        // direct stderr capture from wsl.exe can be unreliable.
        const token = `aps${Date.now()}${Math.random().toString(36).slice(2)}`;
        const outFile = `/tmp/${token}.out`;
        const errFile = `/tmp/${token}.err`;
        const marker = `__APS_MARKER_${token}__`;
        const runScript = `cd ${JSON.stringify(wslCwd)} && bash ${JSON.stringify(wslScript)} >${JSON.stringify(outFile)} 2>${JSON.stringify(errFile)}`;
        const cmd =
            `${extraExports ? extraExports + '; ' : ''}` +
            `${runScript}; _aps_exit=$?; ` +
            `printf '%s\\n' "${marker}EXIT:$_aps_exit"; ` +
            `printf '%s\\n' "${marker}OUT_START"; cat ${JSON.stringify(outFile)} 2>/dev/null; printf '%s\\n' "${marker}OUT_END"; ` +
            `printf '%s\\n' "${marker}ERR_START"; cat ${JSON.stringify(errFile)} 2>/dev/null; printf '%s\\n' "${marker}ERR_END"; ` +
            `rm -f ${JSON.stringify(outFile)} ${JSON.stringify(errFile)}`;

        const raw = spawnSync(WINDOWS_WSL_EXE, ['--', 'bash', '-c', cmd], {
            env,
            encoding: 'utf8',
            timeout: 60000,
        });
        const rawOut = raw.stdout || '';
        const extractBetween = (text, startMarker, endMarker) => {
            const startIdx = text.indexOf(startMarker);
            if (startIdx === -1) return '';
            const contentStart = text.indexOf('\n', startIdx) + 1;
            const endIdx = contentStart > 0 ? text.indexOf(endMarker, contentStart) : -1;
            if (contentStart === 0 || endIdx === -1) return '';
            return text.slice(contentStart, endIdx);
        };
        const exitMatch = new RegExp(`${marker}EXIT:(-?\\d+)`).exec(rawOut);
        const stdout = extractBetween(rawOut, `${marker}OUT_START`, `${marker}OUT_END`);
        const stderr = extractBetween(rawOut, `${marker}ERR_START`, `${marker}ERR_END`);

        return {
            ...raw,
            status: exitMatch ? parseInt(exitMatch[1], 10) : raw.status,
            stdout: stripWslProxyWarning(stdout),
            stderr: stripWslProxyWarning(stderr),
        };
    }

    _executeScript(shell, script, variables, workingDirectory, extraEnv = {}, displayName = '') {
        const shimDir = this._getShimDir();
        const ext = shell === 'bash' ? '.sh' : '.ps1';
        const tmpFile = path.join(
            process.env.HOME || os.homedir(),
            `aps-sim-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
        );
        let pythonApiShimDir;
        let keepTmpFile = false;
        let lastShellInvocation = shell;

        try {
            let scriptContent = script;

            if (shell === 'bash') {
                // Convert unresolved ADO macros that look like $(Agent.TempDirectory) into
                // bash variable references ${AGENT_TEMPDIRECTORY}. Without this, bash would
                // try to run Agent.TempDirectory as a command ("command not found"). With it,
                // variables exported earlier in the same script via ##vso[task.setvariable]
                // are accessible to subsequent lines.
                // Build a case-insensitive lookup map for variables so that ADO references
                // like $(version) correctly resolve even when the stored key is VERSION.
                const variablesLower = Object.create(null);
                for (const k of Object.keys(variables)) {
                    variablesLower[k.toLowerCase()] = k;
                }
                scriptContent = scriptContent.replace(/\$\(([A-Za-z_][A-Za-z0-9_.]*)\)/g, (match, varName) => {
                    const trimmed = varName.trim();
                    const shellName = trimmed.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                    // Exact match: materialize to bash env-var reference.
                    if (Object.prototype.hasOwnProperty.call(variables, trimmed)) {
                        return '${' + shellName + '}';
                    }
                    // Case-insensitive match: $(version) → ${VERSION} when VERSION is a variable.
                    if (Object.prototype.hasOwnProperty.call(variablesLower, trimmed.toLowerCase())) {
                        return '${' + shellName + '}';
                    }
                    // Keep unresolved macros as a literal token (no command substitution).
                    // Only escape names containing a dot — those are ADO macro references
                    // (e.g. $(Build.SourcesDirectory)) and are never valid bash commands.
                    // Names without a dot (e.g. $(pwd), $(date)) may be intentional bash
                    // command substitutions; Azure leaves them verbatim so bash executes them.
                    if (trimmed.includes('.')) {
                        return `\\$(${trimmed})`;
                    }
                    return match;
                });

                // Rewrite bash 5.1+ parameter transformations that BusyBox ash does not support.
                //   ${VAR@L}  → $(printf '%s' "${VAR}" | tr '[:upper:]' '[:lower:]')
                //   ${VAR@U}  → $(printf '%s' "${VAR}" | tr '[:lower:]' '[:upper:]')
                //   ${VAR@u}  → first-char uppercase (approximated via sed)
                //   ${VAR@Q}  → "${VAR}"  (quoted — approximation sufficient for simulation)
                //   ${VAR@E}  → "${VAR}"  (expand-escapes — approximation)
                //   ${VAR@A}  → "${VAR}"  (assignment form — approximation)
                scriptContent = scriptContent.replace(
                    /\$\{([A-Za-z_][A-Za-z0-9_]*)@([LUuQEA])\}/g,
                    (match, varName, op) => {
                        const ref = `"\${${varName}}"`;
                        if (op === 'L') return `$(printf '%s' ${ref} | tr '[:upper:]' '[:lower:]')`;
                        if (op === 'U') return `$(printf '%s' ${ref} | tr '[:lower:]' '[:upper:]')`;
                        if (op === 'u') return `$(printf '%s' ${ref} | sed 's/^./\\u&/')`;
                        // Q, E, A — just emit the value; adequate for simulation
                        return ref;
                    }
                );

                // Inject a preamble that intercepts each echo "##vso[task.setvariable...]"
                // call and exports the variable as a real bash variable. This makes
                // ##vso-set variables available to later lines in the same script.
                const preamble = [
                    '# APS Simulator preamble: intercept ##vso[task.setvariable] and export as shell variables',
                    '_aps_trace_pause() {',
                    '    case "$-" in',
                    '        *x*) _APS_TRACE_WAS_ON=1; set +x ;;',
                    '        *) _APS_TRACE_WAS_ON=0 ;;',
                    '    esac',
                    '}',
                    '_aps_trace_resume() {',
                    '    [ "${_APS_TRACE_WAS_ON:-0}" = "1" ] && set -x || true',
                    '}',
                    '',
                    '# Prefer resolved git path over PATH lookup on Windows bash variants.',
                    'APS_GIT_BIN="${APS_TOOL_PATH_GIT_WIN:-${APS_TOOL_PATH_GIT:-}}"',
                    'git() {',
                    '    _aps_trace_pause',
                    '    if [ -n "$APS_GIT_BIN" ]; then',
                    '        "$APS_GIT_BIN" "$@"',
                    '    else',
                    '        command git "$@"',
                    '    fi',
                    '    _aps_trace_resume',
                    '}',
                    '',
                    '# Provide cygpath fallback for Linux/WSL environments where Cygwin is not installed',
                    'if ! command -v cygpath >/dev/null 2>&1; then',
                    '    cygpath() {',
                    '        local _mode="" _target=""',
                    '        for _arg in "$@"; do',
                    '            case "$_arg" in',
                    '                -u|-w|-m) _mode="$_arg" ;;',
                    '                -*) ;;',
                    '                *) _target="$_arg" ;;',
                    '            esac',
                    '        done',
                    '        [ -z "$_target" ] && return 0',
                    '        if [ "$_mode" = "-w" ] || [ "$_mode" = "-m" ]; then',
                    '            printf "%s\\n" "$_target"',
                    '        elif printf "%s" "$_target" | grep -qE "^[A-Za-z]:[/\\\\]"; then',
                    '            _drive=$(printf "%s" "$_target" | cut -c1 | tr "[:upper:]" "[:lower:]")',
                    '            _rest="${_target:2}"',
                    '            _rest="${_rest#/}"; _rest="${_rest#\\\\}"',
                    '            _rest=$(printf "%s" "$_rest" | tr "\\134" "/")',
                    '            printf "/%s/%s\\n" "$_drive" "$_rest"',
                    '        else',
                    '            printf "%s\\n" "$(printf "%s" "$_target" | tr "\\134" "/")"',
                    '        fi',
                    '    }',
                    'fi',
                    '',
                    '# Ensure Unix find is used rather than Windows FIND.EXE (which does not support -name/-type etc.)',
                    'if ! find --version >/dev/null 2>&1 && command -v /usr/bin/find >/dev/null 2>&1; then',
                    '    find() { /usr/bin/find "$@"; }',
                    'fi',
                    '',
                    '# Simulate build-wrapper archive extraction in offline mode where curl is mocked.',
                    '# Some hosts resolve unzip to a real binary, which would fail on mocked empty zip output.',
                    'unzip() {',
                    '    local _src="" _dest="." _prev=""',
                    '    for _arg in "$@"; do',
                    '        if [ -z "$_src" ] && [ "${_arg#-}" = "$_arg" ]; then _src="$_arg"; fi',
                    '        if [ "$_prev" = "-d" ]; then _dest="$_arg"; fi',
                    '        _prev="$_arg"',
                    '    done',
                    '    case "${_src##*/}" in',
                    '        *build-wrapper*win*.zip|*build-wrapper*linux*.zip|*build-wrapper*macosx*.zip)',
                    '            mkdir -p "$_dest/build-wrapper-win-x86" "$_dest/build-wrapper-linux-x86" "$_dest/build-wrapper-macosx-x86"',
                    '            : > "$_dest/build-wrapper-win-x86/build-wrapper-win-x86-64.exe"',
                    '            : > "$_dest/build-wrapper-linux-x86/build-wrapper-linux-x86-64"',
                    '            : > "$_dest/build-wrapper-macosx-x86/build-wrapper-macosx-x86"',
                    '            return 0',
                    '            ;;',
                    '    esac',
                    '    command unzip "$@"',
                    '}',
                    '',
                    '# Mock jq if not available (e.g. Git Bash on Windows)',
                    'if ! command -v jq >/dev/null 2>&1; then',
                    "    jq() { printf 'null\\n'; return 0; }",
                    'fi',
                    '',
                    '# Mock python3/python if not available (e.g. Git Bash on Windows)',
                    'if ! command -v python3 >/dev/null 2>&1; then',
                    '    if command -v python >/dev/null 2>&1; then',
                    '        python3() { python "$@"; }',
                    '    else',
                    "        python3() { printf '[sim] python3 not available\\n' >&2; return 0; }",
                    '    fi',
                    'fi',
                    'if ! command -v python >/dev/null 2>&1; then',
                    '    python() { python3 "$@"; }',
                    'fi',
                    '',
                ].join('\n');
                const debugInjection = this.debugScript ? 'set -x\n' : '';

                // On Windows, Git Bash may not reliably receive env var values that
                // contain real newlines via the spawnSync env block. Re-export any
                // such variables inside the script using bash $'...' string literals,
                // which guarantee the correct value regardless of OS env-block limits.
                let _multilineReExports = '';
                if (process.platform === 'win32') {
                    const _bashEscape = (s) =>
                        s
                            .replace(/\\/g, '\\\\')
                            .replace(/'/g, "\\'")
                            .replace(/\n/g, '\\n')
                            .replace(/\r/g, '\\r')
                            .replace(/\t/g, '\\t');
                    const _allEnvSources = [
                        ...Object.entries(variables).map(([k, v]) => [
                            k.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
                            String(v),
                        ]),
                        ...Object.entries(extraEnv).map(([k, v]) => [k, String(v)]),
                    ];
                    const _seen = new Set();
                    for (const [k, v] of _allEnvSources) {
                        if (_seen.has(k)) continue;
                        _seen.add(k);
                        if (v.includes('\n') || v.includes('\r')) {
                            _multilineReExports += `export ${k}=$'${_bashEscape(v)}'\n`;
                        }
                    }
                }

                scriptContent = preamble + _multilineReExports + debugInjection + scriptContent;

                // Safety rail: mock remote-mutating update operations so simulation never writes remotely.
                // This avoids shell wrapper compatibility issues while still blocking commands like `git push`.
                const remoteUpdateMockRules = [
                    [/^(\s*)git\s+push\b.*$/gm, '$1echo "[mock-remote-update] git push skipped" >&2'],
                    [/^(\s*)nuget\s+push\b.*$/gm, '$1echo "[mock-remote-update] nuget push skipped" >&2'],
                    [
                        /^(\s*)dotnet\s+nuget\s+push\b.*$/gm,
                        '$1echo "[mock-remote-update] dotnet nuget push skipped" >&2',
                    ],
                    [/^(\s*)npm\s+publish\b.*$/gm, '$1echo "[mock-remote-update] npm publish skipped" >&2'],
                    [/^(\s*)pnpm\s+publish\b.*$/gm, '$1echo "[mock-remote-update] pnpm publish skipped" >&2'],
                    [/^(\s*)yarn\s+publish\b.*$/gm, '$1echo "[mock-remote-update] yarn publish skipped" >&2'],
                    [/^(\s*)twine\s+upload\b.*$/gm, '$1echo "[mock-remote-update] twine upload skipped" >&2'],
                    [
                        /^(\s*)az\s+artifacts\s+universal\s+publish\b.*$/gm,
                        '$1echo "[mock-remote-update] az artifacts universal publish skipped" >&2',
                    ],
                ];
                for (const [pattern, replacement] of remoteUpdateMockRules) {
                    scriptContent = scriptContent.replace(pattern, replacement);
                }

                if (this._shouldInjectPythonApiShim(scriptContent)) {
                    pythonApiShimDir = this._createPythonApiShim();
                }
            } else if (shell === 'pwsh' || shell === 'powershell') {
                scriptContent = this._rewritePowerShellMacros(scriptContent, variables);
            }

            fs.writeFileSync(tmpFile, scriptContent, { mode: 0o755 });

            // Expose pipeline variables as env vars using Azure DevOps convention:
            // dot/special chars → underscore, all uppercase (e.g. Build.Reason → BUILD_REASON)
            const env = { ...process.env };
            const resolvedToolsPaths = this._getResolvedToolsPaths();
            for (const [key, value] of Object.entries(variables)) {
                const safeKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                env[safeKey] = this._normalizeShellEnvValue(shell, safeKey, value);
            }
            const preferredHome = extraEnv.HOME || this._lookupVariable(variables, 'Agent.HomeDirectory');
            env.HOME = String(preferredHome);
            // Step-level env: (from YAML `env:` block) — applied with their original key names
            for (const [key, value] of Object.entries(extraEnv)) {
                env[key] = this._normalizeShellEnvValue(shell, key, value);
            }
            // Mocked tools should be first by default. Explicit overrides are
            // respected by not creating shims for overridden tool names.
            const preferredToolDirs = [String(this.toolsDirectory || '').trim()]
                .concat(
                    Object.values(resolvedToolsPaths)
                        .filter(Boolean)
                        .map((toolPath) => path.dirname(toolPath))
                )
                .filter(Boolean);
            const uniquePreferredToolDirs = [...new Set(preferredToolDirs)];
            env.PATH =
                shimDir +
                path.delimiter +
                uniquePreferredToolDirs.join(path.delimiter) +
                (uniquePreferredToolDirs.length ? path.delimiter : '') +
                (env.PATH || '');
            if (shell === 'bash' && process.platform === 'win32') {
                // BusyBox/Git Bash command lookup is more reliable with a POSIX-style
                // shim path in front of PATH. Also add directories of all resolved tools
                // so that overridden binaries remain discoverable.
                const bashShimDir = this._toBashPath(shimDir);
                const toolDirs = [
                    ...new Set(
                        [String(this.toolsDirectory || '').trim()]
                            .concat(Object.values(resolvedToolsPaths))
                            .filter(Boolean)
                            .map((p) => this._toBashPath(path.dirname(p)))
                            .filter(Boolean)
                    ),
                ];
                const gitBashDirs = this._getWindowsGitBashPathEntries();
                const preferredDirs = [...new Set([...gitBashDirs, ...toolDirs])];
                const extraDirs = preferredDirs.length ? preferredDirs.join(':') + ':' : '';
                // /usr/bin and /bin must be explicitly included: Git Bash does not source
                // its profile when invoked as `bash.exe script.sh`, so it never auto-adds
                // its bundled Unix tools (grep, sed, tr, tee, rm, etc.) to PATH.
                env.PATH = `${bashShimDir}:${extraDirs}/usr/bin:/bin:${env.PATH || ''}`;
            }
            if (pythonApiShimDir) {
                env.PYTHONPATH = pythonApiShimDir + path.delimiter + (env.PYTHONPATH || '');
            }
            if (shell === 'bash') {
                env.APS_RESOLVED_TOOLS_PATHS = JSON.stringify(resolvedToolsPaths);
                for (const [toolName, toolPath] of Object.entries(resolvedToolsPaths)) {
                    const safeToolName = String(toolName)
                        .toUpperCase()
                        .replace(/[^A-Z0-9_]/g, '_');
                    const pathValue =
                        process.platform === 'win32' ? this._toBashPath(toolPath) : String(toolPath || '');
                    env[`APS_TOOL_PATH_${safeToolName}`] = pathValue;
                    if (process.platform === 'win32') {
                        env[`APS_TOOL_PATH_${safeToolName}_WIN`] = String(toolPath || '').replace(/\\/g, '/');
                    }
                }
            }

            const resolvedCwd = workingDirectory
                ? this._resolveHostPath(String(workingDirectory).replace(/\\/g, '/'))
                : process.cwd();

            // Debug: log which shell + script will be run
            const _debugEnabled = this.debugScript || !!process.env.APS_DEBUG_SCRIPT;
            if (_debugEnabled) {
                process.stderr.write(`[aps-debug][_executeScript] shell=${shell} tmp=${tmpFile} cwd=${resolvedCwd}\n`);
                if (shell === 'bash') {
                    process.stderr.write('[aps-debug] bash env:\n' + JSON.stringify(env, null, 2) + '\n');
                }
            }
            if (_debugEnabled) {
                process.stderr.write('[aps-debug] script content:\n' + scriptContent.slice(0, 2000) + '\n');
            }

            const effectiveCwd = resolvedCwd;

            // For PowerShell scripts that invoke msbuild/dotnet build, always create mock build outputs
            // BEFORE trying to run the script. This ensures test DLLs exist in the workspace
            // regardless of whether PowerShell is available locally or the script fails.
            let _mockBuildOutputsMessage = '';
            if (
                (shell === 'pwsh' || shell === 'powershell') &&
                /\b(msbuild|dotnet\s+build|dotnet\s+test|devenv)\b/i.test(script) &&
                resolvedCwd
            ) {
                // Try to extract /p:Configuration=, /p:Platform=, and the .sln path from the script text
                // (template parameters expand to literals before simulation runs).
                const configMatch = script.match(/\/p:Configuration=(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))/i);
                const platformMatch = script.match(
                    /\/p:Platform=(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9 _]*)(?=\s*(?:\/|\r?\n|$)))/i
                );
                const slnMatch = script.match(/["']([^"'\r\n]*\.sln)["']/i);
                const buildContext = {
                    solution: slnMatch ? slnMatch[1] : '',
                    configuration: configMatch
                        ? configMatch[1] || configMatch[2] || configMatch[3] || ''
                        : String(variables['CURRENT_CONFIG'] || variables['Configuration'] || ''),
                    platform: platformMatch
                        ? (platformMatch[1] || platformMatch[2] || platformMatch[3] || '').trim()
                        : String(variables['CURRENT_PLATFORM'] || variables['Platform'] || ''),
                };
                try {
                    const discoveredFiles = this._materializeMockBuildOutputs(resolvedCwd, buildContext);
                    if (discoveredFiles.length > 0) {
                        _mockBuildOutputsMessage =
                            `[sim] build outputs (${displayName}):\n` +
                            discoveredFiles.map((f) => `[sim]   ${f}`).join('\n');
                        console.log(_mockBuildOutputsMessage);
                    } else {
                        _mockBuildOutputsMessage = `[sim] build outputs: none discovered (no .csproj/.vcxproj outputs found for ${buildContext.solution || 'solution'} ${buildContext.configuration}|${buildContext.platform})`;
                    }
                } catch (e) {
                    _mockBuildOutputsMessage = `[sim] build outputs: unavailable — ${e.message}`;
                }
            }

            // build-wrapper-win-x86-64.exe is frequently materialized as a dummy file
            // in offline simulation mode; executing that placeholder fails on Windows.
            // Mock the wrapper invocation but keep generated build output artifacts.
            if ((shell === 'pwsh' || shell === 'powershell') && this._shouldMockBuildWrapperExecution(script)) {
                const mockBuildWrapperLines = [
                    'Running: build-wrapper-win-x86-64.exe (mock)',
                    '[sim] build-wrapper execution skipped in simulation mode',
                    'Build wrapper completed successfully',
                ].join('\n');
                return {
                    stdout: _mockBuildOutputsMessage
                        ? `${mockBuildWrapperLines}\n${_mockBuildOutputsMessage}`
                        : mockBuildWrapperLines,
                    stderr: '',
                    exitCode: 0,
                };
            }

            // When the pwsh script explicitly invokes a Windows-only MSBuild.exe path,
            // mock the entire step — the binary doesn't exist outside a Windows build agent.
            if ((shell === 'pwsh' || shell === 'powershell') && /MSBuild\.exe/i.test(script)) {
                const _cfgM = script.match(/\/p:Configuration=(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))/i);
                const _pltM = script.match(
                    /\/p:Platform=(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9 _]*)(?=\s*(?:\/|\r?\n|$)))/i
                );
                const _slnM = script.match(/["']([^"'\r\n]*\.sln)["']/i);
                const _cfgStr = _cfgM ? ` /p:Configuration=${_cfgM[1] || _cfgM[2] || _cfgM[3] || ''}` : '';
                const _pltStr = _pltM ? ` /p:Platform=${(_pltM[1] || _pltM[2] || _pltM[3] || '').trim()}` : '';
                const _slnStr = _slnM ? ` ${_slnM[1]}` : '';
                const mockMSBuildLines = [
                    `Running: MSBuild.exe${_slnStr}${_cfgStr}${_pltStr} (mock)`,
                    'MSBuild version 17.0.0 (mock)',
                    'Build succeeded.',
                    '    0 Warning(s)',
                    '    0 Error(s)',
                    'Build completed successfully',
                ].join('\n');
                return {
                    stdout: _mockBuildOutputsMessage
                        ? `${mockMSBuildLines}\n${_mockBuildOutputsMessage}`
                        : mockMSBuildLines,
                    stderr: '',
                    exitCode: 0,
                };
            }

            // Git Bash (MSYS2) requires the script path in MSYS format (/c/Users/... not C:\Users\...).
            // BusyBox and other native Windows shells expect the plain Windows path.
            // Compute both and choose per-shell.
            const scriptArg = tmpFile;
            const scriptArgMsys =
                process.platform === 'win32'
                    ? tmpFile.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/')
                    : tmpFile;

            const resolvedShellCommand = this._resolveShellCommand(shell);
            const _rawConfiguredShell = this.executablePaths[shell];
            // Skip a configured shell that already failed in this simulation run — go straight to Git Bash.
            const configuredShell =
                _rawConfiguredShell && this._failedConfiguredShells.has(_rawConfiguredShell)
                    ? null
                    : _rawConfiguredShell;
            const windowsGitBashCandidates =
                shell === 'bash' && process.platform === 'win32' ? this._windowsGitBashCandidates : [];
            lastShellInvocation = configuredShell || shell;

            // tryRun uses the native Windows path by default; pass scriptArgMsys for Git Bash.
            const tryRun = (shellName, scriptPath = scriptArg) => {
                lastShellInvocation = shellName;
                let runEnv = env;
                if (shell === 'bash' && process.platform === 'win32') {
                    // Always prefer binaries from the selected Git Bash install over
                    // similarly named Windows system tools (e.g. FIND.EXE in system32).
                    const perShellGitBashDirs = this._getWindowsGitBashPathEntries(shellName);
                    if (perShellGitBashDirs.length) {
                        runEnv = {
                            ...env,
                            PATH: `${perShellGitBashDirs.join(':')}:${env.PATH || ''}`,
                        };
                    }
                }
                return spawnSync(shellName, [scriptPath], {
                    env: runEnv,
                    cwd: effectiveCwd,
                    encoding: 'utf8',
                    timeout: 60000,
                });
            };

            // tryRunWsl: run the script via wsl.exe -- bash <wslPath>.
            // WSL bash fully supports arrays and process substitution.
            const tryRunWsl = (scriptPath = scriptArg) => {
                lastShellInvocation = WINDOWS_WSL_EXE;
                return this._runScriptViaWsl(scriptPath, effectiveCwd, env, extraEnv);
            };
            const _wslAvailable = process.platform === 'win32' && this._wslAvailable;

            // If the user configured wsl.exe as the bash, handle it specially.
            const _configuredIsWsl = configuredShell && /[/\\]wsl\.exe$/i.test(configuredShell);
            let run;
            if (shell === 'bash' && process.platform === 'win32' && !configuredShell) {
                // Prefer full Git Bash first on Windows because some lightweight bash
                // variants do not support process substitution (< <(...)) used by templates.
                run = null;
                for (const gitBash of windowsGitBashCandidates) {
                    run = tryRun(gitBash, scriptArgMsys);
                    if (!run.error || run.error.code !== 'ENOENT') break;
                }
                if (!run || (run.error && run.error.code === 'ENOENT')) {
                    run = tryRun(shell);
                }
            } else if (_configuredIsWsl) {
                // User explicitly configured wsl.exe as bash; use WSL invocation.
                run = tryRunWsl(scriptArg);
            } else {
                run = tryRun(configuredShell || resolvedShellCommand || shell);
            }

            const _bashParseErrorPattern =
                /syntax error:\s*unexpected\s+"?\(|unexpected token\s+`?"?\(|expecting\s+"fi"/i;

            // When using a lightweight configured shell (e.g. BusyBox) that may not support
            // full bash syntax, fall back to Git Bash on Windows when the script fails.
            // Try POSIX arithmetic rewrite first, then full Git Bash.
            // Only enter this path when the failure looks like a shell-incompatibility issue
            // (bash syntax error) — not for ordinary non-zero exit codes from the script itself.
            const _looksLikeShellIncompatibility =
                run &&
                run.status !== 0 &&
                (_bashParseErrorPattern.test(String(run.stderr || '')) ||
                    _bashParseErrorPattern.test(String(run.stdout || '')));
            if (
                shell === 'bash' &&
                process.platform === 'win32' &&
                configuredShell &&
                _looksLikeShellIncompatibility &&
                windowsGitBashCandidates.length > 0
            ) {
                // First: rewrite ((...)) to POSIX and retry with the configured shell.
                // When configured shell is wsl.exe, use tryRunWsl so the path
                // is correctly converted to a WSL /mnt/... path.
                const _posixScript = _rewriteArithmeticForPosixAsh(scriptContent);
                fs.writeFileSync(tmpFile, _posixScript, { mode: 0o755 });
                const _posixRun = _configuredIsWsl ? tryRunWsl(scriptArg) : tryRun(configuredShell);
                if (!_posixRun.error || _posixRun.error.code !== 'ENOENT') {
                    run = _posixRun;
                }

                // If still failing, try Git Bash / WSL which support full bash syntax.
                if (run.status !== 0) {
                    this._failedConfiguredShells.add(configuredShell);
                    fs.writeFileSync(tmpFile, scriptContent, { mode: 0o755 });
                    process.stderr.write(
                        `[aps-gitbash] BusyBox failed (status=${run.status}), trying Git Bash / WSL\n`
                    );
                    for (const gitBash of windowsGitBashCandidates) {
                        const retried = tryRun(gitBash, scriptArgMsys);
                        process.stderr.write(
                            `[aps-gitbash] ${gitBash}: status=${retried.status} error=${retried.error ? retried.error.code : 'none'}\n`
                        );
                        if (retried.error && retried.error.code === 'ENOENT') continue;
                        run = retried;
                        break;
                    }
                    // If no Git Bash found, try WSL bash as last resort.
                    if (run.status !== 0 && _wslAvailable) {
                        process.stderr.write('[aps-gitbash] no Git Bash found, trying WSL bash\n');
                        const wslRun = tryRunWsl(scriptArg);
                        if (!wslRun.error) run = wslRun;
                    }
                }
            }

            // If no configured shell: retry with Git Bash when parse error detected.
            if (
                shell === 'bash' &&
                process.platform === 'win32' &&
                !configuredShell &&
                run &&
                run.status !== 0 &&
                _bashParseErrorPattern.test(String(run.stderr || ''))
            ) {
                for (const gitBash of windowsGitBashCandidates) {
                    const retried = tryRun(gitBash, scriptArgMsys);
                    if (retried.error && retried.error.code === 'ENOENT') continue;
                    run = retried;
                    break;
                }
            }

            if (run.error && run.error.code === 'ENOENT') {
                if (configuredShell) {
                    // Configured path not found — warn and fall through to the auto-discovery chain.
                    process.stderr.write(
                        `[bash-lookup] configured path not found: ${configuredShell}; falling back to auto-discovery\n`
                    );
                    run = tryRun(resolvedShellCommand || shell);
                }
                if (run.error && run.error.code === 'ENOENT') {
                    if (shell === 'bash') {
                        if (process.platform === 'win32') {
                            // bash (BusyBox symlink) was already tried above. Fall back to Git Bash
                            // for machines that don't have BusyBox installed.
                            for (const gitBash of windowsGitBashCandidates) {
                                run = tryRun(gitBash, scriptArgMsys);
                                if (!run.error || run.error.code !== 'ENOENT') break;
                            }
                            if (run.error && run.error.code === 'ENOENT') {
                                return {
                                    stdout: '[mock] bash not available locally; step simulated.',
                                    stderr: '',
                                    exitCode: 0,
                                };
                            }
                        } else {
                            // Non-Windows: bash already tried; fall back to sh.
                            run = tryRun('/bin/bash');
                            if (run.error && run.error.code === 'ENOENT') {
                                run = tryRun('sh');
                            }
                            if (run.error && run.error.code === 'ENOENT') {
                                return {
                                    stdout: '[mock] bash/sh not available locally; step simulated.',
                                    stderr: '',
                                    exitCode: 0,
                                };
                            }
                        }
                    } else if (shell === 'pwsh' || shell === 'powershell') {
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
                        return this._buildPowerShellUnavailableResult(shell, _mockBuildOutputsMessage);
                    }
                } // end: if (run.error && run.error.code === 'ENOENT') after configured-shell fallback
            }

            const _result = {
                stdout: _mockBuildOutputsMessage
                    ? `${_mockBuildOutputsMessage}\n${run.stdout || ''}`.trim()
                    : run.stdout || '',
                stderr: run.stderr || (run.error ? run.error.message : ''),
                exitCode: run.status !== null ? run.status : 1,
                _scriptContent: scriptContent,
            };
            const _exitCode = _result.exitCode;
            const _lineMatch = /line (\d+):/i.exec(_result.stderr || '');
            const _isShellParseError = _exitCode !== 0 && _bashParseErrorPattern.test(_result.stderr || '');

            if (_exitCode !== 0) {
                keepTmpFile = true;
                process.stderr.write(
                    `[aps-script-preserved] shell=${lastShellInvocation} tmp=${tmpFile} exit=${_exitCode}\n`
                );
            }

            if (_isShellParseError) {
                keepTmpFile = true;
                process.stderr.write(
                    `[aps-parse-error] shell=${lastShellInvocation} tmp=${tmpFile} cwd=${effectiveCwd} configuredShell=${configuredShell || ''}\n`
                );
                if (windowsGitBashCandidates.length) {
                    process.stderr.write(
                        `[aps-parse-error] gitBashCandidates=${windowsGitBashCandidates.join(' | ')}\n`
                    );
                }
                if (_lineMatch) {
                    const _errLine = parseInt(_lineMatch[1], 10);
                    const _scriptLines = scriptContent.split('\n');
                    const _start = Math.max(0, _errLine - 6);
                    const _end = Math.min(_scriptLines.length, _errLine + 4);
                    const _context = _scriptLines
                        .slice(_start, _end)
                        .map((line, index) => {
                            const lineNumber = _start + index + 1;
                            return `  ${lineNumber}${lineNumber === _errLine ? ' >>>' : '    '} ${line}`;
                        })
                        .join('\n');
                    process.stderr.write(`[aps-parse-error] script around line ${_errLine}:\n${_context}\n`);
                } else {
                    process.stderr.write('[aps-parse-error] full script follows:\n' + scriptContent + '\n');
                }
            }

            if (_debugEnabled) {
                process.stderr.write(
                    `[aps-debug][_executeScript] exit=${_exitCode} stdout-bytes=${(_result.stdout || '').length} stderr-bytes=${(_result.stderr || '').length}\n`
                );
                if (_exitCode !== 0) {
                    const _tail = (s, n) => (s ? s.split('\n').slice(-n).join('\n') : '');
                    process.stderr.write('[aps-debug] stdout(last 20):\n' + _tail(_result.stdout, 20) + '\n');
                    process.stderr.write('[aps-debug] stderr(last 20):\n' + _tail(_result.stderr, 20) + '\n');
                    // Extract line number from error (e.g. "line 16: syntax error") and show that line
                    if (_lineMatch) {
                        const _errLine = parseInt(_lineMatch[1], 10);
                        const _scriptLines = scriptContent.split('\n');
                        const _start = Math.max(0, _errLine - 4);
                        const _end = Math.min(_scriptLines.length, _errLine + 2);
                        const _context = _scriptLines
                            .slice(_start, _end)
                            .map((l, i) => `  ${_start + i + 1}${_start + i + 1 === _errLine ? ' >>>' : '    '} ${l}`)
                            .join('\n');
                        process.stderr.write(`[aps-debug] script around line ${_errLine}:\n${_context}\n`);
                    }
                } else {
                    const _tail = (s, n) => (s ? s.split('\n').slice(-n).join('\n') : '');
                    process.stderr.write('[aps-debug] stdout(last 10):\n' + _tail(_result.stdout, 10) + '\n');
                    if (_result.stderr && _result.stderr.length) {
                        process.stderr.write('[aps-debug] stderr(last 10):\n' + _tail(_result.stderr, 10) + '\n');
                    }
                }
            }
            if (_result.stderr) _result.stderr = stripWslProxyWarning(_result.stderr);
            if (_result.stdout) _result.stdout = stripWslProxyWarning(_result.stdout);
            return _result;
        } finally {
            if (!keepTmpFile) {
                try {
                    fs.unlinkSync(tmpFile);
                } catch (_) {}
            }
            if (pythonApiShimDir) {
                try {
                    fs.rmSync(pythonApiShimDir, { recursive: true, force: true });
                } catch (_) {}
            }
        }
    }

    _shouldInjectPythonApiShim(scriptContent) {
        if (typeof scriptContent !== 'string' || !scriptContent.length) {
            return false;
        }

        return (
            /python3?\s+-\s+<<['\"]?PYEOF/.test(scriptContent) &&
            /urllib\.request/.test(scriptContent) &&
            /_apis\/build\/builds\//.test(scriptContent)
        );
    }

    _createPythonApiShim() {
        const shimDir = fs.mkdtempSync(path.join(process.env.HOME || os.homedir(), 'aps-pyshim-'));
        const shimPath = path.join(shimDir, 'sitecustomize.py');
        const shimSource = [
            'import json',
            'import re',
            'import urllib.request',
            '',
            '_original_urlopen = urllib.request.urlopen',
            '',
            'class _MockResponse:',
            '    def __init__(self, payload):',
            '        self._payload = payload.encode("utf-8")',
            '    def read(self):',
            '        return self._payload',
            '    def __enter__(self):',
            '        return self',
            '    def __exit__(self, exc_type, exc, tb):',
            '        return False',
            '',
            'def _mock_payload(url):',
            '    if "/_apis/build/builds/" not in url:',
            '        return None',
            '    if "/timeline" in url:',
            '        return {"records": []}',
            '    if "/artifacts" in url and "api-version" in url:',
            '        if "artifactName=" in url and "fileId=" in url and "manifest.json" in url:',
            '            return {"items": []}',
            '        return {"value": []}',
            '    if re.search(r"/_apis/build/builds/[^/?]+\\?api-version=", url):',
            '        return {"startTime": "2024-01-01T00:00:00.000Z"}',
            '    return {}',
            '',
            'def _patched_urlopen(request, *args, **kwargs):',
            '    url = request.full_url if hasattr(request, "full_url") else str(request)',
            '    payload = _mock_payload(url)',
            '    if payload is not None:',
            '        return _MockResponse(json.dumps(payload))',
            '    return _original_urlopen(request, *args, **kwargs)',
            '',
            'urllib.request.urlopen = _patched_urlopen',
            '',
        ].join('\n');

        fs.writeFileSync(shimPath, shimSource, 'utf8');
        return shimDir;
    }

    /**
     * Lazily create (once per simulator instance) a temp directory of no-op
     * shim scripts for tools listed in this.mockTools that aren't on the PATH.
     */
    _isToolOnPath(name) {
        // On Windows, use 'where' to check tool availability — avoids spawning WSL (which
        // prints the localhost-proxy warning on every startup) just to check for a tool.
        if (process.platform === 'win32') {
            const result = spawnSync('where', [name], { encoding: 'utf8' });
            return result.status === 0;
        }
        const result = spawnSync('which', [name], { encoding: 'utf8' });
        return result.status === 0;
    }

    _getExplicitMockToolPath(name) {
        const toolName = String(name || '').trim();
        if (!toolName) return '';
        const target = toolName.toLowerCase();
        for (const [configuredName, configuredPath] of Object.entries(this.executablePaths || {})) {
            if (
                String(configuredName || '')
                    .trim()
                    .toLowerCase() !== target
            )
                continue;
            const value = String(configuredPath || '').trim();
            if (value) return path.normalize(value);
        }
        return '';
    }

    _isMockToolOverridden(name) {
        const toolName = String(name || '').trim();
        if (!toolName) return false;

        if (this._getExplicitMockToolPath(toolName)) return true;

        const toolsDir = String(this.toolsDirectory || '').trim();
        if (!toolsDir) return false;

        const candidates =
            process.platform === 'win32'
                ? [
                      path.join(toolsDir, toolName),
                      path.join(toolsDir, `${toolName}.exe`),
                      path.join(toolsDir, `${toolName}.cmd`),
                      path.join(toolsDir, `${toolName}.bat`),
                  ]
                : [path.join(toolsDir, toolName)];

        return candidates.some((candidate) => {
            try {
                return fs.existsSync(candidate);
            } catch (_) {
                return false;
            }
        });
    }

    _getShimDir() {
        if (this._shimDir) return this._shimDir;

        const dir = fs.mkdtempSync(path.join(process.env.HOME || os.homedir(), 'aps-shims-'));
        this._shimDir = dir;

        for (const tool of this.mockTools) {
            const explicitOverridePath = this._getExplicitMockToolPath(tool.name);
            if (explicitOverridePath) {
                const toolPath = path.join(dir, tool.name);
                const executablePath =
                    process.platform === 'win32' ? this._toBashPath(explicitOverridePath) : explicitOverridePath;
                const shimContent = `#!/usr/bin/env bash
# Forwarding shim for explicit tool override ${tool.name}
"${String(executablePath).replace(/"/g, '\\"')}" "$@"
exit $?
`;
                fs.writeFileSync(toolPath, shimContent, { mode: 0o755 });
                continue;
            }
            // Explicit tool mappings/folder entries must override mocks.
            if (this._isMockToolOverridden(tool.name)) continue;
            if (tool.onlyIfMissing && this._isToolOnPath(tool.name)) continue;
            const toolPath = path.join(dir, tool.name);
            const exitCode = tool.exitCode !== undefined ? tool.exitCode : 0;
            const stdout = tool.stdout || '';
            const stderrSuffix = tool.emitToStderr === false ? '' : ' >&2';
            let shimContent = `#!/usr/bin/env bash
# Mock shim for ${tool.name}
echo ${JSON.stringify(`[mock-tool] ${tool.name} $*`)}${stderrSuffix}
${stdout ? `echo ${JSON.stringify(stdout)}` : ''}
exit ${exitCode}
`;

            if (tool.name === 'java') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for java used by simulator offline mode
:
exit 0
`;
            } else if (tool.name === 'kinit') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for kinit used by simulator offline mode
echo ${JSON.stringify('[mock-tool] kinit $*')} >&2
exit 0
`;
            } else if (tool.name === 'curl') {
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
            } else if (tool.name === 'git') {
                shimContent = `#!/usr/bin/env bash
# Mock shim for git used by simulator offline mode
cmd="\${1:-}"
case "\$cmd" in
    config)
        if [[ "\$2" == "--get"* || "\$2" == "--list" ]]; then
            exit 0
        fi
        exit 0
        ;;
    rev-parse)
        echo "0000000000000000000000000000000000000000"
        exit 0
        ;;
    log)
        echo "0000000 [mock] simulated commit"
        exit 0
        ;;
    status)
        echo "On branch main"
        echo "nothing to commit, working tree clean"
        exit 0
        ;;
    clone|fetch|pull|push|checkout|submodule|remote|tag|branch|merge|rebase|stash|reset|clean|init|add|commit|show|diff|describe|ls-files|ls-remote)
        echo ${JSON.stringify('[mock-tool] git $*')} >&2
        exit 0
        ;;
    *)
        echo ${JSON.stringify('[mock-tool] git $*')} >&2
        exit 0
        ;;
esac
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

        if (taskName === 'VSTest') {
            const rawPatterns = String(
                inputs.testAssemblyVer2 || inputs.testAssemblyVer3 || inputs.testAssemblies || ''
            );
            const testPatterns = rawPatterns
                .split('\n')
                // Normalize Windows path separators. YAML double-quoted strings interpret \t as a
                // tab character (consuming the backslash and the 't'), so !**\testhost.dll becomes
                // "!**" + TAB + "esthost.dll". Restore the intended path by replacing TAB → "/t"
                // (which reconstructs the separator + the letter 't'), then replace any remaining
                // backslashes with forward slashes.
                .map((p) => p.replace(/\t/g, '/t').replace(/\\/g, '/').trim())
                .filter(Boolean);
            const includePatterns = testPatterns.filter((p) => !p.startsWith('!'));
            const excludePatterns = testPatterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
            const effectiveIncludes = includePatterns;
            const effectiveExcludes = excludePatterns;
            const allFiles = this._scanWorkDirFiles(workDir);
            const matched = this.filterByGlobPatterns(allFiles, effectiveIncludes, effectiveExcludes);
            const debugOutput = this.debugScript
                ? `[sim] VSTest: Processing patterns:\n` +
                  effectiveIncludes.map((p) => `[sim]   ${p}`).join('\n') +
                  '\n' +
                  effectiveExcludes.map((p) => `[sim]   !${p}`).join('\n') +
                  '\n'
                : '';
            if (matched.length === 0) {
                return `${debugOutput}[sim] VSTest: no test assemblies found`;
            }
            return (
                `${debugOutput}[sim] VSTest: ${matched.length} test assembl${matched.length === 1 ? 'y' : 'ies'}:\n` +
                matched.map((f) => `[sim]   ${f}`).join('\n')
            );
        }

        if (taskName === 'VSBuild' || taskName === 'MSBuild') {
            const buildContext = {
                solution:
                    inputs.solution ||
                    inputs.solutionFile ||
                    inputs.project ||
                    inputs.projects ||
                    inputs.projectFile ||
                    '',
                configuration: this._substituteTaskInputVariables(
                    String(inputs.configuration || inputs.buildConfiguration || ''),
                    variables
                ),
                platform: this._substituteTaskInputVariables(
                    String(inputs.platform || inputs.buildPlatform || ''),
                    variables
                ),
            };
            try {
                const discoveredFiles = this._materializeMockBuildOutputs(workDir, buildContext);
                if (discoveredFiles.length > 0) {
                    // Pre-populate bin-files.txt in Agent.TempDirectory so that publish steps
                    // that call create-filelist-v0.yaml don't fail when the bash redirect is
                    // unreliable on Windows (mixed backslash/forward-slash paths).
                    const tempDir = variables['Agent.TempDirectory'] || variables['agent.tempdirectory'];
                    if (tempDir) {
                        const binFilesPath = path.join(String(tempDir), 'bin-files.txt');
                        try {
                            const fileList = discoveredFiles.map((f) => `./${f.replace(/\\/g, '/')}`).join('\n') + '\n';
                            fs.mkdirSync(path.dirname(binFilesPath), { recursive: true });
                            if (!fs.existsSync(binFilesPath)) {
                                fs.writeFileSync(binFilesPath, fileList, 'utf8');
                            }
                        } catch (_) {}
                    }
                    return (
                        `[sim] build outputs (${taskRef}):\n` + discoveredFiles.map((f) => `[sim]   ${f}`).join('\n')
                    );
                }
            } catch (_) {}
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
                    'lib/mock.dll',
                    'lib/mock.pdb',
                    'lib/Any.Tests.dll',
                    'bin/x64/Release/mock.dll',
                    'bin/ARM64/Release/mock.dll',
                    'bin/mock.json',
                    'nuget/my.package.nuspec',
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
            const resolved = this._resolveHostPath(String(configuredRoot));
            fs.mkdirSync(resolved, { recursive: true });
            return resolved;
        }
        const workspaceRoot = variables['Pipeline.Workspace'] || workDir || process.cwd();
        return this._resolveHostPath(workspaceRoot);
    }

    /**
     * Resolve a path to something the host OS can use for fs/spawn operations.
     * On Windows, Linux absolute paths (e.g. /root/workspace/...) are prefixed
     * with wslMountRoot (e.g. \\wsl.localhost\Ubuntu-22.04) if available,
     * otherwise path.resolve() would produce a wrong C:\root\... path.
     */
    _resolveHostPath(p) {
        const s = String(p || '').trim();
        if (process.platform === 'win32') {
            // Already a UNC WSL path (\\wsl.localhost\Distro\...) → keep as-is.
            if (/^\\\\wsl\.localhost\\[^\\]+\\/i.test(s)) {
                return path.normalize(s);
            }

            // UNC-like WSL path expressed with forward slashes (//wsl.localhost/Distro/...)
            // should be normalized, not prefixed with wslMountRoot again.
            if (/^\/\/wsl\.localhost\/[^/]+\//i.test(s)) {
                return path.normalize(s.replace(/\//g, '\\'));
            }

            // Linux absolute path inside WSL (/root/...): map to configured UNC mount root.
            if (this.wslMountRoot && s.startsWith('/')) {
                return path.normalize(this.wslMountRoot + s.replace(/\//g, '\\'));
            }
        }
        return path.resolve(s);
    }

    _toBashPath(rawPath) {
        const s = String(rawPath || '').trim();
        if (!s) return '';
        if (process.platform !== 'win32') return s;

        // C:\foo\bar -> /c/foo/bar
        const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(s);
        if (driveMatch) {
            return `/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/[\\/]+/g, '/')}`;
        }

        // \\wsl.localhost\Distro\path -> //wsl.localhost/Distro/path
        if (/^\\\\wsl\.localhost\\/i.test(s)) {
            return s.replace(/\\/g, '/');
        }

        return s.replace(/\\/g, '/');
    }

    _resolvePath(rawPath, variables, workDir) {
        const substituted = this._substituteTaskInputVariables(String(rawPath), variables).replace(/\\/g, '/');
        if (path.isAbsolute(substituted)) {
            return this._resolveHostPath(substituted);
        }
        return this._resolveHostPath(path.posix.join((workDir || process.cwd()).replace(/\\/g, '/'), substituted));
    }

    _normalizeWslExtraEnvValue(rawValue) {
        const value = String(rawValue || '');
        // YAML double-quoted globs like !**\testhost.dll can degrade into
        // !**<TAB>esthost.dll before reaching WSL export. Repair that specific
        // consumed separator, but only path-convert values that are actually paths.
        const repaired = value.replace(/\t/g, '/t');
        const trimmed = repaired.trim();
        if (!trimmed) return repaired;

        const looksLikeWindowsPath =
            /^[A-Za-z]:[\\/]/.test(trimmed) ||
            /^\\\\wsl\.localhost\\[^\\]+\\/i.test(trimmed) ||
            /^\/\/wsl\.localhost\/[^/]+\//i.test(trimmed);

        return looksLikeWindowsPath
            ? repaired.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `/mnt/${d.toLowerCase()}/`)
            : repaired;
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
                    this._materializeFallbackBuildArtifacts(publishPath);
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
        this._materializeFallbackBuildArtifacts(publishPath);
    }

    _scanWorkDirFiles(workDir) {
        const root = path.resolve(String(workDir || process.cwd()));
        const results = [];
        const walk = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (_) {
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.isFile()) {
                    results.push(path.relative(root, full).replace(/\\/g, '/'));
                }
            }
        };
        walk(root);
        return results;
    }

    _materializeMockBuildOutputs(workDir, buildContext = {}) {
        const root = path.resolve(String(workDir || process.cwd()));
        const inferredBuildOutputs = this._discoverBuildOutputsFromSolution(root, buildContext);
        for (const relativeFile of inferredBuildOutputs) {
            const absoluteFile = path.join(root, relativeFile);
            try {
                fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
                if (!fs.existsSync(absoluteFile)) {
                    fs.writeFileSync(absoluteFile, 'mock\n', 'utf8');
                    this._recordCreatedBuildFile(absoluteFile, root);
                }
            } catch (_) {}
        }
        return [...inferredBuildOutputs].sort();
    }

    _recordCreatedBuildFile(absoluteFilePath, rootDir) {
        const absolute = path.resolve(String(absoluteFilePath || ''));
        const root = path.resolve(String(rootDir || process.cwd()));
        const relative = path.relative(root, absolute).replace(/\\/g, '/');
        if (!relative || relative.startsWith('..')) {
            this._createdBuildFiles.add(absolute.replace(/\\/g, '/'));
            return;
        }
        this._createdBuildFiles.add(relative);
    }

    _discoverBuildOutputsFromSolution(workDir, buildContext = {}) {
        const discovered = new Set();
        const slnPath = this._findTopLevelSolutionFile(workDir, buildContext.solution || '');
        if (!slnPath) {
            const hint = String(buildContext.solution || '').trim();
            const detail = hint ? ` (from build task input '${hint}')` : '';
            throw new Error(
                `No solution file (.sln) found in '${workDir}'${detail}. ` +
                    'Ensure the repository contains a .sln file or pass the solution path via the pipeline task inputs.'
            );
        }
        if (!fs.existsSync(slnPath)) {
            throw new Error(
                `Solution file not found on disk: ${slnPath}. ` + 'Ensure the repository checkout path is correct.'
            );
        }

        let slnContent = '';
        try {
            slnContent = fs.readFileSync(slnPath, 'utf8');
        } catch (err) {
            throw new Error(`Failed to read solution file '${slnPath}': ${err.message}`);
        }

        const slnDir = path.dirname(slnPath);
        const solutionConfigs = this._parseSolutionConfigurations(slnContent);
        const selectedBuildConfig = this._selectSolutionConfiguration(
            solutionConfigs,
            buildContext.configuration,
            buildContext.platform
        );

        const projectRefs = this._parseSolutionProjectReferences(slnContent);
        const missingProjects = [];
        for (const projectRef of projectRefs) {
            const absoluteProjectPath = path.resolve(slnDir, projectRef.path);
            if (!fs.existsSync(absoluteProjectPath)) {
                missingProjects.push(projectRef.path);
                continue;
            }

            const ext = path.extname(absoluteProjectPath).toLowerCase();
            let inferredProjectOutputs = [];
            if (ext === '.csproj') {
                inferredProjectOutputs = this._inferCsprojOutputs(absoluteProjectPath, selectedBuildConfig, slnDir);
            } else if (ext === '.vcxproj' || ext === '.vcproj') {
                inferredProjectOutputs = this._inferVcprojOutputs(absoluteProjectPath, selectedBuildConfig, slnDir);
            }

            for (const relativeOutput of inferredProjectOutputs) {
                const normalized = String(relativeOutput || '')
                    .replace(/\\/g, '/')
                    .replace(/^\.\//, '');
                if (normalized) {
                    discovered.add(normalized);
                }
            }
        }

        if (missingProjects.length > 0) {
            process.stderr.write(
                `[warn] ${missingProjects.length} project file(s) referenced in '${path.basename(slnPath)}' not found on disk:\n` +
                    missingProjects.map((p) => `  ${p}`).join('\n') +
                    '\n'
            );
        }

        return [...discovered];
    }

    discoverBuildOutputs(workDir, buildContexts = []) {
        const root = path.resolve(String(workDir || process.cwd()));
        const contexts = Array.isArray(buildContexts) && buildContexts.length > 0 ? buildContexts : [{}];
        const discovered = new Set();
        const errors = [];

        for (const buildContext of contexts) {
            try {
                for (const filePath of this._discoverBuildOutputsFromSolution(root, buildContext || {})) {
                    discovered.add(filePath);
                }
            } catch (err) {
                errors.push(err.message);
            }
        }

        if (errors.length > 0 && discovered.size === 0) {
            throw new Error(errors.join('\n'));
        }

        for (const errorMessage of errors) {
            process.stderr.write(`[warn] ${errorMessage}\n`);
        }

        return [...discovered].sort();
    }

    _globToRegex(pattern) {
        let p = String(pattern || '')
            .replace(/\\/g, '/')
            .trim();
        // Replace wildcards with unique placeholders before escaping literal chars,
        // so that added regex syntax (e.g. the '?' in '(?:') is never re-processed.
        p = p.replace(/\*\*\//g, '\x00DS\x00'); // **/ → zero-or-more segments
        p = p.replace(/\*\*/g, '\x00D\x00'); // ** → anything
        p = p.replace(/\*/g, '\x00S\x00'); // * → within-segment wildcard
        p = p.replace(/\?/g, '\x00Q\x00'); // ? → single char within segment
        // Escape regex special characters in literal text
        p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        // Restore wildcards as regex patterns
        p = p.replace(/\x00DS\x00/g, '(?:[^/]+/)*');
        p = p.replace(/\x00D\x00/g, '.*');
        p = p.replace(/\x00S\x00/g, '[^/]*');
        p = p.replace(/\x00Q\x00/g, '[^/]');
        return new RegExp(`^${p}$`, 'i');
    }

    filterByGlobPatterns(files, includePatterns, excludePatterns) {
        const includeRegexes = (includePatterns || []).map((p) => this._globToRegex(p));
        const excludeRegexes = (excludePatterns || []).map((p) => this._globToRegex(p));
        return files.filter((file) => {
            const normalized = String(file || '').replace(/\\/g, '/');
            const included = includeRegexes.length === 0 || includeRegexes.some((rx) => rx.test(normalized));
            if (!included) return false;
            return !excludeRegexes.some((rx) => rx.test(normalized));
        });
    }

    discoverTestInputs(workDir, buildContexts = [], testPatterns = []) {
        const allBuildOutputs = this.discoverBuildOutputs(workDir, buildContexts);
        const includePatterns = [];
        const excludePatterns = [];

        for (const pattern of testPatterns) {
            const normalized = String(pattern || '')
                .replace(/\\/g, '/')
                .trim();
            if (!normalized) continue;
            if (normalized.startsWith('!')) {
                excludePatterns.push(normalized.slice(1));
            } else {
                includePatterns.push(normalized);
            }
        }

        return this.filterByGlobPatterns(allBuildOutputs, includePatterns, excludePatterns);
    }

    _findTopLevelSolutionFile(workDir, solutionHint = '') {
        const root = path.resolve(String(workDir || process.cwd()));
        const hint = String(solutionHint || '').trim();
        if (hint) {
            const segments = hint
                .split(';')
                .map((entry) => entry.trim())
                .filter(Boolean);
            for (const entry of segments) {
                if (entry.includes('*') || entry.includes('?')) {
                    continue;
                }
                const candidate = path.isAbsolute(entry) ? entry : path.resolve(root, entry);
                if (candidate.toLowerCase().endsWith('.sln') && fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }

        try {
            const entries = fs.readdirSync(root, { withFileTypes: true });
            const slnEntry = entries.find((entry) => entry.isFile() && /\.sln$/i.test(entry.name));
            if (slnEntry) {
                return path.join(root, slnEntry.name);
            }
        } catch (_) {}

        // Fallback: search the repository root (the actual source tree) when workDir is
        // a simulated job workspace that is empty.
        const repoRoot = this._currentRepositoryRoot ? path.resolve(String(this._currentRepositoryRoot)) : '';
        if (repoRoot && repoRoot !== root) {
            if (hint) {
                const segments = hint
                    .split(';')
                    .map((entry) => entry.trim())
                    .filter(Boolean);
                for (const entry of segments) {
                    if (entry.includes('*') || entry.includes('?')) {
                        continue;
                    }
                    const candidate = path.isAbsolute(entry) ? entry : path.resolve(repoRoot, entry);
                    if (candidate.toLowerCase().endsWith('.sln') && fs.existsSync(candidate)) {
                        return candidate;
                    }
                }
            }
            try {
                const repoEntries = fs.readdirSync(repoRoot, { withFileTypes: true });
                const repoSlnEntry = repoEntries.find((entry) => entry.isFile() && /\.sln$/i.test(entry.name));
                if (repoSlnEntry) {
                    return path.join(repoRoot, repoSlnEntry.name);
                }
            } catch (_) {}
        }

        return '';
    }

    _parseSolutionConfigurations(slnContent) {
        const configs = [];
        const sectionMatch =
            /GlobalSection\(SolutionConfigurationPlatforms\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/i.exec(
                String(slnContent || '')
            );
        if (!sectionMatch) {
            return configs;
        }

        const lineRegex = /^\s*([^=\r\n]+)=/gm;
        let match;
        while ((match = lineRegex.exec(sectionMatch[1])) !== null) {
            const raw = String(match[1] || '').trim();
            const [configuration, platform] = raw.split('|').map((v) => String(v || '').trim());
            if (!configuration) {
                continue;
            }
            configs.push({
                configuration,
                platform: platform || 'Any CPU',
            });
        }
        return configs;
    }

    _selectSolutionConfiguration(solutionConfigs, requestedConfiguration, requestedPlatform) {
        const requestedConfig = String(requestedConfiguration || '').trim();
        const requestedPlat = String(requestedPlatform || '').trim();

        const normalizePlatform = (value) =>
            String(value || '')
                .toLowerCase()
                .replace(/\s+/g, '');
        const normalizeConfig = (value) => String(value || '').toLowerCase();

        if (requestedConfig && requestedPlat) {
            const direct = solutionConfigs.find(
                (entry) =>
                    normalizeConfig(entry.configuration) === normalizeConfig(requestedConfig) &&
                    normalizePlatform(entry.platform) === normalizePlatform(requestedPlat)
            );
            if (direct) {
                return direct;
            }
        }

        if (requestedConfig) {
            const sameConfig = solutionConfigs.find(
                (entry) => normalizeConfig(entry.configuration) === normalizeConfig(requestedConfig)
            );
            if (sameConfig) {
                return sameConfig;
            }
        }

        const release = solutionConfigs.find((entry) => normalizeConfig(entry.configuration) === 'release');
        if (release) {
            return release;
        }

        const debug = solutionConfigs.find((entry) => normalizeConfig(entry.configuration) === 'debug');
        if (debug) {
            return debug;
        }

        return solutionConfigs[0] || { configuration: 'Release', platform: 'Any CPU' };
    }

    _parseSolutionProjectReferences(slnContent) {
        const projectRefs = [];
        const regex = /^Project\("\{[^\}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/gm;
        let match;
        while ((match = regex.exec(String(slnContent || ''))) !== null) {
            const projectPath = String(match[2] || '')
                .replace(/\\/g, '/')
                .trim();
            if (!projectPath || !/\.(csproj|vcxproj|vcproj)$/i.test(projectPath)) {
                continue;
            }
            projectRefs.push({
                name: String(match[1] || '').trim(),
                path: projectPath,
            });
        }
        return projectRefs;
    }

    _inferCsprojOutputs(projectPath, buildConfig, workspaceRoot) {
        let content = '';
        try {
            content = fs.readFileSync(projectPath, 'utf8');
        } catch (_) {
            return [];
        }

        const projectDir = path.dirname(projectPath);
        const projectName = path.basename(projectPath, path.extname(projectPath));
        const assemblyName = this._readXmlTag(content, 'AssemblyName') || projectName;
        const outputType = (this._readXmlTag(content, 'OutputType') || 'Library').toLowerCase();
        const outputExtension = outputType.includes('exe') ? '.exe' : '.dll';
        const frameworkVersion = this._resolveFrameworkVersion(projectDir, buildConfig, content);
        const tokenValues = {};
        if (frameworkVersion) {
            tokenValues.FrameworkVersion = frameworkVersion;
            tokenValues.TargetFramework = frameworkVersion;
            tokenValues.TargetFrameworkVersion = frameworkVersion;
        }

        const appendTargetFrameworkToOutputPath =
            (this._readXmlTag(content, 'AppendTargetFrameworkToOutputPath') || 'true').toLowerCase() !== 'false';

        const cfgPlatform = String((buildConfig && buildConfig.platform) || '').trim();
        const isAnyCpu =
            !cfgPlatform || cfgPlatform.toLowerCase() === 'anycpu' || cfgPlatform.toLowerCase() === 'any cpu';

        const explicitOutputPath =
            this._readConditionalProperty(content, 'OutputPath', buildConfig) ||
            this._readXmlTag(content, 'OutputPath');
        const outputPath =
            explicitOutputPath ||
            (isAnyCpu ? `bin/${buildConfig.configuration}/` : `bin/${cfgPlatform}/${buildConfig.configuration}/`);

        const targetFrameworksRaw =
            this._readXmlTag(content, 'TargetFrameworks') ||
            this._readConditionalProperty(content, 'TargetFramework', buildConfig) ||
            this._readXmlTag(content, 'TargetFramework') ||
            '';
        const expandedTargetFrameworksRaw = this._expandBuildPathTokens(targetFrameworksRaw, buildConfig, tokenValues);
        const targetFrameworks = expandedTargetFrameworksRaw
            .split(';')
            .map((entry) => entry.trim())
            .filter(Boolean);

        const normalizedOutputBase = this._expandBuildPathTokens(outputPath, buildConfig, tokenValues)
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
        const outputFiles = [];
        const resolvedWorkspaceRoot = path.resolve(String(workspaceRoot || projectDir));

        if (targetFrameworks.length > 0 && appendTargetFrameworkToOutputPath) {
            for (const tfm of targetFrameworks) {
                outputFiles.push(
                    path.relative(
                        resolvedWorkspaceRoot,
                        path.join(projectDir, normalizedOutputBase, tfm, `${assemblyName}${outputExtension}`)
                    )
                );
                outputFiles.push(
                    path.relative(
                        resolvedWorkspaceRoot,
                        path.join(projectDir, normalizedOutputBase, tfm, `${assemblyName}.pdb`)
                    )
                );
            }
        } else {
            outputFiles.push(
                path.relative(
                    resolvedWorkspaceRoot,
                    path.join(projectDir, normalizedOutputBase, `${assemblyName}${outputExtension}`)
                )
            );
            outputFiles.push(
                path.relative(resolvedWorkspaceRoot, path.join(projectDir, normalizedOutputBase, `${assemblyName}.pdb`))
            );
        }

        return outputFiles.map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, ''));
    }

    _inferVcprojOutputs(projectPath, buildConfig, workspaceRoot) {
        let content = '';
        try {
            content = fs.readFileSync(projectPath, 'utf8');
        } catch (_) {
            return [];
        }

        const projectDir = path.dirname(projectPath);
        const projectName = path.basename(projectPath, path.extname(projectPath));
        const targetName = this._readXmlTag(content, 'TargetName') || projectName;

        const configurationType = (
            this._readConditionalProperty(content, 'ConfigurationType', buildConfig) ||
            this._readXmlTag(content, 'ConfigurationType') ||
            'DynamicLibrary'
        ).toLowerCase();
        const outputExtension = configurationType.includes('application')
            ? '.exe'
            : configurationType.includes('static')
              ? '.lib'
              : '.dll';

        const outDir =
            this._readConditionalProperty(content, 'OutDir', buildConfig) ||
            this._readConditionalProperty(content, 'OutputDirectory', buildConfig) ||
            this._readXmlTag(content, 'OutDir') ||
            this._readXmlTag(content, 'OutputDirectory') ||
            `bin/${buildConfig.configuration}/${buildConfig.platform}/`;

        const normalizedOutDir = this._expandBuildPathTokens(outDir, buildConfig)
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
        const resolvedWorkspaceRoot = path.resolve(String(workspaceRoot || projectDir));
        const outputs = [
            path.relative(
                resolvedWorkspaceRoot,
                path.join(projectDir, normalizedOutDir, `${targetName}${outputExtension}`)
            ),
        ];
        if (outputExtension !== '.lib') {
            outputs.push(
                path.relative(resolvedWorkspaceRoot, path.join(projectDir, normalizedOutDir, `${targetName}.pdb`))
            );
        }

        return outputs.map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, ''));
    }

    _readXmlTag(content, tagName) {
        const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\/${tagName}>`, 'i');
        const match = regex.exec(String(content || ''));
        return match ? String(match[1] || '').trim() : '';
    }

    _readConditionalProperty(content, propertyName, buildConfig) {
        const configuration = String((buildConfig && buildConfig.configuration) || '').trim();
        const platform = String((buildConfig && buildConfig.platform) || '').trim();
        if (!configuration) {
            return '';
        }

        const groupsRegex = /<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi;
        let groupMatch;
        const normalize = (value) =>
            String(value || '')
                .toLowerCase()
                .replace(/\s+/g, '');

        while ((groupMatch = groupsRegex.exec(String(content || ''))) !== null) {
            const attrs = String(groupMatch[1] || '');
            const body = String(groupMatch[2] || '');
            const conditionMatch = /Condition\s*=\s*"([^"]+)"/i.exec(attrs);
            if (!conditionMatch) {
                continue;
            }

            const condition = conditionMatch[1];
            const conditionConfigPlatform = /\$\(Configuration\)\s*\|\s*\$\(Platform\)\s*==\s*'([^']+)'/i.exec(
                condition
            );
            if (conditionConfigPlatform) {
                const [cfg, plt] = String(conditionConfigPlatform[1] || '')
                    .split('|')
                    .map((v) => String(v || '').trim());
                if (normalize(cfg) !== normalize(configuration)) {
                    continue;
                }
                if (platform && normalize(plt) !== normalize(platform)) {
                    continue;
                }
                const propertyValue = this._readXmlTag(body, propertyName);
                if (propertyValue) {
                    return propertyValue;
                }
            }
        }

        return '';
    }

    _normalizeFrameworkVersionValue(rawValue) {
        const value = String(rawValue || '').trim();
        if (!value) {
            return '';
        }
        if (/^net\d/i.test(value)) {
            return value;
        }

        const versionMatch = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
        if (!versionMatch) {
            return value;
        }

        const major = versionMatch[1] || '0';
        const minor = versionMatch[2] || '0';
        const patch = versionMatch[3] || '';
        if (patch && patch !== '0') {
            return `net${major}${minor}${patch}`;
        }
        return `net${major}${minor}`;
    }

    _resolveFrameworkVersion(projectDir, buildConfig, projectContent = '') {
        const fromProject =
            this._readConditionalProperty(projectContent, 'FrameworkVersion', buildConfig) ||
            this._readXmlTag(projectContent, 'FrameworkVersion') ||
            this._readConditionalProperty(projectContent, 'TargetFrameworkVersion', buildConfig) ||
            this._readXmlTag(projectContent, 'TargetFrameworkVersion');
        const normalizedFromProject = this._normalizeFrameworkVersionValue(fromProject);
        if (normalizedFromProject) {
            return normalizedFromProject;
        }

        let current = path.resolve(String(projectDir || process.cwd()));
        while (true) {
            const propsPath = path.join(current, 'Directory.Build.props');
            if (fs.existsSync(propsPath)) {
                try {
                    const propsContent = fs.readFileSync(propsPath, 'utf8');
                    const fromProps =
                        this._readConditionalProperty(propsContent, 'FrameworkVersion', buildConfig) ||
                        this._readXmlTag(propsContent, 'FrameworkVersion') ||
                        this._readConditionalProperty(propsContent, 'TargetFrameworkVersion', buildConfig) ||
                        this._readXmlTag(propsContent, 'TargetFrameworkVersion');
                    const normalizedFromProps = this._normalizeFrameworkVersionValue(fromProps);
                    if (normalizedFromProps) {
                        return normalizedFromProps;
                    }
                } catch (_) {}
            }

            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }

        return '';
    }

    _expandBuildPathTokens(rawPath, buildConfig, tokenValues = {}) {
        const configuration = String((buildConfig && buildConfig.configuration) || 'Release');
        const platform = String((buildConfig && buildConfig.platform) || 'Any CPU');
        let expanded = String(rawPath || '')
            .replace(/\$\(Configuration\)/gi, configuration)
            .replace(/\$\(PlatformName\)/gi, platform)
            .replace(/\$\(Platform\)/gi, platform);

        for (const [tokenName, tokenValue] of Object.entries(tokenValues || {})) {
            if (!tokenName) {
                continue;
            }
            const value = String(tokenValue || '').trim();
            if (!value) {
                continue;
            }
            const escapedTokenName = String(tokenName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const tokenRegex = new RegExp(`\\$\\(${escapedTokenName}\\)`, 'gi');
            expanded = expanded.replace(tokenRegex, value);
        }

        return expanded;
    }

    _materializeDummyNugetPackages(targetDir, variables = {}) {
        fs.mkdirSync(targetDir, { recursive: true });
        this._materializePackagePlaceholderNote(targetDir, variables);
    }

    _materializePackagePlaceholderNote(targetDir, variables = {}) {
        fs.mkdirSync(targetDir, { recursive: true });
        const rawVersion = String(variables.version || variables.VERSION || variables['Build.BuildNumber'] || '0.0.0');
        const defaultVersion = rawVersion.replace(/[^A-Za-z0-9._-]/g, '-') || '0.0.0';
        const note = [
            'No .nupkg files were generated by this simulation run.',
            'The simulator intentionally avoids creating synthetic package files',
            'because downstream unzip/validation steps expect valid zip content.',
            `Resolved build version: ${defaultVersion}`,
        ].join('\n');
        fs.writeFileSync(path.join(targetDir, 'NO_PACKAGES_FOUND.txt'), `${note}\n`, 'utf8');
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
        const hasNugetFeedPublish = this._feedPublishes.some((p) => p.type === 'nuget');
        if (!hasNugetFeedPublish && hasPackages) {
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

function printSimulationResults(results, { verbose = false } = {}) {
    const ICON = { Succeeded: '\u2714', Failed: '\u2716', Skipped: '\u29d8' };
    const COLOR = { Succeeded: '\x1b[32m', Failed: '\x1b[31m', Skipped: '\x1b[33m' };
    const RESET = '\x1b[0m';
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[2m';
    const YELLOW = '\x1b[33m';
    const RED = '\x1b[31m';

    const normalizeLogLine = (line) =>
        String(line || '')
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/^\s*\[stderr\]\s*/i, '')
            .trim();

    const extractVsoFromTraceEcho = (line) => {
        const raw = normalizeLogLine(line);
        const m = /^\+{1,3}\s+echo\s+['\"](##vso\[[^\]]+\][\s\S]*)['\"]$/.exec(raw);
        return m ? m[1] : '';
    };

    const formatLogLine = (line, isStderr = false) => {
        const tracedVso = extractVsoFromTraceEcho(line);
        const raw = tracedVso || String(line || '');
        if (/^##\s*\[debug\]/i.test(raw)) {
            return `${YELLOW}${raw}${RESET}`;
        }
        if (/^##\s*\[error\]/i.test(raw)) {
            return `${RED}${raw}${RESET}`;
        }
        if (/^##vso\[task\.debug\]/i.test(raw)) {
            return `${YELLOW}${raw}${RESET}`;
        }
        if (/^##vso\[task\.logissue\s+type=error[^\]]*\]/i.test(raw)) {
            return `${RED}${raw}${RESET}`;
        }
        if (/^##vso\[task\.logissue\s+type=warning[^\]]*\]/i.test(raw)) {
            return `${YELLOW}${raw}${RESET}`;
        }
        if (isStderr) {
            return `${DIM}[stderr]${RESET} ${raw}`;
        }
        return raw;
    };

    const isHiddenTraceNoise = (line) => {
        const raw = normalizeLogLine(line);
        return (
            /^\+{1,3}\s+_aps_trace_pause\b/.test(raw) ||
            /^\+{1,3}\s+_aps_trace_resume\b/.test(raw) ||
            /^\+{1,3}\s+case\s+"\$-"\s+in\b/.test(raw) ||
            /^\+{1,3}\s+_APS_TRACE_WAS_ON=/.test(raw) ||
            /^\+{1,3}\s+set\s+\+x\b/.test(raw) ||
            /^\+{1,3}\s+set\s+-x\b/.test(raw) ||
            /^\+{1,3}\s+exit\s+1$/.test(raw) ||
            /^wsl:\s+A localhost proxy configuration was detected/i.test(raw) ||
            /^WSL in NAT mode does not support localhost proxies/i.test(raw)
        );
    };

    const shouldShowStdoutLine = (line) => {
        const raw = String(line || '');
        if (!raw.trim()) return false;
        if (/^##vso\[/i.test(raw)) {
            return (
                /^##vso\[task\.logissue\s+type=(error|warning)[^\]]*\]/i.test(raw) || /^##vso\[task\.debug\]/i.test(raw)
            );
        }
        return true;
    };

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
                        .filter((l) => (verbose ? l.trim() : shouldShowStdoutLine(l)))
                        .forEach((l) => console.log(`      ${formatLogLine(l)}`));
                }
                if (stepResult.stderr) {
                    const _isWslProxyLine = (l) => {
                        const r = String(l || '').trim();
                        return (
                            r.startsWith('wsl: A localhost proxy configuration was detected') ||
                            r.startsWith('WSL in NAT mode does not support localhost proxies')
                        );
                    };
                    String(stepResult.stderr)
                        .split('\n')
                        .filter((l) => l.trim() && !_isWslProxyLine(l) && (verbose || !isHiddenTraceNoise(l)))
                        .forEach((l) => console.error(`      ${formatLogLine(l, true)}`));
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
