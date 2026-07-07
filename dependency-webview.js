'use strict';

// Generates the HTML/CSS/JS for the Pipeline Diagram (Dependency Analysis) webview panel.

function _generateDependencyViewHtml(projectName, mermaidDiagram, stageCountForDisplay) {
    return `<!DOCTYPE html>
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
        const vscode = acquireVsCodeApi();

        window.openInBrowser = function() {
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
            mermaid
                .run({ querySelector: '.mermaid' })
                .then(function() {
                    document.querySelectorAll('[id^="flowchart-stage_"],[id^="flowchart-job_"]').forEach(function(el) {
                        const m = el.id.match(/^flowchart-((?:stage|job)_[^-]+)/);
                        if (!m) return;
                        el.style.cursor = 'pointer';
                        el.addEventListener('click', function(e) {
                            e.stopPropagation();
                            const stageName = m[1].replace(/^(?:stage|job)_/, '');
                            vscode.postMessage({ command: 'getStageYaml', stageName: stageName });
                        });
                    });
                })
                .catch(function(error) {
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
}

function _generateDiagramLoadingHtml(projectName) {
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
}

module.exports = { _generateDependencyViewHtml, _generateDiagramLoadingHtml };
