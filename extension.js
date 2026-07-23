const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const _b64Encode = (str) => Buffer.from(String(str), 'utf8').toString('base64');

// Import utility functions and formatter
const { pickFirstString, resolveConfiguredPath, normalizeExtension } = require('./utils');
const { PipelineSimulator, printSimulationResults } = require('./simulator');
const { formatYaml } = require('./formatter');
const { DependencyAnalyzer } = require('./dependency-analyzer');
const { _generateDependencyViewHtml, _generateDiagramLoadingHtml } = require('./dependency-webview');
const { _generateErrorViewHtml } = require('./error-webview');
const { _generateSimulationViewHtml } = require('./simulation-webview');
const {
    extractSimulationTree,
    extractTopLevelParameterDefinitions,
    extractPipelineVariables,
    buildSimulationDefaultVariables,
    resolveExecPaths,
    isLinuxSimulationContext,
    toSimulatorPath,
    normalizeCompileTimeVariables,
    applyDefaultBuildVariables,
    printCompileTimeVariableSources,
    extractReferencedParameters,
    extractReferencedVariables,
    scanStepForReferences,
    substituteTemplateExpressions,
    extractStepInputs,
    prepareStepTestInputs,
    extractStepType,
} = require('./step-inputs');

let vscode;
try {
    vscode = require('vscode');
} catch (error) {
    vscode = undefined;
}
const { AzurePipelineParser } = require('./parser');
const os = require('os');
const { spawn, execSync, spawnSync } = require('child_process');

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

const isWsl =
    process.platform === 'linux' &&
    (() => {
        try {
            return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
        } catch (_) {
            return false;
        }
    })();

function _resolveSimulationWorkingDirectory(document, parserOptions) {
    const candidates = [
        parserOptions && parserOptions.fileName,
        document && document.uri && document.uri.fsPath,
        document && document.fileName,
    ]
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0);

    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        try {
            const stat = fs.statSync(resolved);
            if (stat.isFile()) {
                return toSimulatorPath(path.dirname(resolved));
            }
            if (stat.isDirectory()) {
                return toSimulatorPath(resolved);
            }
        } catch (_) {
            if (/\.ya?ml$/i.test(resolved)) {
                return toSimulatorPath(path.dirname(resolved));
            }
        }
    }

    const fallbackPath = candidates[0] || process.cwd() || '.';
    return toSimulatorPath(path.dirname(path.resolve(fallbackPath)));
}

/** Convert a Windows UNC WSL path (\\wsl.localhost\distro\foo) to the Linux path (/foo).
 * Returns the path unchanged when it is already a Linux/Windows non-UNC path.
 */

/**
 * Resolves executable path overrides for the current simulation OS context.
 * Merges base-level entries with the appropriate OS sub-object ('windows' or 'linux'),
 * where the OS sub-object takes precedence. Entries under the other OS key are ignored.
 *
 * @param {Object} rawPaths - Raw value of simulation.toolPaths setting
 * @param {boolean} isLinuxContext - true when simulation scripts will run on Linux/WSL
 * @returns {Object} flat map of tool name → resolved path
 */

/**
 * Returns true when simulation scripts will execute in a Linux/WSL environment.
 * On a Windows host this is the case whenever the pipeline file lives inside WSL.
 *
 * @param {string} documentFileName
 */

/**
 * Extracts simple variable definitions and library group references from the
 * top-level variables: section of a parsed pipeline document.
 */

/**
 * Builds the standard default simulation variables from resolved paths.
 * Both the CLI and UI share this baseline variable set.
 *
 * @param {string} workingDirectory - Resolved working directory
 * @param {string} outputRoot - Resolved output root (no trailing slash)
 * @param {string} buildCounter - Build counter value as string
 * @param {Object} [extra={}] - Additional variables to merge in (e.g. checkout vars)
 */

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
        toolsDirectory = '',
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

    const defaultVariables = buildSimulationDefaultVariables(workingDirectory, outputRoot, counterStr, checkoutVars);

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
    const simulatorConfig = { outputRoot: outRoot, executablePaths, toolsDirectory, wslMountRoot, debugScript };
    if (mockCatalog) simulatorConfig.mockCatalog = mockCatalog;
    const simulator = new PipelineSimulator(simulatorConfig);
    return simulator.simulate(parsedDoc, simOptions);
}

function _extractBuildConfigurationsFromRawYaml(rawYaml) {
    let parsedYaml;
    try {
        const YAML = require('yaml');
        parsedYaml = YAML.parse(rawYaml);
    } catch (_) {
        return null;
    }
    if (!parsedYaml || typeof parsedYaml !== 'object') {
        return null;
    }
    const findConfigs = (node) => {
        if (!node || typeof node !== 'object') {
            return null;
        }
        if (Array.isArray(node)) {
            for (const item of node) {
                const result = findConfigs(item);
                if (result) {
                    return result;
                }
            }
            return null;
        }
        if (Array.isArray(node.buildConfigurations)) {
            const configs = node.buildConfigurations
                .filter((entry) => entry && typeof entry === 'object' && entry.config !== undefined)
                .map((entry) => ({
                    configuration: String(entry.config || ''),
                    platform: String(entry.platform || ''),
                }))
                .filter((entry) => entry.configuration);
            if (configs.length > 0) {
                return configs;
            }
        }
        for (const val of Object.values(node)) {
            const result = findConfigs(val);
            if (result) {
                return result;
            }
        }
        return null;
    };
    return findConfigs(parsedYaml);
}

