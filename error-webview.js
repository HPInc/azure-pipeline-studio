'use strict';

// Generates the HTML/CSS/JS for the Pipeline Error webview panel.

function _generateErrorViewHtml(titleHtml, errorDetailsHtml, tipsHtml, stackHtml) {
    return `
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
                    <h1>${titleHtml}</h1>
                    
                    <h2>Error Details</h2>
                    <div class="error-details">
                        <code>${errorDetailsHtml}</code>
                    </div>

                    ${tipsHtml}

                    <h2>Stack Trace</h2>
                    <div class="stack-trace">
                        <pre>${stackHtml}</pre>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    document.addEventListener('click', function(e) {
                        var link = e.target.closest('.file-link');
                        if (!link) return;
                        if (link.hasAttribute('data-filepath')) {
                            var filePath = link.getAttribute('data-filepath');
                            var line = link.getAttribute('data-line');
                            vscode.postMessage({
                                command: 'openFile',
                                filePath: filePath,
                                lineNumber: line ? parseInt(line, 10) : null
                            });
                        } else if (link.getAttribute('data-action') === 'configure-root') {
                            vscode.postMessage({ command: 'configurePipelineRoot' });
                        }
                    });
                </script>
            </body>
            </html>
        `;
}

module.exports = { _generateErrorViewHtml };
