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
    let isRendering = false;
    let pendingDocument = null;
    const renderedScheme = 'ado-pipeline-expanded';
    const renderedContent = new Map();
    const renderedEmitter = new vscode.EventEmitter();

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
        const formatOptions = getFormatSettings(document);
        formatOptions.fileName = document.fileName;
        formatOptions.wasExpanded = false;
        const formatResult = formatYaml(originalText, formatOptions);

        if (formatResult.error) {
            vscode.window.showErrorMessage(formatResult.error);
            return;
        }

        if (formatResult.text === originalText) {
            if (formatResult.warning) {
                vscode.window.showWarningMessage(formatResult.warning);
            } else {
                vscode.window.showInformationMessage('YAML is already formatted.');
            }
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

        if (formatResult.warning) {
            vscode.window.showWarningMessage(formatResult.warning);
        } else {
            vscode.window.setStatusBarMessage('Applied YAML formatting.', 3000);
        }
    };

    const scheduleRender = (document, delayMs = 500) => {
        if (!shouldRenderDocument(document)) return;
        pendingDocument = document;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (isRendering) return;
            const doc = pendingDocument;
            pendingDocument = null;
            void renderYamlDocument(doc, { silent: true });
        }, delayMs);
    };

    const renderYamlDocument = async (document, options = {}) => {
        if (!document) return;

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
            const targetUri = getRenderTargetUri(document);

            // Clear any previous content and show error prominently
            const errorMessage = [
                '# ❌ Error Expanding Azure Pipeline',
                '',
                '## Error Details',
                '',
                '```',
                error.message || String(error),
                '```',
                '',
                '---',
                '',
                '**Tip**: Check the indentation in your YAML file. Common issues include:',
                '- `steps:` not properly indented under `job:`',
                '- Missing or extra spaces in YAML structure',
                '- Template expressions that are malformed',
                '',
                '## Stack Trace',
                '',
                '```',
                error.stack || 'No stack trace available',
                '```',
            ].join('\n');

            renderedContent.set(targetUri.toString(), errorMessage);
            renderedEmitter.fire(targetUri);

            // Always show errors, even in silent mode
            const targetDoc = await vscode.workspace.openTextDocument(targetUri);
            await vscode.window.showTextDocument(targetDoc, {
                viewColumn: vscode.ViewColumn.Beside,
                preview: false,
                preserveFocus: true,
            });

            vscode.window.showErrorMessage(`Failed to expand Azure Pipeline: ${error.message}`);
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

    const showDependenciesCommandDisposable = vscode.commands.registerCommand(
        'azurePipelineStudio.showDependencies',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !shouldRenderDocument(editor.document)) {
                vscode.window.showInformationMessage('Open an Azure Pipeline YAML file to view dependencies.');
                return;
            }

            try {
                const sourceText = editor.document.getText();
                const document = editor.document;

                // Expand the template first (similar to showRenderedYaml)
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

                vscode.window.setStatusBarMessage('Expanding pipeline templates...', 2000);
                const expandedYaml = parser.expandPipelineFromString(sourceText, parserOverrides);

                // Analyze the expanded pipeline
                vscode.window.setStatusBarMessage('Analyzing dependencies...', 2000);
                const dependencies = dependencyAnalyzer.analyzePipeline(expandedYaml);

                // Create webview panel to display diagram
                const panel = vscode.window.createWebviewPanel(
                    'pipelineDependencies',
                    'Pipeline Dependencies',
                    vscode.ViewColumn.Beside,
                    { enableScripts: true }
                );

                // Generate Mermaid diagram
                const mermaidDiagram =
                    dependencies.stages.length > 0 || dependencies.jobs.length > 0
                        ? dependencyAnalyzer.generateMermaidDiagram(dependencies)
                        : '';

                // Create HTML content with professional styling
                const projectName =
                    lastRenderedDocument?.fileName?.split('/').pop()?.replace('.yaml', '') || 'Pipeline';
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
                <div class="legend">
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

                <div class="diagram-container">
                    <div class="mermaid">
${mermaidDiagram
    .split('\n')
    .map((line) => '                        ' + line)
    .join('\n')}
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
        
        // Initialize Mermaid
        mermaid.initialize({ 
            startOnLoad: true,
            theme: 'dark',
            flowchart: {
                useMaxWidth: true,
                htmlLabels: true,
                curve: 'basis'
            }
        });
        mermaid.contentLoaded();
        
        // Initial render
        renderStages();
    </script>
</body>
</html>`;

                panel.webview.html = htmlContent;

                // Handle messages from webview
                panel.webview.onDidReceiveMessage(
                    async (message) => {
                        if (message.command === 'openInBrowser') {
                            try {
                                const os = require('os');
                                const tempFile = path.join(os.tmpdir(), `pipeline-dependencies-${Date.now()}.html`);
                                fs.writeFileSync(tempFile, htmlContent);
                                await vscode.env.openExternal(vscode.Uri.file(tempFile));
                                vscode.window.showInformationMessage('Opened dependencies in browser');
                            } catch (err) {
                                vscode.window.showErrorMessage(`Failed to open in browser: ${err.message}`);
                            }
                        }
                    },
                    undefined,
                    context.subscriptions
                );

                vscode.window.setStatusBarMessage('Pipeline dependencies analyzed.', 3000);
            } catch (error) {
                console.error('Error analyzing dependencies:', error);
                vscode.window.showErrorMessage(`Failed to analyze dependencies: ${error.message}`);
            }
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
                    placeHolder: 'templatesRepo',
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

function deactivate() {}

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
        '  -R, --format-recursive <path>    Format files recursively in directory\n' +
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
    const formatRecursive = toArray(argv['format-recursive']);
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

    if (formatRecursive.length) {
        const formatOverrides = buildFormatOptionsFromCli(formatOption) || {};
        const extensionFilters = extension.length ? extension : ['.yml', '.yaml'];
        const recursiveResult = formatFilesRecursively(formatRecursive, extensionFilters, formatOverrides);
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

    const filesToFormat = argv._;

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
