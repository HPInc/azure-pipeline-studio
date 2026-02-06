const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

// Import utility functions and formatter
const { pickFirstString, resolveConfiguredPath, normalizeExtension } = require('./utils');
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

function activate(context) {
    if (!vscode) {
        console.warn('VS Code API unavailable; activate() skipped (CLI execution detected).');
        return;
    }

    console.log('Azure Pipeline YAML Parser extension is now active!');

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
            const config = vscode.workspace.getConfiguration('azurePipelineStudio', document?.uri);
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
        const panel = vscode.window.createWebviewPanel('azurePipelineError', title, vscode.ViewColumn.Beside, {
            enableScripts: true,
        });

        // Store reference to current error panel
        currentErrorPanel = panel;

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

        // Convert file paths in text to clickable links
        const makePathsClickable = (text) => {
            // Match UNC, Windows, and Unix paths with optional line numbers
            const pathRegex =
                /(\\\\[^\s\n:]+\.(?:ya?ml|js|ts))(?::(\d+))?(?::(\d+))?|([A-Za-z]:\\[^\s\n:]+\.(?:ya?ml|js|ts))(?::(\d+))?(?::(\d+))?|(\/[^\s\n:]+\.(?:ya?ml|js|ts))(?::(\d+))?(?::(\d+))?/g;

            return text.replace(
                pathRegex,
                (match, uncPath, uncLine, uncCol, winPath, winLine, winCol, unixPath, unixLine, unixCol) => {
                    const filePath = uncPath || winPath || unixPath;
                    const lineNumber = uncLine || winLine || unixLine;

                    // Skip extension bundle paths
                    if (filePath && filePath.includes('extension-bundle.js')) {
                        return match;
                    }

                    if (filePath) {
                        const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                        const lineParam = lineNumber ? lineNumber : 'null';
                        return `<a class="file-link" href="#" onclick="openFile('${escapedPath}', ${lineParam}); return false;">${escapeHtml(match)}</a>`;
                    }
                    return match;
                }
            );
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
                '- Use "Show Dependencies" to see the complete dependency graph and identify the root cause.',
            ];
        }

        const detailsLines = [];
        if (messageLines.length) {
            detailsLines.push(...messageLines);
        }

        if (templateLines.length) {
            detailsLines.push('Template call stack:');
            templateLines.forEach((line) => {
                detailsLines.push(`    ${line}`);
            });
        }

        const errorDetailsText = detailsLines.join('\n');

        const tipLinesNormalized = tipLines.map((line) =>
            line.startsWith('-') || line.startsWith('•') ? line : `- ${line}`
        );
        const tipsHtml = tipLinesNormalized.length
            ? `
                    <h2>Tips</h2>
                    <div class="error-details">
                        <code>${formatErrorMessage(tipLinesNormalized.join('\n'))}</code>
                    </div>
            `
            : '';

        const stackLines = errorStackText
            .split('\n')
            .filter((line, index) => index === 0 || line.trim().startsWith('at '));
        const sanitizedStackText = stackLines.length > 1 ? stackLines.slice(1).join('\n') : '';

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
            }
        });
    };

    const scheduleErrorDisplay = (delayMs = errorDebounceDelayMs) => {
        clearTimeout(errorDebounceTimer);
        clearTimeout(activeErrorDebounceTimer);
        errorDebounceTimer = activeErrorDebounceTimer = setTimeout(() => {
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

    const showErrorWebview = (error, context, errorType = 'expansion') => {
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

    const scheduleRender = (document, delayMs = 500) => {
        if (!shouldRenderDocument(document)) return;
        pendingDocument = document;
        clearTimeout(debounceTimer);
        clearTimeout(activeDebounceTimer);
        debounceTimer = activeDebounceTimer = setTimeout(() => {
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
        if (errorPanelOpen) {
            closeErrorPanel();
        }

        lastRenderedDocument = document;
        const sourceText = document.getText();

        isRendering = true;
        try {
            const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
            const compileTimeVariables = config.get('expansion.variables', {});
            const skipSyntaxCheck = config.get('expansion.skipSyntaxCheck', false);
            const resourceOverrides = buildResourceOverridesForDocument(document);
            const azureCompatible = options.azureCompatible ?? false;

            const parserOverrides = {
                fileName: document.fileName,
                azureCompatible,
                skipSyntaxCheck,
                ...(resourceOverrides && { resources: resourceOverrides }),
                ...(Object.keys(compileTimeVariables).length && { variables: compileTimeVariables }),
            };

            console.log('Parser overrides:', JSON.stringify(parserOverrides, null, 2));
            const expandedYaml = parser.expandPipelineFromString(sourceText, parserOverrides);

            const formatOptions = getFormatSettings(document);
            formatOptions.fileName = document.fileName;
            formatOptions.wasExpanded = true;
            const formatted = formatYaml(expandedYaml, formatOptions);

            const targetUri = getRenderTargetUri(document);
            renderedContent.set(targetUri.toString(), formatted.text);
            renderedEmitter.fire(targetUri);

            clearTimeout(errorDebounceTimer);
            clearTimeout(activeErrorDebounceTimer);
            errorDebounceTimer = activeErrorDebounceTimer = undefined;
            pendingError = null;

            // Close error panel on successful expansion
            closeErrorPanel();

            if (!options.silent) {
                const targetDoc = await vscode.workspace.openTextDocument(targetUri);
                await vscode.window.showTextDocument(targetDoc, {
                    viewColumn: vscode.ViewColumn.Beside,
                    preview: false,
                    preserveFocus: true,
                });
            }
        } catch (error) {
            console.error('Error expanding pipeline:', error);
            const errorMessage = error.message || String(error);
            const enhancedError = new Error(`Error Expanding Azure Pipeline:\n\n${errorMessage}`);
            enhancedError.stack = error.stack;
            showErrorWebview(enhancedError, context, 'expansion');
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
        const workspaceDir = workspaceFolder?.uri.fsPath;
        const documentDir = document.fileName ? path.dirname(document.fileName) : undefined;
        const repositories = {};

        for (const entry of configuredResources) {
            if (!entry || typeof entry !== 'object') continue;

            const alias = entry.repository?.trim();
            const rawPath = pickFirstString(entry.path, entry.location);
            if (!alias || !rawPath) continue;

            const resolvedPath = resolveConfiguredPath(rawPath, workspaceDir, documentDir);
            if (!resolvedPath) continue;

            const overrideEntry = { location: resolvedPath };
            const matchCriteria = {};

            ['repository', 'name', 'endpoint', 'ref', 'type'].forEach((key) => {
                const value = entry[key]?.trim();
                if (value) matchCriteria[key] = value;
            });

            if (Object.keys(matchCriteria).length) {
                overrideEntry.__match = matchCriteria;
            }

            repositories[alias] = overrideEntry;
        }

        return Object.keys(repositories).length ? { repositories } : undefined;
    }

    const shouldRenderDocument = (document) => {
        if (!document || !document.fileName) {
            return false;
        }
        const lower = document.fileName.toLowerCase();
        return lower.endsWith('.yaml') || lower.endsWith('.yml');
    };

    const isRelevantDocument = (document) =>
        shouldRenderDocument(document) && lastRenderedDocument?.fileName === document.fileName;

    const commandDisposable = vscode.commands.registerCommand('azurePipelineStudio.showRenderedYaml', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !shouldRenderDocument(editor.document)) {
            vscode.window.showInformationMessage('Open an Azure Pipeline YAML file to view the expanded contents.');
            return;
        }

        closeErrorPanel();
        await renderYamlDocument(editor.document, { azureCompatible: false });
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
            await renderYamlDocument(editor.document, { azureCompatible: true });
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
                console.log('[Azure Pipeline Studio] Configure Resource Locations command triggered');
                await handleConfigureResourceLocationRequest();
            } catch (error) {
                console.error('[Azure Pipeline Studio] Error in configure command:', error);
                vscode.window.showErrorMessage(`Configuration error: ${error.message}`);
            }
        }
    );
    context.subscriptions.push(configureCommandDisposable);

    const ensureDependenciesPanel = () => {
        if (dependenciesPanel) {
            return dependenciesPanel;
        }

        dependenciesPanel = vscode.window.createWebviewPanel(
            'pipelineDependencies',
            'Pipeline Dependencies',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        dependenciesPanel.onDidDispose(() => {
            dependenciesPanel = activeDependenciesPanel = null;
            dependenciesDocumentUri = undefined;
        });

        dependenciesPanel.webview.onDidReceiveMessage(async (message) => {
            if (message.command !== 'openInBrowser') {
                return;
            }

            try {
                const os = require('os');
                const tempFile = path.join(os.tmpdir(), `pipeline-dependencies-${Date.now()}.html`);
                fs.writeFileSync(tempFile, dependenciesPanelHtml);
                await vscode.env.openExternal(vscode.Uri.file(tempFile));
                vscode.window.showInformationMessage('Opened dependencies in browser');
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open in browser: ${err.message}`);
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
        try {
            const sourceText = document.getText();

            const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
            const compileTimeVariables = config.get('expansion.variables', {});
            const skipSyntaxCheck = config.get('expansion.skipSyntaxCheck', false);
            const resourceOverrides = buildResourceOverridesForDocument(document);

            const parserOverrides = {
                fileName: document.fileName,
                azureCompatible: false,
                skipSyntaxCheck,
                ...(resourceOverrides && { resources: resourceOverrides }),
                ...(Object.keys(compileTimeVariables).length && { variables: compileTimeVariables }),
            };

            if (!silent) {
                vscode.window.setStatusBarMessage('Expanding pipeline templates...', 2000);
            }

            const expandedYaml = parser.expandPipelineFromString(sourceText, parserOverrides);

            if (!silent) {
                vscode.window.setStatusBarMessage('Analyzing dependencies...', 2000);
            }

            let dependencies;
            try {
                dependencies = dependencyAnalyzer.analyzePipeline(expandedYaml);
            } catch (error) {
                const errorMessage = error.message || 'An error occurred while analyzing pipeline dependencies';
                const enhancedMessage =
                    `Error in Show Dependencies:\n\n${errorMessage}\n\n` +
                    `💡 Tip: It's often easier to identify and fix issues using "Expand Pipeline" first. ` +
                    `This will show you the full expanded YAML with all template variables and references resolved.`;
                const enhancedError = new Error(enhancedMessage);
                enhancedError.stack = error.stack;
                showErrorWebview(enhancedError, context, 'dependency');
                return;
            }

            const mermaidDiagram =
                dependencies.stages.length > 0 || dependencies.jobs.length > 0
                    ? dependencyAnalyzer.generateMermaidDiagram(dependencies)
                    : '';

            const projectName = lastRenderedDocument?.fileName?.split('/').pop()?.replace('.yaml', '') || 'Pipeline';
            const stageCount = dependencies.stages.length || dependencies.jobs.length || 0;

            const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pipeline Dependencies</title>
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
            padding: 30px;
            border-bottom: 4px solid #D13438;
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

        .tabs {
            display: flex;
            background: #2d2d2d;
            border-bottom: 2px solid #3e3e42;
        }

        .tab {
            padding: 15px 30px;
            cursor: pointer;
            transition: all 0.3s;
            border-bottom: 3px solid transparent;
            font-weight: 500;
            color: #cccccc;
        }

        .tab:hover {
            background: #3e3e42;
            color: #ffffff;
        }

        .tab.active {
            background: #252526;
            border-bottom-color: #D13438;
            color: #ffffff;
        }

        .content {
            padding: 20px;
            min-height: calc(100vh - 200px);
            background: #252526;
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
            animation: fadeIn 0.3s;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .diagram-container {
            background: #1e1e1e;
            border-radius: 0;
            padding: 20px;
            margin-bottom: 0;
            overflow-x: auto;
        }

        .mermaid {
            display: flex;
            justify-content: center;
            background: #1e1e1e;
            border-radius: 0;
            min-height: 400px;
            overflow: auto;
        }

        .legend {
            display: flex;
            gap: 20px;
            padding: 10px 20px;
            background: #2d2d2d;
            border-radius: 0;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.9em;
            color: #cccccc;
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
            .tabs {
                overflow-x: auto;
            }
            .tab {
                padding: 12px 20px;
                white-space: nowrap;
            }
        }
        
        h2 {
            color: #ffffff;
        }
        
        p {
            color: #cccccc;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div style="display: flex; align-items: center; gap: 12px;">
                <h1 style="margin: 0;">
                    <span class="header-icon">🔄</span>
                    Pipeline Dependencies
                </h1>
                <button onclick="openInBrowser()" style="padding: 8px 16px; background: #0078d4; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500;">🌐 Open in Browser</button>
            </div>
            <div class="header-info">
                <div class="header-info-item">
                    <span>📄</span>
                    <span>File: ${projectName}</span>
                </div>
                <div class="header-info-item">
                    <span>🏗️</span>
                    <span>${stageCount} Stage${stageCount !== 1 ? 's' : ''}</span>
                </div>
            </div>
        </div>

        <div class="tabs">
            <div class="tab active" data-tab="diagram" onclick="switchTab('diagram')">📊 Diagram</div>
            <div class="tab" data-tab="stages" onclick="switchTab('stages')">🎯 Details</div>
            ${dependencies.resources.length > 0 ? '<div class="tab" data-tab="resources" onclick="switchTab(\'resources\')">📚 Resources</div>' : ''}
        </div>

        <div class="content">
            <!-- Diagram Tab -->
            <div class="tab-content active" id="diagram">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <div class="legend" style="margin-bottom: 0; flex: 1;">
                        <div class="legend-item">
                            <div class="legend-color" style="background: #D13438;"></div>
                            <span>🔴 Critical Path</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color" style="background: #1d4ed8;"></div>
                            <span>Build Stages</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color" style="background: #16a34a;"></div>
                            <span>Release Stages</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color" style="background: #ea580c;"></div>
                            <span>Security/Signing</span>
                        </div>
                    </div>
                    <button onclick="toggleDiagramSource()" id="source-toggle-btn" style="padding: 8px 16px; background: #3e3e42; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; white-space: nowrap;">📝 View Source</button>
                </div>

                <div class="diagram-container">
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
                
                <!-- Collapsible Source Code Section -->
                <div id="diagram-source-section" style="display: none; margin-top: 15px; background: #1e1e1e; border-radius: 4px; overflow: hidden; border-left: 4px solid #0078d4;">
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

            <!-- Details Tab -->
            <div class="tab-content" id="stages">
                <div class="stage-list" id="stageList">
                    <!-- Stages will be populated dynamically -->
                </div>
            </div>

            <!-- Resources Tab -->
            ${
                dependencies.resources.length > 0
                    ? `
            <div class="tab-content" id="resources">
                <h2 style="margin-bottom: 20px; color: #2d3748;">Pipeline Resources</h2>
                <div class="resources-grid">
                    ${dependencies.resources
                        .map(
                            (resource) => `
                        <div class="resource-card">
                            <h3>
                                <span class="resource-type">${resource.type}</span>
                                ${resource.name}
                            </h3>
                            <div class="resource-details">
                                <div><strong>Type:</strong> ${resource.type}</div>
                                ${resource.source ? '<div><strong>Source:</strong> ' + resource.source + '</div>' : ''}
                            </div>
                        </div>
                    `
                        )
                        .join('')}
                </div>
            </div>
            `
                    : ''
            }
        </div>
    </div>

    <script>
        const stagesData = ${JSON.stringify(dependencies.stages.map((s, i) => ({ ...s, number: i + 1 })))};
        
        // Open in browser function
        window.openInBrowser = function() {
            const vscode = acquireVsCodeApi();
            vscode.postMessage({ command: 'openInBrowser' });
        };
        
        // Global tab switching function
        window.switchTab = function(tabName) {
            // Hide all tab contents
            const allContents = document.querySelectorAll('.tab-content');
            for (let i = 0; i < allContents.length; i++) {
                allContents[i].classList.remove('active');
            }
            
            // Remove active class from all tabs
            const allTabs = document.querySelectorAll('.tab');
            for (let i = 0; i < allTabs.length; i++) {
                allTabs[i].classList.remove('active');
            }
            
            // Show the selected tab content
            const selectedContent = document.getElementById(tabName);
            if (selectedContent) {
                selectedContent.classList.add('active');
            }
            
            // Mark the clicked tab as active
            const selectedTab = document.querySelector('.tab[data-tab="' + tabName + '"]');
            if (selectedTab) {
                selectedTab.classList.add('active');
            }
            
            // Render stages when Details tab is opened
            if (tabName === 'stages') {
                renderStages();
            }
        };
        
        window.renderStages = function() {
            const stageList = document.getElementById('stageList');
            if (!stageList) return;
            
            let html = '';
            for (let i = 0; i < stagesData.length; i++) {
                const stage = stagesData[i];
                let depsHtml = '';
                
                if (stage.dependsOn && stage.dependsOn.length > 0) {
                    depsHtml = '<div class="stage-deps"><div class="stage-deps-title">Dependencies:</div>';
                    for (let j = 0; j < stage.dependsOn.length; j++) {
                        depsHtml += '<span class="dep-badge">' + stage.dependsOn[j] + '</span>';
                    }
                    depsHtml += '</div>';
                } else {
                    depsHtml = '<div class="stage-deps"><div class="stage-deps-title">Entry stage (no dependencies)</div></div>';
                }
                
                html += '<div class="stage-card" data-stage="' + stage.name + '">';
                html += '<h3>';
                html += '<span>';
                html += '<span class="stage-number">' + stage.number + '</span>';
                html += (stage.displayName || stage.name);
                html += '</span>';
                html += '<span class="expand-icon">▼</span>';
                html += '</h3>';
                html += depsHtml;
                html += '<div class="stage-details">';
                html += '<p style="color: #4a5568; margin-bottom: 10px;">';
                html += (stage.jobs ? 'Jobs: ' + stage.jobs.length : 'Stage');
                html += '</p>';
                html += '</div>';
                html += '</div>';
                
                // Add divider between stages
                if (i < stagesData.length - 1) {
                    html += '<div class="stage-divider"></div>';
                }
            }
            
            stageList.innerHTML = html;
            
            // Add click handlers to stage cards
            const stageCards = document.querySelectorAll('.stage-card');
            for (let i = 0; i < stageCards.length; i++) {
                stageCards[i].addEventListener('click', function() {
                    this.classList.toggle('expanded');
                });
            }
        };
        
        // Toggle diagram source visibility
        window.toggleDiagramSource = function() {
            const sourceSection = document.getElementById('diagram-source-section');
            const toggleBtn = document.getElementById('source-toggle-btn');
            if (sourceSection && toggleBtn) {
                const isVisible = sourceSection.style.display !== 'none';
                sourceSection.style.display = isVisible ? 'none' : 'block';
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
        
        // Initial render
        renderStages();
    </script>
</body>
</html>`;

            const panel = ensureDependenciesPanel();
            if (!panel) {
                return;
            }

            activeDependenciesPanel = dependenciesPanel = panel;
            dependenciesPanelHtml = htmlContent;

            try {
                panel.webview.html = htmlContent;
            } catch (panelError) {
                // Panel might be disposed, ignore
                dependenciesPanel = null;
                activeDependenciesPanel = null;
                return;
            }

            if (reveal) {
                try {
                    panel.reveal(vscode.ViewColumn.Beside, true);
                } catch (revealError) {
                    // Panel reveal failed, ignore
                }
            }

            closeErrorPanel();

            if (!silent) {
                vscode.window.setStatusBarMessage('Pipeline dependencies analyzed.', 3000);
            }
        } catch (error) {
            if (!silent) {
                vscode.window.showErrorMessage(`Failed to analyze dependencies: ${error.message}`);
            }
        } finally {
            isDependenciesRendering = false;
            if (pendingDependenciesDocument) {
                const queuedDocument = pendingDependenciesDocument;
                pendingDependenciesDocument = null;
                void renderDependenciesPanel(queuedDocument, { silent: true });
            }
        }
    };

    const scheduleDependenciesRefresh = (document, delayMs = 500) => {
        if (!dependenciesPanel || !dependenciesDocumentUri) {
            return;
        }

        if (document.uri.toString() !== dependenciesDocumentUri.toString()) {
            return;
        }

        pendingDependenciesDocument = document;
        clearTimeout(dependenciesDebounceTimer);
        clearTimeout(activeDependenciesDebounceTimer);
        dependenciesDebounceTimer = activeDependenciesDebounceTimer = setTimeout(() => {
            // Check again if panel is still valid (might have been disposed)
            if (!dependenciesPanel || isDependenciesRendering) {
                return;
            }

            const queuedDocument = pendingDependenciesDocument;
            pendingDependenciesDocument = null;
            if (queuedDocument) {
                void renderDependenciesPanel(queuedDocument, { silent: true });
            }
        }, delayMs);
    };

    const showDependenciesCommandDisposable = vscode.commands.registerCommand(
        'azurePipelineStudio.showDependencies',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !shouldRenderDocument(editor.document)) {
                vscode.window.showInformationMessage('Open an Azure Pipeline YAML file to view dependencies.');
                return;
            }

            await renderDependenciesPanel(editor.document, { reveal: true });
        }
    );
    context.subscriptions.push(showDependenciesCommandDisposable);

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
            console.log(`[Azure Pipeline Studio] Selected folder location: ${newLocation}`);
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

            console.log(`[Azure Pipeline Studio] Entered manual location: ${newLocation}`);
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
            console.log(`[Azure Pipeline Studio] About to save repository '${alias}' location: ${sanitizedLocation}`);
            console.log(`[Azure Pipeline Studio] Target:`, target);
            console.log(`[Azure Pipeline Studio] Entries to save:`, JSON.stringify(updatedEntries, null, 2));

            await config.update('resourceLocations', updatedEntries, target);

            console.log(
                `[Azure Pipeline Studio] Successfully saved repository '${alias}' location: ${sanitizedLocation}`
            );

            vscode.window.showInformationMessage(`Repository '${alias}' location saved.`);

            await renderYamlDocument(targetDocument);
        } catch (error) {
            console.error(`[Azure Pipeline Studio] Error saving repository location:`, error);
            vscode.window.showErrorMessage(`Failed to save repository location: ${error.message}`);
        }
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(({ document }) => {
            if (isRelevantDocument(document)) {
                scheduleRender(document);

                if (lastRenderedDocument && lastRenderedDocument.fileName === document.fileName) {
                    void renderYamlDocument(document, { silent: true });
                }
            }

            // Refresh dependencies panel even if not the expanded document
            scheduleDependenciesRefresh(document);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (!isRelevantDocument(document)) return;
            const config = vscode.workspace.getConfiguration('azurePipelineStudio', document.uri);
            if (config.get('refreshOnSave', true)) {
                scheduleRender(document, 0);
            }
        })
    );
}

function deactivate() {
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
            const fileFormatOptions = { ...formatOptions, fileName: filePath };
            const formatResult = formatYaml(source, fileFormatOptions);

            if (formatResult.error) {
                results.errors.push({ filePath, message: formatResult.error });
                return;
            }

            if (formatResult.text !== source) {
                fs.writeFileSync(filePath, formatResult.text, 'utf8');
                results.formattedFiles.push(filePath);

                // Only show warning if file was actually formatted
                if (formatResult.warning) {
                    results.warnings.push({ filePath, message: formatResult.warning });
                }
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
        '  -f, --format-option <key=value>  Set format option (e.g., indent=4)\n' +
        '  -R, --format-recursive <path>    Format files recursively in directory (when used, all paths are treated as recursive targets)\n' +
        '  -e, --extension <ext>        File extensions to format (default: .yml, .yaml)\n' +
        '  -x, --expand-templates       Expand Azure Pipeline template expressions (${{}},$[],$())\n' +
        '  -a, --azure-compatible       Use Azure-compatible expansion mode (adds blank lines, etc.)\n' +
        '  -s, --skip-syntax-check      Skip syntax checking during expansion\n' +
        '  -d, --debug                  Print files being formatted';

    const argv = minimist(args, {
        string: ['output', 'repo', 'format-option', 'format-recursive', 'extension', 'variables'],
        boolean: ['help', 'expand-templates', 'azure-compatible', 'skip-syntax-check', 'debug'],
        alias: {
            h: 'help',
            o: 'output',
            r: 'repo',
            f: 'format-option',
            R: 'format-recursive',
            e: 'extension',
            v: 'variables',
            x: 'expand-templates',
            a: 'azure-compatible',
            s: 'skip-syntax-check',
            d: 'debug',
        },
        default: {
            extension: [],
            'expand-templates': false,
            'azure-compatible': false,
            'skip-syntax-check': false,
            debug: false,
        },
    });

    if (argv.help) {
        console.log(usage);
        process.exit(0);
    }

    const toArray = (val) => [].concat(val || []);
    const repo = toArray(argv.repo);
    const variables = toArray(argv.variables);
    const formatOption = toArray(argv['format-option']);
    const formatRecursiveRaw = argv['format-recursive'];
    const formatRecursiveValues = toArray(formatRecursiveRaw).filter(
        (value) => typeof value === 'string' && value.trim().length
    );
    const formatRecursiveFlag =
        args.includes('-R') || args.includes('--format-recursive') || formatRecursiveRaw === true;
    const extension = toArray(argv.extension);
    const repositoryEntries = [];
    const variablesMap = {};
    const errors = [];

    for (const entry of repo) {
        const [alias, ...pathParts] = entry.split('=');
        const pathValue = pathParts.join('=').trim();
        if (!alias || !alias.trim() || !pathValue) {
            errors.push(`Invalid repository mapping "${entry}". Expected format "alias=path".`);
            continue;
        }
        repositoryEntries.push({ alias: alias.trim(), path: pathValue });
    }
    for (const entry of variables) {
        const [key, ...valueParts] = entry.split('=');
        const value = valueParts.join('=').trim();
        if (!key || !key.trim() || value === undefined) {
            errors.push(`Invalid variable "${entry}". Expected format "key=value".`);
            continue;
        }
        variablesMap[key.trim()] = value;
    }
    for (const entry of formatOption) {
        if (!entry.includes('=')) {
            errors.push(`Invalid format option "${entry}". Expected format "key=value".`);
        }
    }

    if (errors.length) {
        errors.forEach((message) => console.error(message));
        console.error(usage);
        process.exitCode = 1;
        return;
    }

    const filesToFormat = argv._;
    const recursiveTargets = formatRecursiveFlag
        ? [...formatRecursiveValues, ...filesToFormat]
        : formatRecursiveValues.length
          ? [...formatRecursiveValues, ...filesToFormat]
          : [];

    if (formatRecursiveFlag && recursiveTargets.length === 0) {
        console.error('Error: --format-recursive requires at least one path.');
        console.error(usage);
        process.exitCode = 1;
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
            const displayPath = path.relative(process.cwd(), entry.filePath) || entry.filePath;
            console.warn(`[warn] ${displayPath}: ${entry.message}`);
        });

        recursiveResult.errors.forEach((entry) => {
            const displayPath = path.relative(process.cwd(), entry.filePath) || entry.filePath;
            console.error(`[error] ${displayPath}: ${entry.message}`);
        });

        if (recursiveResult.errors.length) {
            process.exitCode = 1;
        }
        return;
    }

    if (filesToFormat.length === 0) {
        console.error(usage);
        process.exitCode = 1;
        return;
    }

    if (argv.output && filesToFormat.length > 1) {
        console.error('Error: --output option is only supported when formatting a single file.');
        console.error(usage);
        process.exitCode = 1;
        return;
    }

    const formatOverrides = buildFormatOptionsFromCli(formatOption) || {};
    const repositories = buildRepositoryOverridesFromCliEntries(repositoryEntries, process.cwd());
    // Use the variables map we parsed earlier
    const cliVariables = Object.keys(variablesMap).length > 0 ? variablesMap : undefined;

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
                if (cliVariables) {
                    parserOptions.variables = cliVariables;
                    if (argv.debug) {
                        console.log('[DEBUG] Compile-time variables:', JSON.stringify(cliVariables, null, 2));
                    }
                }
                try {
                    expandedYaml = cliParser.expandPipelineFromString(sourceText, parserOptions);
                    yamlToFormat = expandedYaml;
                } catch (expandError) {
                    // Refine template hint errors to desired phrasing
                    const msg = typeof expandError?.message === 'string' ? expandError.message : String(expandError);
                    const potentialIssuesMatch = msg.match(/Template\s+'([^']+)'\s+potential issues:([\s\S]*)/);
                    if (potentialIssuesMatch) {
                        const tmpl = potentialIssuesMatch[1];
                        const tail = (potentialIssuesMatch[2] || '').trimEnd();
                        const refined = `[${filePath}] Template(${tmpl}) expansion failed. Potential issues:${tail ? `${tail}` : ''}`;
                        console.error(refined);
                    } else {
                        const lines = msg.split('\n');
                        const firstLine = lines[0];
                        const restLines = lines
                            .slice(1)
                            .map((line) => '  ' + line)
                            .join('\n');
                        const formatted = restLines
                            ? `[${filePath}] Template expansion failed\n  ${firstLine}\n${restLines}`
                            : `[${filePath}] Template expansion failed\n  ${firstLine}`;
                        console.error(formatted);
                    }
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