function collectBuildContextsFromPipelineDocument(parsedDoc) {
    const contexts = [];
    const addContextFromStep = (step) => {
        if (!step || typeof step !== 'object') {
            return;
        }

        const taskRaw = String(step.task || '').trim();
        const taskName = taskRaw.split('@')[0];
        if (taskName !== 'VSBuild' && taskName !== 'MSBuild') {
            return;
        }

        const inputs = step.inputs && typeof step.inputs === 'object' ? step.inputs : {};
        contexts.push({
            solution:
                inputs.solution || inputs.solutionFile || inputs.project || inputs.projects || inputs.projectFile || '',
            configuration: inputs.configuration || inputs.buildConfiguration || '',
            platform: inputs.platform || inputs.buildPlatform || '',
        });
    };

    const visitSteps = (steps) => {
        if (!Array.isArray(steps)) {
            return;
        }
        for (const step of steps) {
            addContextFromStep(step);
        }
    };

    const visitJob = (job) => {
        if (!job || typeof job !== 'object') {
            return;
        }
        visitSteps(job.steps);
    };

    if (Array.isArray(parsedDoc.jobs)) {
        for (const job of parsedDoc.jobs) {
            visitJob(job);
        }
    }

    if (Array.isArray(parsedDoc.steps)) {
        visitSteps(parsedDoc.steps);
    }

    if (Array.isArray(parsedDoc.stages)) {
        for (const stage of parsedDoc.stages) {
            if (!stage || typeof stage !== 'object') {
                continue;
            }
            if (Array.isArray(stage.jobs)) {
                for (const job of stage.jobs) {
                    visitJob(job);
                }
            }
            if (Array.isArray(stage.steps)) {
                visitSteps(stage.steps);
            }
        }
    }

    return contexts;
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
    let dependenciesExpandedYaml = '';
    let dependenciesDocumentUri;
    let dependenciesDebounceTimer;
    let simulationDebounceTimer;
    let isSimulationRunning = false;
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

    const stageYamlScheme = 'azure-pipeline-stage';
    let stageYamlContent = '';
    const stageYamlEmitter = new vscode.EventEmitter();
    const stageYamlUri = vscode.Uri.parse(`${stageYamlScheme}://view/stage.yaml`);
    context.subscriptions.push(stageYamlEmitter);
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(stageYamlScheme, {
            onDidChange: stageYamlEmitter.event,
            provideTextDocumentContent: () => stageYamlContent,
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
                    const displayText = lineNumber ? `${templatePath}:${lineNumber}` : templatePath;
                    const link = `<a class="file-link" data-filepath="${escapeHtml(actualPath)}" data-line="${lineNumber || ''}" title="${escapeHtml(actualPath)}">${escapeHtml(displayText)}</a>`;
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
                        return `<a class="file-link" data-filepath="${escapeHtml(filePath)}" data-line="${lineNumber || ''}" title="${escapeHtml(filePath)}">${escapeHtml(match)}</a>`;
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
            ? `- <a class="file-link" data-action="configure-root">Configure Pipeline Root</a> if your templates use absolute paths (e.g. /stages/step.yaml) and no repository resources are defined.`
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

        const htmlContent = _generateErrorViewHtml(
            escapeHtml(title),
            formatErrorMessage(errorDetailsText),
            tipsHtml,
            makePathsClickable(escapeHtml(sanitizedStackText || 'No stack trace available'))
        );

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
            const rawPath = !isLinuxSimulationContext(document.fileName)
                ? pickFirstString(entry.windowsPath, entry.path, entry.location)
                : pickFirstString(entry.linuxPath, entry.path, entry.location);
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

    const generateLoadingHtml = _generateDiagramLoadingHtml;

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
                    const tempFile = path.join(os.tmpdir(), `pipeline-dependencies-${Date.now()}.html`);
                    fs.writeFileSync(tempFile, dependenciesPanelHtml);
                    if (isWsl) {
                        try {
                            const winPath = execSync(`wslpath -w "${tempFile}"`).toString().trim();
                            spawn('cmd.exe', ['/c', 'start', '', winPath], {
                                detached: true,
                                stdio: 'ignore',
                            }).unref();
                        } catch (_) {
                            spawn('xdg-open', [tempFile], { detached: true, stdio: 'ignore' }).unref();
                        }
                    } else {
                        await vscode.env.openExternal(vscode.Uri.file(tempFile));
                    }
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
            } else if (message.command === 'getStageYaml') {
                const yaml = dependenciesExpandedYaml;
                const stageName = message.stageName;
                let yamlText = yaml;
                if (yaml && stageName) {
                    const lines = yaml.split('\n');
                    let start = -1;
                    let baseIndent = 0;
                    for (let i = 0; i < lines.length; i++) {
                        const m = lines[i].match(/^(\s*)- (?:stage|job|deployment): (.+)$/);
                        if (m && m[2].trim() === stageName) {
                            start = i;
                            baseIndent = m[1].length;
                            break;
                        }
                    }
                    if (start !== -1) {
                        let end = lines.length;
                        for (let i = start + 1; i < lines.length; i++) {
                            if (!lines[i].trim()) continue;
                            const m2 = lines[i].match(/^(\s*)-\s/);
                            if (m2 && m2[1].length <= baseIndent) {
                                end = i;
                                break;
                            }
                        }
                        yamlText = lines.slice(start, end).join('\n');
                    }
                }
                stageYamlContent = yamlText;
                stageYamlEmitter.fire(stageYamlUri);
                await vscode.window.showTextDocument(stageYamlUri, {
                    preserveFocus: true,
                    preview: false,
                    viewColumn: vscode.ViewColumn.Active,
                });
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

                dependenciesExpandedYaml = expandedYaml;

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

                const htmlContent = _generateDependencyViewHtml(projectName, mermaidDiagram, stageCountForDisplay);

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
            stageTree = extractSimulationTree(expandedDoc);
            topLevelParameterDefinitions = extractTopLevelParameterDefinitions(simParser, sourceText, skipSyntaxCheck);
        } catch (err) {
            const enhancedError = new Error(formatTemplateExpansionError(document.fileName, err));
            enhancedError.stack = err.stack;
            showErrorWebviewNow(enhancedError, context, 'expansion');
            return;
        }

        const { simple: pipelineSimpleVars, groups: pipelineVarGroups } = extractPipelineVariables(expandedDoc);
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
        const knownVarsJson = _b64Encode(
            JSON.stringify({
                azure: azureSystemVars,
                pipeline: pipelineSimpleVars,
                groups: pipelineVarGroups,
            })
        );

        lastSimDocument = document;
        lastSimSourceText = sourceText;
        lastSimParserOptions = parserOptions;

        if (simulationPanel) {
            try {
                simulationPanel.reveal(vscode.ViewColumn.Two, true);
            } catch (_revealErr) {
                // Panel may have been disposed asynchronously; reset and fall through to create a new one
                simulationPanel = null;
                activeSimulationPanel = null;
            }
        }
        if (!simulationPanel) {
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
                const postSimulationMessage = (payload) => {
                    if (simulationPanel && simulationPanel.webview) {
                        simulationPanel.webview.postMessage(payload);
                    }
                };
                if (!document || !parserOptions || typeof sourceText !== 'string') {
                    postSimulationMessage({
                        command: 'simulationError',
                        error: 'Simulation context is unavailable. Please reopen the simulation view and try again.',
                    });
                    return;
                }
                const parseBuildCounter = (rawCounter) => {
                    const parsed = parseInt(rawCounter, 10);
                    return isNaN(parsed) ? '1' : String(parsed);
                };
                const getSimulationExecutionConfig = (toolPathsOverride, toolsDirectoryOverride) => {
                    const simulationConfig = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
                    const toolsDirectorySetting = simulationConfig.get('simulation.toolsDirectory', null);
                    const execPathsRaw = simulationConfig.get('simulation.toolPaths', {});
                    const execPathsBase = resolveExecPaths(execPathsRaw, isLinuxSimulationContext(document.fileName));
                    const mergedExecPaths = {
                        ...execPathsBase,
                        ...(toolPathsOverride && typeof toolPathsOverride === 'object' ? toolPathsOverride : {}),
                    };
                    const simDistroMatch = document.fileName.match(/^\\\\wsl\.localhost\\([^\\]+)/i);
                    const wslMountRoot =
                        process.platform === 'win32' && simDistroMatch
                            ? `\\\\wsl.localhost\\${simDistroMatch[1]}`
                            : null;
                    const toolsDirectory =
                        typeof toolsDirectoryOverride === 'string' && toolsDirectoryOverride.trim()
                            ? toolsDirectoryOverride.trim()
                            : toolsDirectorySetting || '';
                    return {
                        execPaths: mergedExecPaths,
                        toolsDirectory,
                        wslMountRoot,
                    };
                };
                if (message.command === 'runInTerminal') {
                    const isWindows = process.platform === 'win32';

                    // On Windows hosts, run with Windows Node to avoid old WSL /usr/bin/node syntax limitations.
                    const pipelineFile = isWindows ? document.fileName : toSimulatorPath(document.fileName);
                    const bundlePath = isWindows
                        ? path.join(__dirname, 'extension-bundle.js')
                        : toSimulatorPath(path.join(__dirname, 'extension-bundle.js'));

                    const token = `aps-sim-${Date.now()}.json`;
                    const jsonOutputPath = isWindows
                        ? path.join(os.tmpdir(), token)
                        : path.join(process.env.HOME || os.homedir(), token);
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
                                    : toSimulatorPath(resolvedLocation.trim());
                                simArgs.push('--resource', `${alias.trim()}=${repoPath}`);
                            }
                        }
                    }
                    const termExecPaths = getSimulationExecutionConfig({}, null).execPaths;
                    for (const [exeName, exePath] of Object.entries(termExecPaths)) {
                        const rawExePath = String(exePath || '').trim();
                        if (!rawExePath) continue;
                        simArgs.push('--toolpath', `${exeName}=${rawExePath}`);
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
                        postSimulationMessage({
                            command: 'simulationError',
                            error: `Failed to start simulation process: ${err.message}`,
                        });
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
                                postSimulationMessage({ command: 'simulationResults', results });
                            } else {
                                postSimulationMessage({
                                    command: 'simulationError',
                                    error: 'Simulation failed — see Output \u203a Pipeline Simulation for details.',
                                });
                            }
                        } catch (err) {
                            postSimulationMessage({ command: 'simulationError', error: err.message });
                        }
                    });
                    return;
                }
                if (message.command === 'openResultsInBrowser') {
                    try {
                        const html = String(message.html || '');
                        const tempFile = path.join(
                            process.env.HOME || os.homedir(),
                            `pipeline-sim-results-${Date.now()}.html`
                        );
                        fs.writeFileSync(tempFile, html, 'utf8');

                        if (isWsl) {
                            try {
                                const winPath = execSync(`wslpath -w "${tempFile}"`).toString().trim();
                                spawn('cmd.exe', ['/c', 'start', '', winPath], {
                                    detached: true,
                                    stdio: 'ignore',
                                }).unref();
                            } catch (_) {
                                spawn('xdg-open', [tempFile], { detached: true, stdio: 'ignore' }).unref();
                            }
                        } else {
                            let openedExternally = false;
                            try {
                                openedExternally = await vscode.env.openExternal(vscode.Uri.file(tempFile));
                            } catch (_) {
                                openedExternally = false;
                            }

                            if (!openedExternally) {
                                if (process.platform === 'win32') {
                                    spawn('cmd.exe', ['/c', 'start', '', tempFile], {
                                        detached: true,
                                        stdio: 'ignore',
                                    }).unref();
                                } else if (process.platform === 'darwin') {
                                    spawn('open', [tempFile], { detached: true, stdio: 'ignore' }).unref();
                                } else {
                                    spawn('xdg-open', [tempFile], { detached: true, stdio: 'ignore' }).unref();
                                }
                            }
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
                if (message.command === 'saveStepVarOverrides') {
                    const existing = context.workspaceState.get('aps.azureVars', { overrides: {} }) || {
                        overrides: {},
                    };
                    const merged = Object.assign({}, existing.overrides || {}, message.data || {});
                    context.workspaceState.update('aps.azureVars', { overrides: merged });
                    const legacy = context.workspaceState.get('aps.vars', null) || {};
                    context.workspaceState.update('aps.vars', Object.assign({}, legacy, { overrides: merged }));
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
                    const toolsDirectoryForLoad = vscode.workspace
                        .getConfiguration('azurePipelineStudio', document.uri)
                        .get('simulation.toolsDirectory', null);
                    const execPathsRawForLoad = vscode.workspace
                        .getConfiguration('azurePipelineStudio', document.uri)
                        .get('simulation.toolPaths', {});
                    const mergedToolPathsForLoad = resolveExecPaths(
                        execPathsRawForLoad,
                        isLinuxSimulationContext(document.fileName)
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
                        toolsDirectory: toolsDirectoryForLoad,
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
                    const nextToolsDirectory =
                        message.data && typeof message.data.toolsDirectory === 'string'
                            ? message.data.toolsDirectory.trim() || null
                            : null;
                    const platformKey = isLinuxSimulationContext(document.fileName) ? 'linux' : 'windows';
                    const otherKey = platformKey === 'linux' ? 'windows' : 'linux';
                    try {
                        const cfg = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
                        const existing = cfg.get('simulation.toolPaths', {}) || {};
                        const updated = {};
                        if (existing[otherKey] && Object.keys(existing[otherKey]).length)
                            updated[otherKey] = existing[otherKey];
                        if (Object.keys(nextToolPaths).length) updated[platformKey] = nextToolPaths;
                        await cfg.update('simulation.toolPaths', updated, vscode.ConfigurationTarget.Global);
                        await cfg.update(
                            'simulation.toolsDirectory',
                            nextToolsDirectory,
                            vscode.ConfigurationTarget.Global
                        );
                    } catch (_) {}
                    return;
                }
                if (message.command === 'clearToolPaths') {
                    const platformKey = isLinuxSimulationContext(document.fileName) ? 'linux' : 'windows';
                    const otherKey = platformKey === 'linux' ? 'windows' : 'linux';
                    try {
                        const cfg = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
                        const existing = cfg.get('simulation.toolPaths', {}) || {};
                        const kept = existing[otherKey] ? { [otherKey]: existing[otherKey] } : {};
                        await cfg.update('simulation.toolPaths', kept, vscode.ConfigurationTarget.Global);
                        await cfg.update('simulation.toolsDirectory', null, vscode.ConfigurationTarget.Global);
                    } catch (_) {}
                    return;
                }
                if (message.command === 'browseToolPath') {
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        openLabel: 'Select executable',
                        title: 'Select tool executable',
                    });
                    if (picked && picked[0] && simulationPanel && simulationPanel.webview) {
                        simulationPanel.webview.postMessage({
                            command: 'toolPathBrowseResult',
                            path: picked[0].fsPath,
                        });
                    }
                    return;
                }
                if (message.command === 'browseToolsFolder') {
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        openLabel: 'Select folder',
                        title: 'Select tools folder',
                    });
                    if (picked && picked[0] && simulationPanel && simulationPanel.webview) {
                        simulationPanel.webview.postMessage({
                            command: 'toolsFolderBrowseResult',
                            path: picked[0].fsPath,
                        });
                    }
                    return;
                }
                if (message.command === 'runSingleStep') {
                    const doc = lastExpandedDoc;
                    if (!doc) {
                        postSimulationMessage({
                            command: 'simulationError',
                            error: 'No expanded document — run a full simulation first.',
                        });
                        return;
                    }
                    const {
                        stageIndex,
                        jobIndex,
                        stepIndex,
                        variableOverrides,
                        paramOverrides,
                        envVars,
                        buildCounter: msgCounter,
                    } = message;
                    const docStages = Array.isArray(doc.stages) ? doc.stages : [];
                    let targetStage = null,
                        targetJob = null,
                        targetStep = null;
                    if (docStages.length === 0 && Array.isArray(doc.jobs)) {
                        targetJob = (doc.jobs || [])[jobIndex];
                        if (targetJob) targetStep = (targetJob.steps || [])[stepIndex];
                    } else {
                        targetStage = docStages[stageIndex];
                        if (targetStage) {
                            targetJob = (targetStage.jobs || [])[jobIndex];
                            if (targetJob) targetStep = (targetJob.steps || [])[stepIndex];
                        }
                    }
                    if (!targetStep) {
                        postSimulationMessage({
                            command: 'simulationError',
                            error: `Step not found (stage=${stageIndex} job=${jobIndex} step=${stepIndex})`,
                        });
                        return;
                    }
                    postSimulationMessage({ command: 'simulationStarted' });
                    if (!simOutputChannel) simOutputChannel = vscode.window.createOutputChannel('Pipeline Simulation');
                    simOutputChannel.show(true);
                    try {
                        // Apply template parameter substitutions (old expanded value → new user value)
                        // so changes to compile-time params in the modal actually affect the script.
                        const paramSubs = Array.isArray(paramOverrides)
                            ? paramOverrides.filter((p) => p && p.oldValue !== p.newValue)
                            : [];
                        if (paramSubs.length > 0) {
                            const applyParamSubs = (val) => {
                                if (typeof val !== 'string') return val;
                                let result = val;
                                for (const { oldValue, newValue } of paramSubs) {
                                    if (oldValue) result = result.split(oldValue).join(newValue);
                                }
                                return result;
                            };
                            const walkParamSubs = (obj) => {
                                if (typeof obj === 'string') return applyParamSubs(obj);
                                if (Array.isArray(obj)) return obj.map(walkParamSubs);
                                if (obj && typeof obj === 'object') {
                                    const out = {};
                                    for (const [k, v] of Object.entries(obj)) out[k] = walkParamSubs(v);
                                    return out;
                                }
                                return obj;
                            };
                            targetStep = walkParamSubs(targetStep);
                        }
                        const mergedStepEnv = {
                            ...(targetStep.env || {}),
                            ...(envVars && typeof envVars === 'object' ? envVars : {}),
                        };
                        const stepWithEnv = { ...targetStep, env: mergedStepEnv };
                        const jobEntry = targetJob.deployment
                            ? {
                                  deployment: targetJob.deployment,
                                  displayName: targetJob.displayName || targetJob.deployment,
                                  variables: targetJob.variables,
                                  steps: [stepWithEnv],
                              }
                            : {
                                  job: targetJob.job || 'Job',
                                  displayName: targetJob.displayName || targetJob.job || 'Job',
                                  variables: targetJob.variables,
                                  steps: [stepWithEnv],
                              };
                        const singleStepDoc = {
                            stages: [
                                {
                                    stage: targetStage ? targetStage.stage || 'Stage' : 'Stage',
                                    displayName: targetStage
                                        ? targetStage.displayName || targetStage.stage || 'Stage'
                                        : 'Stage',
                                    jobs: [jobEntry],
                                },
                            ],
                        };
                        simOutputChannel.appendLine(
                            `[aps] runSingleStep: "${targetStep.displayName || targetStep.name || 'Step'}"`
                        );
                        const simWorkDir = _resolveSimulationWorkingDirectory(document, parserOptions);
                        const simOutRoot = simWorkDir.replace(/[\/\\]$/, '') + '/simulation';
                        const bcStr = parseBuildCounter(msgCounter);
                        const simulationConfig = getSimulationExecutionConfig(
                            message.toolPaths,
                            message.toolsDirectory
                        );
                        const stepVarOverrides =
                            variableOverrides && typeof variableOverrides === 'object' ? variableOverrides : {};
                        const results = runPipelineSimulation(singleStepDoc, {
                            workingDirectory: simWorkDir,
                            outputRoot: simOutRoot,
                            buildCounter: bcStr,
                            userVariables: stepVarOverrides,
                            executablePaths: simulationConfig.execPaths,
                            toolsDirectory: simulationConfig.toolsDirectory,
                            wslMountRoot: simulationConfig.wslMountRoot,
                        });
                        simOutputChannel.appendLine(
                            `[aps] runSingleStep complete — passed=${results.totalPassed} failed=${results.totalFailed}`
                        );
                        postSimulationMessage({
                            command: 'simulationResults',
                            results,
                            singleStep: true,
                            si: stageIndex,
                            ji: jobIndex,
                            ti: stepIndex,
                        });
                    } catch (err) {
                        simOutputChannel.appendLine(`[aps] runSingleStep ERROR: ${(err && err.stack) || err}`);
                        if (err && err.code === 'EPERM') {
                            const epermPath = (err.path || '').trim();
                            const epermMsg = epermPath
                                ? `Simulation failed: permission denied. Please remove the directory manually and try again: ${epermPath}`
                                : 'Simulation failed: permission denied. Please remove the simulation workspace directory manually and try again.';
                            vscode.window.showErrorMessage(epermMsg);
                        }
                        postSimulationMessage({
                            command: 'simulationError',
                            error: String((err && err.message) || err),
                        });
                    }
                    return;
                }
                if (message.command !== 'runSimulation') return;
                if (isSimulationRunning) return;

                const stages = Array.isArray(message.stages) && message.stages.length ? message.stages : undefined;
                const counterStr = parseBuildCounter(message.buildCounter);

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

                postSimulationMessage({ command: 'simulationStarted' });

                isSimulationRunning = true;

                if (!simOutputChannel) {
                    simOutputChannel = vscode.window.createOutputChannel('Pipeline Simulation');
                }
                simOutputChannel.appendLine(
                    `[aps] runSimulation started — stages=${JSON.stringify(stages !== undefined ? stages : 'all')} counter=${counterStr}`
                );
                if (userVariables['System.Debug'] === 'true') {
                    simOutputChannel.appendLine(
                        '[aps] Debug mode: System.Debug=true (SYSTEM_DEBUG=true will be set in script env)'
                    );
                }
                simOutputChannel.show(true);

                try {
                    const simWorkDir = _resolveSimulationWorkingDirectory(document, parserOptions);
                    const simOutRoot = simWorkDir.replace(/[/\\]$/, '') + '/simulation';
                    simOutputChannel.appendLine(`[aps] workDir=${simWorkDir}`);
                    const simulationConfig = getSimulationExecutionConfig(message.toolPaths, message.toolsDirectory);

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
                        executablePaths: simulationConfig.execPaths,
                        toolsDirectory: simulationConfig.toolsDirectory,
                        wslMountRoot: simulationConfig.wslMountRoot,
                    });
                    simOutputChannel.appendLine(
                        `[aps] simulation complete — passed=${results.totalPassed} failed=${results.totalFailed} skipped=${results.totalSkipped}`
                    );
                    postSimulationMessage({ command: 'simulationResults', results });
                    simOutputChannel.appendLine(`[aps] simulationResults posted`);
                } catch (err) {
                    simOutputChannel.appendLine(`[aps] ERROR: ${(err && err.stack) || err}`);
                    if (err && err.code === 'EPERM') {
                        const epermPath = (err.path || '').trim();
                        const epermMsg = epermPath
                            ? `Simulation failed: permission denied. Please remove the directory manually and try again: ${epermPath}`
                            : 'Simulation failed: permission denied. Please remove the simulation workspace directory manually and try again.';
                        vscode.window.showErrorMessage(epermMsg);
                    }
                    postSimulationMessage({
                        command: 'simulationError',
                        error: String((err && err.message) || err),
                    });
                } finally {
                    isSimulationRunning = false;
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
        const _settingsToolsDirectory = vscode.workspace
            .getConfiguration('azurePipelineStudio', document.uri)
            .get('simulation.toolsDirectory', null);
        const _settingsExecPaths = resolveExecPaths(_settingsExecPathsRaw, isLinuxSimulationContext(document.fileName));
        const _mergedToolPaths = Object.assign(
            {},
            _settingsExecPaths,
            _savedToolPaths && typeof _savedToolPaths === 'object' ? _savedToolPaths : {}
        );
        const savedVarsJson = _b64Encode(
            JSON.stringify({
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
                toolsDirectory: _settingsToolsDirectory,
            })
        );
        const expandedStepsJsonStr = JSON.stringify(
            stageTree.map((stage) =>
                (stage.jobs || []).map((job) =>
                    (job.steps || []).map((step) => {
                        const refs = scanStepForReferences(step.rawStep || step);
                        return {
                            label: step.label,
                            scriptContent: step.scriptContent || '',
                            taskName: step.taskName || '',
                            taskInputsJson: step.taskInputsJson || '{}',
                            stepEnv: step.stepEnv || {},
                            referencedRuntimeVars: refs.runtimeVars,
                            referencedCompileTimeVars: refs.compileTimeVars,
                            templateParams: step.templateParams || null,
                        };
                    })
                )
            )
        );
        const expandedStepsJson = _b64Encode(expandedStepsJsonStr);
        const originalSourceTextJson = _b64Encode(JSON.stringify(lastSimSourceText || ''));
        try {
            const _generatedHtml = _generateSimulationViewHtml(
                stageTree,
                document.fileName,
                topLevelParameterDefinitions,
                String(Date.now()),
                knownVarsJson,
                savedVarsJson,
                expandedStepsJson,
                originalSourceTextJson
            );
            const _dumpPath = os.tmpdir() + '/aps-debug.html';
            fs.writeFileSync(_dumpPath, _generatedHtml, 'utf8');
            console.log('[aps] HTML written to', _dumpPath, 'length=', _generatedHtml.length);
            simulationPanel.webview.html = _generatedHtml;
        } catch (htmlErr) {
            console.error('[aps] _generateSimulationViewHtml threw:', (htmlErr && htmlErr.stack) || htmlErr);
            vscode.window.showErrorMessage(
                `Pipeline Simulation failed to render: ${(htmlErr && htmlErr.message) || htmlErr}`
            );
        }
    };

    const showSimulationViewDisposable = vscode.commands.registerCommand(
        'azurePipelineStudio.showSimulationView',
        async () => {
            try {
                const editor = vscode.window.activeTextEditor;
                if (!editor || !shouldRenderDocument(editor.document)) {
                    vscode.window.showInformationMessage(
                        'Open an Azure Pipeline YAML file to launch the simulation view.'
                    );
                    return;
                }
                await openSimulationView(editor.document);
            } catch (cmdErr) {
                vscode.window.showErrorMessage(
                    `Pipeline Simulation failed to open: ${(cmdErr && cmdErr.message) || cmdErr}`
                );
            }
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

        // Pre-parse resources.repositories upfront so the alias picker opens
        // immediately — no parse delay after the user clicks 'Add new entry'.
        const configuredAliases = new Set(existingEntries.map(getRepositoryAlias).filter(Boolean));
        let yamlRepos = [];
        try {
            const YAML = require('yaml');
            const parsedTopLevel = YAML.parse(targetDocument.getText());
            if (parsedTopLevel && parsedTopLevel.resources && Array.isArray(parsedTopLevel.resources.repositories)) {
                yamlRepos = parsedTopLevel.resources.repositories.filter(
                    (r) =>
                        typeof r.repository === 'string' &&
                        r.repository.trim() &&
                        !configuredAliases.has(r.repository.trim())
                );
            }
        } catch (_) {}
        const isWindowsStylePath = (p) => typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p));
        const canUseAsDefaultUri = (p) => !!p && (process.platform === 'win32' || !isWindowsStylePath(p));

        let alias = typeof initialAlias === 'string' && initialAlias.trim().length ? initialAlias.trim() : undefined;
        let existingEntry;

        if (alias) {
            existingEntry = existingEntries.find((entry) => getRepositoryAlias(entry) === alias);
        } else {
            // Build a single multi-select picker: existing entries + YAML resources + manual option.
            // This means the user sees every available resource immediately — no 'Add new' click needed.
            const quickPickItems = [];
            for (const entry of existingEntries) {
                const entryAlias = getRepositoryAlias(entry);
                if (!entryAlias) continue;
                const osPath = !isLinuxSimulationContext(targetDocument.fileName)
                    ? pickFirstString(entry.windowsPath, entry.path, entry.location)
                    : pickFirstString(entry.linuxPath, entry.path, entry.location);
                quickPickItems.push({
                    label: entryAlias,
                    description: osPath || pickFirstString(entry.path, entry.location) || '',
                    entry,
                });
            }
            if (yamlRepos.length > 0) {
                if (quickPickItems.length > 0) {
                    quickPickItems.push({ label: 'Pipeline resources', kind: vscode.QuickPickItemKind.Separator });
                }
                for (const repo of yamlRepos) {
                    quickPickItems.push({
                        label: repo.repository.trim(),
                        description: [repo.type, repo.name].filter(Boolean).join(' \u00b7 '),
                        newEntry: true,
                    });
                }
            }
            quickPickItems.push({
                label: '$(edit) Enter alias manually\u2026',
                description: 'Type a repository alias or name',
                manualEntry: true,
                newEntry: true,
            });

            const selections = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: 'Select repository resource(s) to configure',
                canPickMany: true,
                ignoreFocusOut: true,
            });
            if (!selections || selections.length === 0) {
                return;
            }

            // Resolve the alias list from selections.
            const aliasesToConfigure = [];
            for (const sel of selections) {
                if (sel.manualEntry) {
                    const inputAlias = await vscode.window.showInputBox({
                        prompt: 'Repository alias or name',
                        placeHolder: 'Name given under resources.repositories[].repository',
                        ignoreFocusOut: true,
                    });
                    if (inputAlias && inputAlias.trim()) {
                        aliasesToConfigure.push({ alias: inputAlias.trim(), existingEntry: undefined });
                    }
                } else {
                    aliasesToConfigure.push({ alias: sel.label, existingEntry: sel.entry });
                }
            }
            if (aliasesToConfigure.length === 0) {
                return;
            }

            if (aliasesToConfigure.length === 1) {
                // Single selection: fall through to the shared location-picking code.
                alias = aliasesToConfigure[0].alias;
                existingEntry =
                    aliasesToConfigure[0].existingEntry || existingEntries.find((e) => getRepositoryAlias(e) === alias);
            } else {
                // Multiple selections: configure each sequentially, save all at once, return.
                const isLinux = isLinuxSimulationContext(targetDocument.fileName);
                let currentEntries = [...existingEntries];
                for (const { alias: a, existingEntry: existingForA } of aliasesToConfigure) {
                    const existingE = existingForA || currentEntries.find((e) => getRepositoryAlias(e) === a);
                    const curLoc = existingE
                        ? !isLinux
                            ? pickFirstString(existingE.windowsPath, existingE.path, existingE.location)
                            : pickFirstString(existingE.linuxPath, existingE.path, existingE.location)
                        : undefined;
                    const mChoice = await vscode.window.showQuickPick(
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
                        { placeHolder: `Configure location for '${a}'`, ignoreFocusOut: true }
                    );
                    if (!mChoice) {
                        continue;
                    }
                    let loc;
                    if (mChoice.method === 'browse') {
                        const folderUri = await vscode.window.showOpenDialog({
                            canSelectFiles: false,
                            canSelectFolders: true,
                            canSelectMany: false,
                            openLabel: `Select location for '${a}'`,
                            defaultUri: canUseAsDefaultUri(curLoc) ? vscode.Uri.file(curLoc) : undefined,
                        });
                        if (!folderUri || folderUri.length === 0) {
                            continue;
                        }
                        loc = folderUri[0].fsPath;
                    } else {
                        loc = await vscode.window.showInputBox({
                            prompt: `Local path for repository '${a}'`,
                            placeHolder: '${workspaceFolder}/path/to/templates',
                            value: canUseAsDefaultUri(curLoc) ? curLoc : '',
                            ignoreFocusOut: true,
                        });
                        if (!loc || !loc.trim()) {
                            continue;
                        }
                    }
                    const sanitized = loc.trim();
                    let updatedInLoop = false;
                    currentEntries = currentEntries.map((entry) => {
                        if (getRepositoryAlias(entry) !== a) return { ...entry };
                        updatedInLoop = true;
                        const cloned = { ...entry, repository: a };
                        if (!isLinux) {
                            cloned.windowsPath = sanitized;
                            delete cloned.windowsLocation;
                        } else {
                            cloned.linuxPath = toSimulatorPath(sanitized);
                            delete cloned.linuxLocation;
                        }
                        if (!cloned.path || !cloned.path.trim()) cloned.path = sanitized;
                        delete cloned.location;
                        return cloned;
                    });
                    if (!updatedInLoop) {
                        currentEntries.push(
                            !isLinux
                                ? { repository: a, path: sanitized, windowsPath: sanitized }
                                : {
                                      repository: a,
                                      path: toSimulatorPath(sanitized),
                                      linuxPath: toSimulatorPath(sanitized),
                                  }
                        );
                    }
                }
                try {
                    await config.update('resourceLocations', currentEntries, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('Repository location(s) saved.');
                    await renderYamlDocument(targetDocument);
                } catch (error) {
                    console.error('[Azure Pipeline Studio] Error saving repository location:', error);
                    vscode.window.showErrorMessage(`Failed to save repository location: ${error.message}`);
                }
                return;
            }
        }
        if (!alias) {
            return;
        }

        if (!existingEntry) {
            existingEntry = existingEntries.find((entry) => getRepositoryAlias(entry) === alias);
        }

        const currentLocation = existingEntry
            ? !isLinuxSimulationContext(targetDocument.fileName)
                ? pickFirstString(existingEntry.windowsPath, existingEntry.path, existingEntry.location)
                : pickFirstString(existingEntry.linuxPath, existingEntry.path, existingEntry.location)
            : undefined;
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
                defaultUri: canUseAsDefaultUri(currentLocation) ? vscode.Uri.file(currentLocation) : undefined,
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
                value: canUseAsDefaultUri(currentLocation) ? currentLocation : '',
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
                const cloned = { ...entry, repository: alias };
                if (!isLinuxSimulationContext(targetDocument.fileName)) {
                    cloned.windowsPath = sanitizedLocation;
                    delete cloned.windowsLocation;
                } else {
                    cloned.linuxPath = toSimulatorPath(sanitizedLocation);
                    delete cloned.linuxLocation;
                }
                if (!cloned.path || !cloned.path.trim()) {
                    cloned.path = sanitizedLocation;
                }
                delete cloned.location;
                updatedEntries.push(cloned);
                updated = true;
            } else {
                updatedEntries.push({ ...entry });
            }
        });

        if (!updated) {
            updatedEntries.push(
                !isLinuxSimulationContext(targetDocument.fileName)
                    ? { repository: alias, path: sanitizedLocation, windowsPath: sanitizedLocation }
                    : {
                          repository: alias,
                          path: toSimulatorPath(sanitizedLocation),
                          linuxPath: toSimulatorPath(sanitizedLocation),
                      }
            );
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetDocument.uri);
        const target = vscode.ConfigurationTarget.Global;

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
        vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
            if (isRelevantDocument(document)) {
                scheduleRender(document, 500);
            }
            if (simulationPanel && lastSimDocument && lastSimDocument.fileName === document.fileName) {
                if (contentChanges.length === 0 || isSimulationRunning) return;
                clearTimeout(simulationDebounceTimer);
                simulationDebounceTimer = setTimeout(() => {
                    if (!isSimulationRunning && simulationPanel && simulationPanel.webview) {
                        simulationPanel.webview.postMessage({ command: 'triggerRerun' });
                    }
                }, 500);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            // Diagram panel refresh: runs independently of expansion panel
            scheduleDependenciesRefresh(document, 0);
            if (isRelevantDocument(document)) {
                const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
                if (config.get('refreshOnSave', true)) {
                    scheduleRender(document, 0);
                }
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

    // Dispose of simulation panel if still open
    if (activeSimulationPanel) {
        try {
            activeSimulationPanel.dispose();
        } catch (e) {
            // Panel may already be disposed, ignore
        }
        activeSimulationPanel = null;
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

// ============================================================================
// CLI COMMAND HANDLERS
// ============================================================================

/**
 * Handle CLI command: getscriptinfo
 * Get compile-time parameters, runtime variables, and environment for a specific step
 * Usage: node extension.js getscriptinfo -stage 1 -job 2 -step 4 ./pipelines/ci.yaml
 */
/**
 * Shared argument parser for all step/list CLI commands.
 * Handles -stage, -job, -step, --template <path>, --resource alias=path (-r), --input JSON,
 * and the first non-flag positional as filePath.
 */
function _parseStepCommandArgs(args) {
    const result = {
        stageNum: null,
        jobNum: null,
        stepNum: null,
        filePath: null,
        inputJson: null,
        resourceLocations: {},
        debugMode: false,
        verbose: false,
        xtrace: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-stage' && i + 1 < args.length) {
            result.stageNum = parseInt(args[++i], 10);
        } else if (a === '-job' && i + 1 < args.length) {
            result.jobNum = parseInt(args[++i], 10);
        } else if (a === '-step' && i + 1 < args.length) {
            result.stepNum = parseInt(args[++i], 10);
        } else if (a === '--input' && i + 1 < args.length) {
            result.inputJson = args[++i];
        } else if (a === '--template' && i + 1 < args.length) {
            result.resourceLocations['templates'] = args[++i];
        } else if ((a === '--resource' || a === '-r' || a === '--repo') && i + 1 < args.length) {
            const val = args[++i];
            const eq = val.indexOf('=');
            if (eq > 0) result.resourceLocations[val.substring(0, eq).trim()] = val.substring(eq + 1);
        } else if (a === '--debug' || a === '-d') {
            result.debugMode = true;
        } else if (a === '--xtrace' || a === '-x') {
            result.xtrace = true;
        } else if (a === '--verbose' || a === '-V') {
            result.verbose = true;
        } else if (!a.startsWith('-') && !result.filePath) {
            result.filePath = a;
        }
    }
    return result;
}

function handleGetScriptInfo(args) {
    const { stageNum, jobNum, stepNum, filePath, resourceLocations } = _parseStepCommandArgs(args);

    if (!filePath || stageNum === null || jobNum === null || stepNum === null) {
        return { error: 'Usage: getscriptinfo -stage N -job N -step N <filepath>' };
    }

    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
        return { error: `File not found: ${filePath}` };
    }

    try {
        const yamlContent = fs.readFileSync(filePath, 'utf8');
        const parser = new AzurePipelineParser();
        const { document: expandedDoc } = parser.expandPipeline(yamlContent, {
            baseDir: path.dirname(path.resolve(filePath)),
            ...(Object.keys(resourceLocations).length && { resourceLocations }),
        });

        if (!expandedDoc) {
            return { error: 'Could not parse YAML document' };
        }

        // Get step hierarchy (1-based indexing from user)
        const tree = extractSimulationTree(expandedDoc);
        const stage = tree[stageNum - 1];

        if (!stage) {
            return { error: `Stage ${stageNum} not found` };
        }

        const job = stage.jobs[jobNum - 1];
        if (!job) {
            return { error: `Job ${jobNum} not found in stage ${stageNum}` };
        }

        const step = job.steps[stepNum - 1];
        if (!step) {
            return { error: `Step ${stepNum} not found in job ${jobNum}` };
        }

        const { verbose } = _parseStepCommandArgs(args);
        const rawStep = step.rawStep || step;

        // Expand the source template file directly with placeholder params to get
        // rawScriptContent with ${{ parameters.NAME }} expressions preserved.
        let rawScriptContent = null;
        const templateFile = step.templateFile || (step.rawStep && step.rawStep.__templateFile) || null;
        const templateParamDefs = step.templateParams || (step.rawStep && step.rawStep.__templateParams) || null;
        if (templateFile && templateParamDefs && fs.existsSync(templateFile)) {
            try {
                const templateSource = fs.readFileSync(templateFile, 'utf8');
                const placeholderParams = {};
                templateParamDefs.forEach((p) => {
                    placeholderParams[p.name] = '__param_' + p.name + '__';
                });
                const rawParser = new AzurePipelineParser();
                const { document: rawDoc } = rawParser.expandPipeline(templateSource, {
                    baseDir: path.dirname(templateFile),
                    parameters: placeholderParams,
                    skipSyntax: true,
                });
                if (rawDoc) {
                    // steps-only template: extract steps directly from top-level steps key
                    const rawSteps = Array.isArray(rawDoc.steps) ? rawDoc.steps : [];
                    for (const rawStepNode of rawSteps) {
                        const rawScript = String(
                            rawStepNode.bash ||
                                rawStepNode.script ||
                                rawStepNode.pwsh ||
                                rawStepNode.powershell ||
                                (rawStepNode.inputs && rawStepNode.inputs.script) ||
                                ''
                        );
                        if (
                            rawScript &&
                            (rawStepNode.displayName === step.label ||
                                (rawStepNode.name === step.rawStep && step.rawStep.name))
                        ) {
                            rawScriptContent = rawScript.replace(
                                /__param_(\w+)__/g,
                                (_, name) => '${{ parameters.' + name + ' }}'
                            );
                            break;
                        }
                    }
                    // Fallback: first step with script content matching the type
                    if (!rawScriptContent) {
                        for (const rawStepNode of rawSteps) {
                            const rawScript = String(
                                rawStepNode.bash ||
                                    rawStepNode.script ||
                                    rawStepNode.pwsh ||
                                    rawStepNode.powershell ||
                                    (rawStepNode.inputs && rawStepNode.inputs.script) ||
                                    ''
                            );
                            if (rawScript) {
                                rawScriptContent = rawScript.replace(
                                    /__param_(\w+)__/g,
                                    (_, name) => '${{ parameters.' + name + ' }}'
                                );
                                break;
                            }
                        }
                    }
                }
            } catch (_) {
                /* fall back to null */
            }
        }

        // Derive referencedParameters from rawScriptContent; use templateParamDefs for parameterDefinitions.
        const templateParamDefs2 = (step.rawStep && step.rawStep.__templateParams) || [];
        const referencedParamNames = new Set();
        if (rawScriptContent) {
            for (const m of rawScriptContent.matchAll(/\$\{\{\s*parameters\.(\w+)\s*\}\}/g))
                referencedParamNames.add(m[1]);
        }
        const fallbackRefs = scanStepForReferences(rawStep);
        const parameterDefinitions = templateParamDefs2.map((p) => ({
            name: p.name,
            type: p.type || p.paramType || 'string',
            default: p.default !== undefined ? p.default : p.defaultValue,
            isReferenced: referencedParamNames.has(p.name),
        }));

        return {
            success: true,
            stage: stageNum,
            job: jobNum,
            step: stepNum,
            stepLabel: step.label,
            stepType: step.type,
            taskName: step.taskName || null,
            scriptContent: step.scriptContent || null,
            rawScriptContent,
            taskInputs: step.taskInputsJson ? JSON.parse(step.taskInputsJson) : {},
            referencedParameters: Array.from(referencedParamNames),
            referencedCompileTimeVariables: fallbackRefs.compileTimeVars,
            referencedRuntimeVariables: fallbackRefs.runtimeVars,
            stepEnvironment: step.stepEnv || {},
            parameterDefinitions,
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Handle CLI command: runscript
 * Execute a step/script with provided variables and parameters
 * Usage: node extension.js runscript -stage 1 -job 2 -step 4 ./pipelines/ci.yaml --input '{"parameters":{},"variables":{},...}'
 */
function handleRunScript(args) {
    const { stageNum, jobNum, stepNum, filePath, inputJson, resourceLocations, debugMode, xtrace } =
        _parseStepCommandArgs(args);

    if (!filePath || stageNum === null || jobNum === null || stepNum === null) {
        return { error: 'Usage: runscript -stage N -job N -step N <filepath> [--input JSON]' };
    }

    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
        return { error: `File not found: ${filePath}` };
    }

    try {
        const yamlContent = fs.readFileSync(filePath, 'utf8');
        const parser = new AzurePipelineParser();
        const { document: expandedDoc } = parser.expandPipeline(yamlContent, {
            baseDir: path.dirname(path.resolve(filePath)),
            ...(Object.keys(resourceLocations).length && { resourceLocations }),
        });

        if (!expandedDoc) {
            return { error: 'Could not parse YAML document' };
        }

        // Get step (1-based indexing)
        const tree = extractSimulationTree(expandedDoc);
        const stage = tree[stageNum - 1];
        if (!stage) {
            return { error: `Stage ${stageNum} not found` };
        }

        const job = stage.jobs[jobNum - 1];
        if (!job) {
            return { error: `Job ${jobNum} not found in stage ${stageNum}` };
        }

        const step = job.steps[stepNum - 1];
        if (!step) {
            return { error: `Step ${stepNum} not found in job ${jobNum}` };
        }

        // Parse input overrides if provided
        let overrides = {};
        if (inputJson) {
            try {
                overrides = JSON.parse(inputJson);
            } catch (e) {
                return { error: `Invalid JSON in --input: ${e.message}` };
            }
        }

        // CLI convenience mode: allow only two top-level sections like the UI.
        // - parameters: template parameter overrides
        // - variables: both compile-time (Build./System./Agent./Pipeline.) and runtime vars
        const normalizedOverrides = {
            ...overrides,
            compileTimeVariables:
                overrides && overrides.compileTimeVariables && typeof overrides.compileTimeVariables === 'object'
                    ? { ...overrides.compileTimeVariables }
                    : {},
            runtimeVariables:
                overrides && overrides.runtimeVariables && typeof overrides.runtimeVariables === 'object'
                    ? { ...overrides.runtimeVariables }
                    : {},
        };
        if (overrides && overrides.variables && typeof overrides.variables === 'object') {
            Object.entries(overrides.variables).forEach(([key, value]) => {
                const varName = String(key || '').trim();
                if (!varName) return;
                if (/^(Build|System|Agent|Pipeline)\./.test(varName)) {
                    if (normalizedOverrides.compileTimeVariables[varName] === undefined) {
                        normalizedOverrides.compileTimeVariables[varName] = value;
                    }
                } else if (/^variables?\./i.test(varName)) {
                    const bareVarName = varName.replace(/^variables?\./i, '').trim();
                    if (bareVarName && normalizedOverrides.compileTimeVariables[bareVarName] === undefined) {
                        normalizedOverrides.compileTimeVariables[bareVarName] = value;
                    }
                    if (normalizedOverrides.compileTimeVariables[varName] === undefined) {
                        normalizedOverrides.compileTimeVariables[varName] = value;
                    }
                } else if (normalizedOverrides.runtimeVariables[varName] === undefined) {
                    normalizedOverrides.runtimeVariables[varName] = value;
                }
            });
        }
        if (debugMode) {
            normalizedOverrides.compileTimeVariables['System.Debug'] = 'true';
        }

        // Get the original step definition (not the processed one from extractSimulationTree)
        const rawStep = step.rawStep || step;

        // If this step came from a template file and parameters were overridden,
        // re-expand the template with the actual parameter values so ${{ parameters.xxx }}
        // is substituted correctly instead of using the pipeline's expanded values.
        let rawScriptOverride = null;
        const tmplFile = rawStep.__templateFile || null;
        const tmplParamDefs = rawStep.__templateParams || null;
        const paramOverrides =
            overrides && overrides.parameters && typeof overrides.parameters === 'object' ? overrides.parameters : null;
        if (tmplFile && tmplParamDefs && paramOverrides && fs.existsSync(tmplFile)) {
            try {
                const tmplSource = fs.readFileSync(tmplFile, 'utf8');
                const tmplParams = {};
                tmplParamDefs.forEach((p) => {
                    tmplParams[p.name] =
                        paramOverrides[p.name] !== undefined
                            ? String(paramOverrides[p.name])
                            : p.default !== undefined
                              ? String(p.default)
                              : '';
                });
                const tmplParser = new AzurePipelineParser();
                const { document: tmplDoc } = tmplParser.expandPipeline(tmplSource, {
                    baseDir: path.dirname(tmplFile),
                    parameters: tmplParams,
                    skipSyntax: true,
                });
                if (tmplDoc && Array.isArray(tmplDoc.steps)) {
                    for (const tmplStep of tmplDoc.steps) {
                        const s = String(
                            tmplStep.bash ||
                                tmplStep.script ||
                                tmplStep.pwsh ||
                                tmplStep.powershell ||
                                (tmplStep.inputs && tmplStep.inputs.script) ||
                                ''
                        );
                        if (s && tmplStep.displayName === step.label) {
                            rawScriptOverride = s;
                            break;
                        }
                    }
                    if (!rawScriptOverride) {
                        for (const tmplStep of tmplDoc.steps) {
                            const s = String(
                                tmplStep.bash ||
                                    tmplStep.script ||
                                    tmplStep.pwsh ||
                                    tmplStep.powershell ||
                                    (tmplStep.inputs && tmplStep.inputs.script) ||
                                    ''
                            );
                            if (s) {
                                rawScriptOverride = s;
                                break;
                            }
                        }
                    }
                }
            } catch (_) {
                /* fall back to expanded script */
            }
        }

        // Get parameters
        const params = extractTopLevelParameterDefinitions(parser, yamlContent, true);

        // Prepare step test inputs with overrides using raw step
        const stepInputs = prepareStepUnitTest(rawStep, expandedDoc, params, normalizedOverrides);

        // Resolve script content — prefer prepareStepUnitTest result, then fall back to
        // inline task scripts (Bash@3, PowerShell@2, CmdLine@2, etc. with targetType: inline)
        let resolvedScript = rawScriptOverride || (stepInputs && stepInputs.resolvedScriptContent);
        let taskShell = null;

        if (!resolvedScript && step.taskName && step.taskInputsJson) {
            const taskInputs = JSON.parse(step.taskInputsJson);
            if ((taskInputs.targetType === 'inline' || !taskInputs.targetType) && taskInputs.script) {
                resolvedScript = rawScriptOverride || taskInputs.script;
                const taskLower = step.taskName.toLowerCase();
                taskShell =
                    taskLower.startsWith('powershell') || taskLower.startsWith('azurepowershell') ? 'pwsh' : 'bash';
            }
        }

        if (!resolvedScript) {
            return {
                error: `Step ${stepNum} has no executable script content (type: ${step.type}, task: ${step.taskName || 'n/a'}).`,
                info: stepInputs,
            };
        }

        // Reuse the simulator's shell execution engine so CLI runscript and UI simulation
        // execute scripts with the same shell fallback, shims, and output behavior.
        const resolveEnvMacros = (value, lookup) => {
            const raw = String(value === undefined || value === null ? '' : value);
            return raw.replace(/\$\(([^)]+)\)/g, (full, name) => {
                const key = String(name || '').trim();
                if (!key) return full;
                if (lookup[key] !== undefined && lookup[key] !== null) {
                    return String(lookup[key]);
                }
                return full;
            });
        };

        const resolveScriptMacros = (scriptText, lookup) => {
            const raw = String(scriptText === undefined || scriptText === null ? '' : scriptText);
            // Azure macro variables use $(Var.Name). Replace only identifier-like tokens so
            // unresolved or non-variable shell constructs remain untouched.
            return raw.replace(/\$\(([A-Za-z_][A-Za-z0-9_.-]*)\)/g, (full, name) => {
                const key = String(name || '').trim();
                if (!key) return full;
                if (lookup[key] !== undefined && lookup[key] !== null) {
                    return String(lookup[key]);
                }
                return full;
            });
        };

        const macroLookup = {
            ...(stepInputs && stepInputs.compileTimeVariableValues ? stepInputs.compileTimeVariableValues : {}),
            ...(stepInputs && stepInputs.runtimeVariableValues ? stepInputs.runtimeVariableValues : {}),
        };

        const executableScript = resolveScriptMacros(resolvedScript, macroLookup);
        let executionVariables = {
            ...(stepInputs && stepInputs.compileTimeVariableValues ? stepInputs.compileTimeVariableValues : {}),
            ...(stepInputs && stepInputs.runtimeVariableValues ? stepInputs.runtimeVariableValues : {}),
        };
        const stepExtraEnv = {};

        // Add step environment variables
        if (stepInputs && stepInputs.stepEnvironment) {
            Object.entries(stepInputs.stepEnvironment).forEach(([key, value]) => {
                stepExtraEnv[key] = resolveEnvMacros(value, macroLookup);
            });
        }

        // Map variable names to Azure-style environment keys.
        const toEnvKey = (k) => k.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

        // Execute the script
        try {
            let script = executableScript;

            // Detect shell type: explicit step type takes priority, then task-inferred, then bash
            const shell = step.type === 'powershell' || step.type === 'pwsh' ? 'pwsh' : taskShell || 'bash';

            // In debug mode, force xtrace if not already present at top level.
            // In xtrace mode, always prepend (user explicitly requested it).
            if (shell === 'bash') {
                if (xtrace) {
                    script = `set -x\n${script}`;
                } else if (debugMode) {
                    const hasSetX = /(^|\n)\s*set\s+-[^\n]*x\b/.test(script);
                    if (!hasSetX) script = `set -x\n${script}`;
                }
                if (debugMode || xtrace) {
                    script = `echo "[APS] scriptCwd=$PWD" >&2\necho "[APS] OUTPUT_FILE=${stepExtraEnv['OUTPUT_FILE'] || process.env.OUTPUT_FILE || '(unset)'}" >&2\n${script}`;
                }
            }

            const mergeOutput = (stdoutText, stderrText, includeStderr) => {
                const stdoutValue = String(stdoutText || '');
                const stderrValue = String(stderrText || '');
                if (!includeStderr) {
                    return stdoutValue.trim();
                }
                if (stderrValue && stdoutValue) {
                    return `${stderrValue}${stderrValue.endsWith('\n') ? '' : '\n'}${stdoutValue}`.trim();
                }
                return (stderrValue || stdoutValue).trim();
            };

            // Pick a working directory and always publish it as Build.SourcesDirectory.
            const scriptCwd = (() => {
                const pipelineDir = path.dirname(path.resolve(filePath));
                const setBuildSourcesDirectory = (dirPath) => {
                    executionVariables['Build.SourcesDirectory'] = dirPath;
                    executionVariables['BUILD_SOURCESDIRECTORY'] = dirPath;
                    return dirPath;
                };
                // Only honour Build.SourcesDirectory when the user explicitly supplied it in
                // --input, not when it was auto-populated from compile-time defaults.
                const userSourcesDir =
                    normalizedOverrides.compileTimeVariables &&
                    (normalizedOverrides.compileTimeVariables['Build.SourcesDirectory'] ||
                        normalizedOverrides.compileTimeVariables['BUILD_SOURCESDIRECTORY']);
                if (userSourcesDir) {
                    const resolved = path.resolve(String(userSourcesDir));
                    if (fs.existsSync(resolved)) return setBuildSourcesDirectory(resolved);
                }
                // If the user is running from a directory other than the pipeline dir, they
                // intentionally navigated there (e.g. an artifact staging directory with DLLs).
                const processCwd = process.cwd();
                if (path.resolve(processCwd) !== path.resolve(pipelineDir)) {
                    return setBuildSourcesDirectory(processCwd);
                }
                // Auto-detect a prior --simulate run: use artifacts/bins if it exists so that
                // steps like CreateBinaryFileList can find the build outputs without manual flags.
                const simBinsDir = path.join(pipelineDir, 'simulation', 'artifacts', 'bins');
                if (fs.existsSync(simBinsDir)) {
                    return setBuildSourcesDirectory(simBinsDir);
                }
                return setBuildSourcesDirectory(pipelineDir);
            })();

            // Seed baseline Azure variables for CLI runscript, then preserve explicit
            // step/user overrides gathered above.
            const defaultExecutionVariables = buildSimulationDefaultVariables(
                scriptCwd,
                path.join(scriptCwd, 'simulation'),
                '1',
                {}
            );
            executionVariables = {
                ...defaultExecutionVariables,
                ...executionVariables,
            };

            const simulatorExecutor = new PipelineSimulator({
                debugScript: debugMode || xtrace,
                executablePaths: {},
            });
            const execResult = simulatorExecutor.executePreparedStep(
                shell,
                script,
                executionVariables,
                scriptCwd,
                stepExtraEnv,
                step.label || `Stage ${stageNum} Job ${jobNum} Step ${stepNum}`
            );

            const stdout = String(execResult.stdout || '');
            const stderr = String(execResult.stderr || '');
            const outputText = mergeOutput(stdout, stderr, debugMode || xtrace);
            const exitCode = Number.isInteger(execResult.exitCode) ? execResult.exitCode : 1;

            if (exitCode !== 0) {
                return {
                    success: false,
                    stage: stageNum,
                    job: jobNum,
                    step: stepNum,
                    stepLabel: step.label,
                    error: `Script execution failed (exit code ${exitCode})`,
                    exitCode,
                    output: outputText,
                    inputsUsed: {
                        parameters: (stepInputs && stepInputs.parameterValues) || {},
                        compileTimeVariables: (stepInputs && stepInputs.compileTimeVariableValues) || {},
                        runtimeVariables: (stepInputs && stepInputs.runtimeVariableValues) || {},
                        environment: { ...executionVariables, ...stepExtraEnv },
                    },
                };
            }

            return {
                success: true,
                stage: stageNum,
                job: jobNum,
                step: stepNum,
                stepLabel: step.label,
                stepType: step.type,
                scriptExecuted: true,
                output: outputText,
                inputsUsed: {
                    parameters: (stepInputs && stepInputs.parameterValues) || {},
                    compileTimeVariables: (stepInputs && stepInputs.compileTimeVariableValues) || {},
                    runtimeVariables: (stepInputs && stepInputs.runtimeVariableValues) || {},
                    environment: { ...executionVariables, ...stepExtraEnv },
                },
            };
        } catch (error) {
            return { error: error.message };
        }
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Handle CLI command: liststages
 * Usage: node extension.js liststages [--template <path>] [-r/--resource alias=path] <filepath>
 */
function handleListStages(args) {
    const { filePath, resourceLocations } = _parseStepCommandArgs(args);
    if (!filePath) return { error: 'Usage: liststages [--template <path>] [-r/--resource alias=path] <filepath>' };
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    try {
        const yamlContent = fs.readFileSync(filePath, 'utf8');
        const parser = new AzurePipelineParser();
        const { document: expandedDoc } = parser.expandPipeline(yamlContent, {
            baseDir: path.dirname(path.resolve(filePath)),
            ...(Object.keys(resourceLocations).length && { resourceLocations }),
        });
        if (!expandedDoc) return { error: 'Could not parse YAML document' };
        const tree = extractSimulationTree(expandedDoc);
        return {
            success: true,
            stages: tree.map((stage, i) => ({
                number: i + 1,
                name: stage.name,
                displayName: stage.displayName,
                jobCount: (stage.jobs || []).length,
            })),
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Handle CLI command: listjobs
 * Usage: node extension.js listjobs -stage N [-r/--resource alias=path] <filepath>
 */
function handleListJobs(args) {
    const { stageNum, filePath, resourceLocations } = _parseStepCommandArgs(args);
    if (!filePath || stageNum === null)
        return { error: 'Usage: listjobs -stage N [--template <path>] [-r/--resource alias=path] <filepath>' };
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    try {
        const yamlContent = fs.readFileSync(filePath, 'utf8');
        const parser = new AzurePipelineParser();
        const { document: expandedDoc } = parser.expandPipeline(yamlContent, {
            baseDir: path.dirname(path.resolve(filePath)),
            ...(Object.keys(resourceLocations).length && { resourceLocations }),
        });
        if (!expandedDoc) return { error: 'Could not parse YAML document' };
        const tree = extractSimulationTree(expandedDoc);
        const stage = tree[stageNum - 1];
        if (!stage) return { error: `Stage ${stageNum} not found (total: ${tree.length})` };
        return {
            success: true,
            stage: stageNum,
            stageName: stage.displayName,
            jobs: (stage.jobs || []).map((job, i) => ({
                number: i + 1,
                name: job.name,
                displayName: job.displayName,
                stepCount: (job.steps || []).length,
            })),
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Handle CLI command: listpipeline
 * Usage: node extension.js listpipeline [-r/--resource alias=path] <filepath>
 */
function handleListPipeline(args) {
    const { filePath, resourceLocations } = _parseStepCommandArgs(args);
    if (!filePath) return { error: 'Usage: listpipeline [-r/--resource alias=path] <filepath>' };
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    try {
        const yamlContent = fs.readFileSync(filePath, 'utf8');
        const parser = new AzurePipelineParser();
        const { document: expandedDoc } = parser.expandPipeline(yamlContent, {
            baseDir: path.dirname(path.resolve(filePath)),
            ...(Object.keys(resourceLocations).length && { resourceLocations }),
        });
        if (!expandedDoc) return { error: 'Could not parse YAML document' };
        const tree = extractSimulationTree(expandedDoc);
        return {
            success: true,
            stages: tree.map((stage, si) => ({
                number: si + 1,
                name: stage.name,
                displayName: stage.displayName,
                jobs: (stage.jobs || []).map((job, ji) => ({
                    number: ji + 1,
                    name: job.name,
                    displayName: job.displayName,
                    steps: (job.steps || []).map((step, ti) => ({
                        number: ti + 1,
                        label: step.label,
                        type: step.type,
                    })),
                })),
            })),
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Handle CLI command: liststeps
 * Usage: node extension.js liststeps -stage N -job N [-r/--resource alias=path] <filepath>
 */
function handleListSteps(args) {
    const { stageNum, jobNum, filePath, resourceLocations } = _parseStepCommandArgs(args);
    if (!filePath || stageNum === null || jobNum === null)
        return { error: 'Usage: liststeps -stage N -job N [--template <path>] [-r/--resource alias=path] <filepath>' };
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    try {
        const yamlContent = fs.readFileSync(filePath, 'utf8');
        const parser = new AzurePipelineParser();
        const { document: expandedDoc } = parser.expandPipeline(yamlContent, {
            baseDir: path.dirname(path.resolve(filePath)),
            ...(Object.keys(resourceLocations).length && { resourceLocations }),
        });
        if (!expandedDoc) return { error: 'Could not parse YAML document' };
        const tree = extractSimulationTree(expandedDoc);
        const stage = tree[stageNum - 1];
        if (!stage) return { error: `Stage ${stageNum} not found (total: ${tree.length})` };
        const job = (stage.jobs || [])[jobNum - 1];
        if (!job)
            return { error: `Job ${jobNum} not found in stage ${stageNum} (total: ${(stage.jobs || []).length})` };
        return {
            success: true,
            stage: stageNum,
            stageName: stage.displayName,
            job: jobNum,
            jobName: job.displayName,
            steps: (job.steps || []).map((step, i) => ({
                number: i + 1,
                label: step.label,
                type: step.type,
            })),
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Handle CLI command: extract-tree
 * Extracts and displays step hierarchy from a pipeline
 */
function handleExtractTree(filePath) {
    try {
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${filePath}` };
        }

        const yamlContent = fs.readFileSync(filePath, 'utf8');
        const parser = new AzurePipelineParser();
        const parseResult = parser.parseYamlDocument(yamlContent);

        if (!parseResult || !parseResult.jsonDoc) {
            return { error: 'Could not parse YAML document' };
        }

        const stages = extractSimulationTree(parseResult.jsonDoc);
        return {
            command: 'extract-tree',
            file: filePath,
            stages,
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Handle CLI command: extract-params
 * Extracts parameter definitions from a pipeline
 */
function handleExtractParams(filePath) {
    try {
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${filePath}` };
        }

        const yamlContent = fs.readFileSync(filePath, 'utf8');
        const parser = new AzurePipelineParser();
        const parameters = extractTopLevelParameterDefinitions(parser, yamlContent, true);

        return {
            command: 'extract-params',
            file: filePath,
            parameters,
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Handle CLI command: extract-vars
 * Extracts variables and variable groups from a pipeline
 */
function handleExtractVars(filePath) {
    try {
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${filePath}` };
        }

        const yamlContent = fs.readFileSync(filePath, 'utf8');
        const parser = new AzurePipelineParser();
        const parseResult = parser.parseYamlDocument(yamlContent);

        if (!parseResult || !parseResult.jsonDoc) {
            return { error: 'Could not parse YAML document' };
        }

        const { simple, groups } = extractPipelineVariables(parseResult.jsonDoc);
        return {
            command: 'extract-vars',
            file: filePath,
            simpleVariables: simple,
            libraryGroups: groups,
        };
    } catch (error) {
        return { error: error.message };
    }
}

// ============================================================================
// STEP INPUT ANALYSIS FOR UI AND TESTING
// ============================================================================

/**
 * Build a variable context object from a parsed pipeline document.
 * Returns { varMap, systemVars } for use in step input extraction.
 */
function buildVariableContext(document) {
    const { simple: pipelineVars } = extractPipelineVariables(document);
    const systemVars = buildSimulationDefaultVariables('.', '.', '1', {});
    const varMap = {};
    pipelineVars.forEach((v) => {
        varMap[v.name] = v.value;
    });
    return { varMap, systemVars };
}

/**
 * Get all inputs for a specific step for display/testing in UI
 * Finds which parameters and variables affect a particular step
 */
function getStepInputsForTesting(step, document, allParameters = []) {
    if (!step || !document) return null;
    const { varMap, systemVars } = buildVariableContext(document);
    return extractStepInputs(step, allParameters, varMap, systemVars);
}

/**
 * Prepare test scenario for a step with parameter/variable overrides
 * Returns complete test input set ready for unit testing
 */
function prepareStepUnitTest(step, document, allParameters = [], overrides = {}) {
    if (!step || !document) return null;
    const { varMap, systemVars } = buildVariableContext(document);

    return prepareStepTestInputs(step, allParameters, varMap, systemVars, overrides);
}

// ============================================================================
// STEP INPUTS ANALYSIS
// ============================================================================

/**
 * Analyze which parameters and variables a specific step uses
 * Useful for UI display of step dependencies
 */
function analyzeStepDependencies(step) {
    if (!step) return null;

    return {
        referencedParameters: extractReferencedParameters(step),
        variables: extractReferencedVariables(step),
        stepType: extractStepType(step),
        hasEnvironmentVariables: !!(step.env && Object.keys(step.env).length > 0),
        hasTaskInputs: !!(step.inputs && Object.keys(step.inputs).length > 0),
    };
}

// ============================================================================
// CLI MAIN ENTRY POINT
// ============================================================================

/**
 * Main CLI entry point for pipeline extraction
 * Handles argument parsing and command routing
 * Usage: node extension.js <command> <file> [options]
 */
function handleExtractorCli(argv = process.argv) {
    // If argv is already sliced (doesn't contain node/script), use as-is
    // Otherwise slice off node and script name
    const args = argv.length > 0 && !argv[0].includes('node') ? argv : argv.slice(2);

    // Parse options
    const options = {
        format: 'json',
        pretty: false,
        help: false,
    };

    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--pretty') {
            options.pretty = true;
        } else if (arg === '--json') {
            options.format = 'json';
        } else if (arg === '--csv') {
            options.format = 'csv';
        } else if (arg === '--table') {
            options.format = 'table';
        } else if (arg.startsWith('--format=')) {
            options.format = arg.substring('--format='.length);
        } else if (!arg.startsWith('--')) {
            positional.push(arg);
        }
    }

    if (options.help || positional.length === 0) {
        printCliHelp();
        return { success: true };
    }

    const [command, filePath] = positional;

    if (!command || !filePath) {
        console.error('Error: command and file path are required');
        printCliHelp();
        return { error: 'Missing arguments' };
    }

    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        return { error: `File not found: ${filePath}` };
    }

    let result;

    switch (command) {
        case 'extract-tree':
        case 'tree':
            result = handleExtractTree(filePath);
            break;
        case 'extract-params':
        case 'params':
            result = handleExtractParams(filePath);
            break;
        case 'extract-vars':
        case 'vars':
            result = handleExtractVars(filePath);
            break;
        default:
            console.error(`Error: Unknown command '${command}'`);
            printCliHelp();
            return { error: `Unknown command: ${command}` };
    }

    if (result.error) {
        console.error(`Error: ${result.error}`);
        return result;
    }

    // Format output
    const output = formatCliOutput(result, options);
    console.log(output);

    return { success: true, result };
}

/**
 * Print CLI help message
 */
function printCliHelp() {
    console.log(`
Pipeline CLI - Script Execution

Usage: node extension.js <command> [options] <file>

Listing Commands:
  liststages <file>
    List all stages with their numbers and job counts.

  listjobs -stage N <file>
    List all jobs in a stage with their numbers and step counts.

  liststeps -stage N -job N <file>
    List all steps in a job with their numbers, labels, and types.

  listpipeline <file>
    List all stages, jobs, and steps in one shot.

Script Commands:
  getscriptinfo -stage N -job N -step N <file>
    List the template parameters, runtime variables, and environment for a step.
    Output includes parameter names, types, default values, and current expansion values.

    runscript -stage N -job N -step N <file> [--input JSON] [--debug] [--verbose]
    Execute a step script with optional parameter/variable overrides.
        Options:
            --debug               runscript-only; set System.Debug=true and prepend set -x
            --xtrace, -x          runscript-only; prepend set -x only (no System.Debug)
            --verbose             Global or runscript arg; print full JSON result
                                                        (default prints script output only)
    The --input JSON object supports these keys:
      parameters            Override template parameter values  (map of name => value)
            variables             Override variables (auto-split by key pattern):
                                                        - Build.*/System.*/Agent.*/Pipeline.* => compile-time
                                                        - variables.* or variable.*            => compile-time
                                                        - all others                           => runtime variables
            Legacy keys (still supported): compileTimeVariables, runtimeVariables, environment

Examples:
  # Discover the pipeline structure
    node extension.js liststages ./pipeline.yaml
    node extension.js listjobs -stage 1 ./pipeline.yaml
    node extension.js liststeps -stage 1 -job 1 ./pipeline.yaml
    node extension.js listpipeline ./pipeline.yaml

  # Inspect a step's inputs
    node extension.js getscriptinfo -stage 1 -job 1 -step 3 ./pipeline.yaml

  # Run with default parameter values
    node extension.js runscript -stage 1 -job 1 -step 3 ./pipeline.yaml

  # Override template parameters
    node extension.js runscript -stage 1 -job 1 -step 3 ./pipeline.yaml \\
    --input '{"parameters":{"username":"myuser","email":"my@email.com"}}'

  # Override runtime variables
    node extension.js runscript -stage 1 -job 1 -step 3 ./pipeline.yaml \\
        --input '{"variables":{"auth_token":"mytoken"}}'

  # Enable debug mode (sets System.Debug=true)
    node extension.js runscript -stage 1 -job 1 -step 3 ./pipeline.yaml \\
        --input '{"variables":{"System.Debug":"true"}}'

    # Combine parameter and variable overrides
    node extension.js runscript -stage 1 -job 1 -step 3 ./pipeline.yaml \\
        --input '{"parameters":{"serviceUser":"myuser"},"variables":{"System.Debug":"true","variable.var1":"abc"}}'

Output:
  Listing commands print one entry per line (human-readable).
    runscript normal mode prints only script stdout.
    runscript --verbose prints full JSON with step info, inputs, and environment.
    Other script commands output JSON.
  On error: message on stderr and exit code 1.
    `);
}

/**
 * Format CLI output based on options
 */
function formatCliOutput(data, options) {
    if (options.format === 'json' || options.format === 'application/json') {
        const indent = options.pretty ? 2 : 0;
        return JSON.stringify(data, null, indent);
    }

    if (options.format === 'csv') {
        return formatAsCSV(data);
    }

    if (options.format === 'table') {
        return formatAsTable(data);
    }

    // Default to JSON
    return JSON.stringify(data, null, options.pretty ? 2 : 0);
}

/**
 * Format data as CSV
 */
function formatAsCSV(data) {
    if (data.command === 'extract-tree') {
        // Format stages/jobs/steps as CSV
        const rows = ['Stage,Job,Step,Type'];
        data.stages?.forEach((stage) => {
            stage.jobs?.forEach((job) => {
                job.steps?.forEach((step) => {
                    rows.push(`"${stage.displayName}","${job.displayName}","${step.label}","${step.type}"`);
                });
            });
        });
        return rows.join('\n');
    }

    if (data.command === 'extract-params') {
        // Format parameters as CSV
        const rows = ['Name,Type,HasDefault,DefaultValue'];
        data.parameters?.forEach((p) => {
            rows.push(`"${p.name}","${p.type}",${p.hasDefault},"${p.defaultValue || ''}"`);
        });
        return rows.join('\n');
    }

    if (data.command === 'extract-vars') {
        // Format variables as CSV
        const rows = ['Type,Name,Value'];
        data.simpleVariables?.forEach((v) => {
            rows.push(`"simple","${v.name}","${v.value}"`);
        });
        data.libraryGroups?.forEach((g) => {
            rows.push(`"group","${g}",""`);
        });
        return rows.join('\n');
    }

    return JSON.stringify(data, null, 0);
}

/**
 * Format data as table
 */
function formatAsTable(data) {
    if (data.command === 'extract-tree') {
        // Format stages/jobs/steps as ASCII table
        let output = 'STAGE\t\t\tJOB\t\t\tSTEP\t\t\tTYPE\n';
        output += ''.padEnd(80, '=') + '\n';
        data.stages?.forEach((stage) => {
            stage.jobs?.forEach((job) => {
                job.steps?.forEach((step) => {
                    output += `${(stage.displayName || '').padEnd(15)}\t${(job.displayName || '').padEnd(15)}\t${(step.label || '').padEnd(15)}\t${step.type}\n`;
                });
            });
        });
        return output;
    }

    if (data.command === 'extract-params') {
        // Format parameters as ASCII table
        let output = 'NAME\t\t\tTYPE\t\tDEFAULT\n';
        output += ''.padEnd(80, '=') + '\n';
        data.parameters?.forEach((p) => {
            output += `${(p.name || '').padEnd(15)}\t${(p.type || '').padEnd(10)}\t${p.defaultValue || '(none)'}\n`;
        });
        return output;
    }

    if (data.command === 'extract-vars') {
        // Format variables as ASCII table
        let output = 'TYPE\tNAME\t\t\tVALUE\n';
        output += ''.padEnd(80, '=') + '\n';
        data.simpleVariables?.forEach((v) => {
            output += `var\t${(v.name || '').padEnd(20)}\t${v.value}\n`;
        });
        data.libraryGroups?.forEach((g) => {
            output += `group\t${g}\n`;
        });
        return output;
    }

    return JSON.stringify(data, null, 0);
}

module.exports = {
    activate,
    deactivate,
    AzurePipelineParser,
    formatYaml,
    formatFilesRecursively,
    DependencyAnalyzer,
    // Script execution commands
    handleGetScriptInfo,
    handleRunScript,
    // CLI command handlers
    handleExtractTree,
    handleExtractParams,
    handleExtractVars,
    handleListStages,
    handleListJobs,
    handleListSteps,
    handleListPipeline,
    // Step input analysis functions
    getStepInputsForTesting,
    prepareStepUnitTest,
    analyzeStepDependencies,
    // CLI extractors
    handleExtractorCli,
    printCliHelp,
    formatCliOutput,
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

function _buildPipelineParserOptions(
    pipelineFile,
    { repositories, cliVariables, effectiveCliVariables, parameterMap }
) {
    const options = {
        fileName: pipelineFile,
        baseDir: path.dirname(pipelineFile),
        templateStack: [pipelineFile],
        azureCompatible: false,
    };
    if (repositories) {
        const resourceLocations = {};
        for (const [alias, config] of Object.entries(repositories)) {
            resourceLocations[alias] = config.location || config.path;
        }
        options.resourceLocations = resourceLocations;
    }
    if (cliVariables) {
        options.variables = effectiveCliVariables;
    }
    if (Object.keys(parameterMap).length) {
        options.parameters = parameterMap;
    }
    return options;
}

function runCli(args) {
    // Only run CLI logic when not in VS Code extension mode
    if (vscode !== undefined) {
        return;
    }

    // Check for script commands (getscriptinfo, runscript, liststages, listjobs, liststeps)
    // Support passing flags before the command, e.g.:
    //   node extension.js --verbose runscript ...
    const scriptCommands = ['getscriptinfo', 'runscript', 'liststages', 'listjobs', 'liststeps', 'listpipeline'];
    const scriptCommandIndex = args.findIndex((arg) => scriptCommands.includes(arg));
    if (scriptCommandIndex >= 0) {
        const command = args[scriptCommandIndex];
        const argsBeforeCommand = args.slice(0, scriptCommandIndex);
        const argsAfterCommand = args.slice(scriptCommandIndex + 1);

        const forwardedScriptFlags = [];
        if (argsBeforeCommand.includes('--verbose') || argsBeforeCommand.includes('-V')) {
            forwardedScriptFlags.push('--verbose');
        }

        const commandArgs = [...forwardedScriptFlags, ...argsAfterCommand];

        let result;
        if (command === 'getscriptinfo') {
            result = handleGetScriptInfo(commandArgs);
        } else if (command === 'runscript') {
            result = handleRunScript(commandArgs);
        } else if (command === 'liststages') {
            result = handleListStages(commandArgs);
        } else if (command === 'listjobs') {
            result = handleListJobs(commandArgs);
        } else if (command === 'liststeps') {
            result = handleListSteps(commandArgs);
        } else if (command === 'listpipeline') {
            result = handleListPipeline(commandArgs);
        }

        if (result && result.error && result.success !== false) {
            console.error(`Error: ${result.error}`);
            process.exitCode = 1;
        } else if (result) {
            const scriptOptions = _parseStepCommandArgs(commandArgs);
            if (command === 'liststages' && result.stages) {
                result.stages.forEach((s) =>
                    console.log(
                        `Stage ${s.number}: ${s.displayName}  (${s.jobCount} job${s.jobCount !== 1 ? 's' : ''})`
                    )
                );
            } else if (command === 'listjobs' && result.jobs) {
                console.log(`[Stage ${result.stage}: ${result.stageName}]`);
                result.jobs.forEach((j) =>
                    console.log(
                        `  Job ${j.number}: ${j.displayName}  (${j.stepCount} step${j.stepCount !== 1 ? 's' : ''})`
                    )
                );
            } else if (command === 'liststeps' && result.steps) {
                console.log(`[Stage ${result.stage}: ${result.stageName} / Job ${result.job}: ${result.jobName}]`);
                result.steps.forEach((s) => console.log(`  Step ${s.number}: ${s.label}  [${s.type}]`));
            } else if (command === 'listpipeline' && result.stages) {
                result.stages.forEach((stage) => {
                    console.log(`Stage ${stage.number}: ${stage.displayName}`);
                    (stage.jobs || []).forEach((job) => {
                        console.log(`  Job ${job.number}: ${job.displayName}`);
                        (job.steps || []).forEach((step) =>
                            console.log(`    Step ${step.number}: ${step.label}  [${step.type}]`)
                        );
                    });
                });
            } else if (command === 'getscriptinfo' && result.success) {
                const d = result;
                if (scriptOptions.verbose) {
                    console.log(JSON.stringify(d, null, 2));
                } else {
                    console.log(`Step ${d.step}: ${d.stepLabel}  [${d.stepType}]`);
                    if (d.parameterDefinitions && d.parameterDefinitions.length) {
                        console.log('\nParameters:');
                        d.parameterDefinitions.forEach((p) => {
                            const defVal = p.default !== undefined && p.default !== '' ? ` = "${p.default}"` : '';
                            console.log(`  ${p.name}  (${p.type}${defVal})`);
                        });
                    }
                    const allVars = [
                        ...(d.referencedCompileTimeVariables || []).map((v) => ({ name: v, kind: 'compile-time' })),
                        ...(d.referencedRuntimeVariables || []).map((v) => ({ name: v, kind: 'runtime' })),
                    ];
                    if (allVars.length) {
                        console.log('\nVariables:');
                        allVars.forEach((v) => console.log(`  ${v.name}  (${v.kind})`));
                    }
                    if (d.stepEnvironment && Object.keys(d.stepEnvironment).length) {
                        console.log('\nEnvironment:');
                        Object.entries(d.stepEnvironment).forEach(([k, v]) => console.log(`  ${k} = ${v}`));
                    }
                }
            } else if (command === 'runscript') {
                const scriptOutput = typeof result.output === 'string' ? result.output : '';
                if (scriptOptions.verbose) {
                    console.log(JSON.stringify(result, null, 2));
                } else {
                    if (scriptOutput.length) console.log(scriptOutput);
                    if (result.success === false) {
                        process.stderr.write(
                            `Error: ${result.error || `Script failed (exit code ${result.exitCode})`}\n`
                        );
                    }
                }
                if (result.success === false) {
                    process.exitCode = 1;
                }
            } else {
                console.log(JSON.stringify(result, null, 2));
            }
        }
        return;
    }

    const usage =
        'Usage: node extension.js <command> <file> [options]\n' +
        '       node extension.js <file1> <file2> ... [options]\n\n' +
        'Listing Commands:\n' +
        '  liststages <file>                              List all stages\n' +
        '  listjobs -stage N <file>                       List jobs in a stage\n' +
        '  liststeps -stage N -job N <file>               List steps in a job\n' +
        '  listpipeline <file>                            List all stages, jobs, and steps\n\n' +
        'Script Commands:\n' +
        '  getscriptinfo -stage N -job N -step N <file>  Get script input info at location\n' +
        '  runscript -stage N -job N -step N <file> [--input JSON] [--debug] [--verbose]  Execute script with inputs\n\n' +
        'Script Run Options:\n' +
        '      --debug                  (runscript-only) set System.Debug=true and prepend set -x\n' +
        '  -x, --xtrace                 (runscript-only) prepend set -x to bash script only\n' +
        '  -V, --verbose                (global or runscript) print full JSON result (default: script stdout only)\n\n' +
        'Format/Expand Options:\n' +
        '  -h, --help                   Show this help message\n' +
        '  -o, --output <file>          Write output to file (default: in-place, only with single file)\n' +
        '  -r, --resource <alias=path>  Map repository alias to local path\n' +
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
        '      --toolpath <name=path>    Override executable/tool path for simulation (repeatable)\n' +
        '      --output-json <file>     Write simulation results JSON to the provided path\n' +
        '      --list-build-outputs     List files that will be generated by the build (from sln/csproj/vcproj) without running simulation';

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
            'toolpath',
            'output-json',
            'wsl-mount-root',
        ],
        boolean: [
            'help',
            'expand-templates',
            'azure-compatible',
            'skip-syntax-check',
            'debug',
            'verbose',
            'simulate',
            'timing',
            'list-build-outputs',
        ],
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
            V: 'verbose',
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
            verbose: false,
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
        'verbose',
        'V',
        'simulate',
        'timing',
        't',
        'build-counter',
        'c',
        'stage',
        'S',
        'toolpath',
        'output-json',
        'wsl-mount-root',
        'list-build-outputs',
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

    const inputFiles = argv._;
    const formatOption = toArray(argv['format-option']);
    const extension = toArray(argv.extension);
    const formatRecursiveRaw = argv['format-recursive'];
    const formatRecursiveValues = toArray(formatRecursiveRaw).filter((v) => typeof v === 'string' && v.trim().length);
    const formatRecursiveFlag =
        args.includes('-R') || args.includes('--format-recursive') || formatRecursiveRaw === true;

    const { map: variablesMap, errors: variableErrors } = parseKeyValue(toArray(argv.variables), 'variable');
    const { map: parameterMap, errors: parameterErrors } = parseKeyValue(toArray(argv.parameter), 'parameter');
    const { map: repoMap, errors: repoErrors } = parseKeyValue(toArray(argv.repo), 'repository mapping');
    const { map: executablePaths } = parseKeyValue(toArray(argv.toolpath), 'executable path');
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
        formatRecursiveFlag || formatRecursiveValues.length ? [...formatRecursiveValues, ...inputFiles] : [];

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

    if (argv['list-build-outputs'] || argv.simulate) {
        if (inputFiles.length === 0) {
            failWithUsage(
                `Error: --${argv['list-build-outputs'] ? 'list-build-outputs' : 'simulate'} requires a pipeline file argument.`
            );
            return;
        }

        const pipelineFile = path.resolve(process.cwd(), inputFiles[0]);
        const pipelineSource = fs.readFileSync(pipelineFile, 'utf8');
        const parser = new AzurePipelineParser({ skipSyntax: argv['skip-syntax-check'] || false });
        const parserOptions = _buildPipelineParserOptions(pipelineFile, {
            repositories,
            cliVariables,
            effectiveCliVariables,
            parameterMap,
        });

        if (argv['list-build-outputs']) {
            try {
                const { document } = parser.expandPipeline(pipelineSource, parserOptions);
                let buildContexts = collectBuildContextsFromPipelineDocument(document);

                if (buildContexts.length === 0) {
                    throw new Error(
                        'No VSBuild or MSBuild tasks found in the pipeline. ' +
                            'Build output discovery requires at least one VSBuild@1 or MSBuild@1 task.'
                    );
                }

                // When VSBuild task inputs have unresolved runtime variables,
                // the pipeline uses a buildConfigurations parameter list that gets iterated at runtime.
                // Fall back to extracting config+platform pairs directly from the raw YAML.
                const hasUnresolvedVars = (str) => /\$\(/.test(String(str || ''));
                const allUnresolved = buildContexts.every(
                    (ctx) => hasUnresolvedVars(ctx.configuration) || hasUnresolvedVars(ctx.platform)
                );
                if (allUnresolved) {
                    const rawConfigs = _extractBuildConfigurationsFromRawYaml(pipelineSource);
                    if (rawConfigs && rawConfigs.length > 0) {
                        buildContexts = rawConfigs.map((cfg) => ({
                            solution: buildContexts[0].solution,
                            configuration: cfg.configuration,
                            platform: cfg.platform,
                        }));
                    }
                }

                const simulator = new PipelineSimulator({ outputRoot: path.dirname(pipelineFile) });

                const createdBuildFiles = simulator.discoverBuildOutputs(path.dirname(pipelineFile), buildContexts);
                if (createdBuildFiles.length === 0) {
                    console.log('[sim] build outputs: none');
                } else {
                    console.log('[sim] build outputs:');
                    for (const createdFile of createdBuildFiles) {
                        console.log(`[sim]   ${createdFile}`);
                    }
                }

                if (argv['output-json']) {
                    fs.writeFileSync(argv['output-json'], JSON.stringify({ createdBuildFiles }, null, 2), 'utf8');
                }
            } catch (err) {
                console.error(`Error: ${err.message}`);
                process.exitCode = 1;
            }

            return;
        }

        // argv.simulate
        const simulationRoot = path.resolve(process.cwd(), path.join(path.dirname(pipelineFile), 'simulation'));
        fs.rmSync(simulationRoot, { recursive: true, force: true });
        const buildCounterRaw = argv['build-counter'];
        const buildCounterValue = buildCounterRaw !== undefined ? String(parseInt(buildCounterRaw, 10) || 1) : '1';

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
            const { document } = parser.expandPipeline(pipelineSource, parserOptions);
            if (debugLibVars) {
                console.log('[DEBUG] Library Variables Map:', JSON.stringify(libraryVariablesMap, null, 2));
            }
            const results = runPipelineSimulation(document, {
                workingDirectory: path.dirname(pipelineFile),
                outputRoot: simulationRoot,
                buildCounter: buildCounterValue,
                userVariables: argv.debug ? { ...variablesMap, 'System.Debug': 'true' } : variablesMap,
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
            printSimulationResults(results, { verbose: !!argv.verbose });
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

    if (inputFiles.length === 0) {
        failWithUsage();
        return;
    }

    if (argv.output && inputFiles.length > 1) {
        failWithUsage('Error: --output option is only supported when formatting a single file.');
        return;
    }

    const formatOverrides = buildFormatOptionsFromCli(formatOption) || {};

    // Create parser instance if template expansion is needed
    const cliParser = argv['expand-templates'] ? new AzurePipelineParser() : null;

    let hasErrors = false;

    for (const filePath of inputFiles) {
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
