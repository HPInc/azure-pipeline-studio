'use strict';

// Generates the HTML/CSS/JS for the Pipeline Simulation webview panel.

const _b64Encode = (str) => Buffer.from(String(str), 'utf8').toString('base64');

function _generateSimulationViewHtml(
    stageTree,
    fileName,
    topLevelParameterDefinitions = [],
    nonce = '',
    knownVarsJson = '{"azure":[],"pipeline":[],"groups":[]}',
    savedVarsJson = '{"overrides":{},"libData":[]}',
    expandedStepsJson = '[]',
    originalSourceText = ''
) {
    const esc = (s) =>
        String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // Base64 encode JSON to safely pass through template literals and HTML
    const topLevelParametersJson = _b64Encode(JSON.stringify(topLevelParameterDefinitions || []));
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
                                        `<button class="sidebar-run-btn" title="Run this step" onclick="openRunStepModal(event,${si},${ji},${ti})">&#9654;</button>` +
                                        `</div>`
                                )
                                .join('') || '<div class="empty-msg">No tasks</div>';

                        return (
                            `<div class="sidebar-job-item">` +
                            `<div class="sidebar-job-header" onclick="toggleSidebarJob(event,'ssjt-${si}-${ji}','ssjto-${si}-${ji}',${si},${ji})">` +
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
                `<div class="sidebar-stage ${si === 0 ? 'active' : ''}" data-stage-index="${si}" onclick="selectStage(${si})">` +
                `<div class="sidebar-stage-header" onclick="toggleSidebarStage(event,${si})">` +
                `<span class="sidebar-toggle" id="sst-${si}"></span>` +
                `<span class="sidebar-result" id="ssr-stage-${si}">•</span>` +
                `<span class="stage-checkbox-wrap" onclick="event.stopPropagation()"><input type="checkbox" class="stage-cb" data-name="${esc(stage.name)}" checked onchange="onStageSelectionChange()"></span>` +
                `<span class="stage-indicator"></span>` +
                `<span class="sidebar-stage-name">${esc(stage.displayName)}</span>` +
                `<button class="sidebar-stage-run-btn" data-stage-name="${esc(stage.name)}" title="Run this stage" onclick="runSingleStage(event,this)">&#9654;</button>` +
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
            const stepDetailPanels = stage.jobs
                .map((job, ji) =>
                    job.steps
                        .map((step, ti) => {
                            const taskInputs = (() => {
                                try {
                                    return JSON.parse(step.taskInputsJson || '{}');
                                } catch (_) {
                                    return {};
                                }
                            })();
                            const envEntries = Object.entries(step.stepEnv || {});
                            let bodyHtml = '';
                            if (step.scriptContent) {
                                bodyHtml += `<div class="sdp-section"><div class="sdp-section-title">Script</div><pre class="sdp-script">${esc(step.scriptContent)}</pre></div>`;
                            }
                            const inputEntries = Object.entries(taskInputs).filter(([k]) => k !== 'script');
                            if (inputEntries.length > 0) {
                                bodyHtml += `<div class="sdp-section"><div class="sdp-section-title">Inputs</div><table class="sdp-table">${inputEntries.map(([k, v]) => `<tr><td class="sdp-k">${esc(k)}</td><td class="sdp-v">${esc(String(v))}</td></tr>`).join('')}</table></div>`;
                            }
                            if (envEntries.length > 0) {
                                bodyHtml += `<div class="sdp-section"><div class="sdp-section-title">Environment</div><table class="sdp-table">${envEntries.map(([k, v]) => `<tr><td class="sdp-k">${esc(k)}</td><td class="sdp-v">${esc(String(v))}</td></tr>`).join('')}</table></div>`;
                            }
                            if (!bodyHtml) bodyHtml = '<div class="sdp-empty">No details available</div>';
                            return (
                                `<div class="sdp" id="sdp-${si}-${ji}-${ti}" style="display:none">` +
                                `<div class="sdp-hd">` +
                                `<span class="sdp-icon" style="color:${STEP_COLORS[step.type] || '#a0aec0'}">${STEP_ICONS[step.type] || '▸'}</span>` +
                                `<span class="sdp-title">${esc(step.label)}</span>` +
                                `<span class="sdp-badge">${esc(step.type)}</span>` +
                                (step.taskName ? `<span class="sdp-taskname">${esc(step.taskName)}</span>` : '') +
                                `</div>${bodyHtml}</div>`
                            );
                        })
                        .join('')
                )
                .join('');

            return (
                `<div class="stage-content ${si === 0 ? 'active' : ''}" data-stage-index="${si}">` +
                `${stepDetailPanels}` +
                `</div>`
            );
        })
        .join('');

    const baseName = fileName.split(/[\\/]/).pop();

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
.sidebar-stage-run-btn{background:none;border:none;color:#5a9fd4;cursor:pointer;font-size:.72em;padding:1px 5px;border-radius:2px;flex-shrink:0;line-height:1.4;opacity:0;margin-left:auto}
.sidebar-stage-header:hover .sidebar-stage-run-btn,.sidebar-stage.active .sidebar-stage-run-btn{opacity:1}
.sidebar-stage-run-btn:hover{background:#0078d4;color:#fff}
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
.job-item{display:block;background:#2a2a2a;border:1px solid #3e3e42;border-radius:3px;overflow:hidden}
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
.sdp{padding:12px 0}
.sdp-hd{display:flex;align-items:center;gap:8px;padding-bottom:12px;border-bottom:1px solid #3e3e42;margin-bottom:12px}
.sdp-icon{font-size:1.1em}
.sdp-title{font-size:1.05em;font-weight:600;color:#e8e8e8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdp-badge{font-size:.75em;padding:2px 7px;border-radius:3px;background:#252526;color:#9cdcfe;border:1px solid #3e3e42;font-weight:600;white-space:nowrap}
.sdp-taskname{font-size:.8em;color:#777;white-space:nowrap}
.sdp-section{margin-bottom:14px}
.sdp-section-title{font-size:.77em;font-weight:700;color:#777;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.sdp-script{background:#1a1a1a;border:1px solid #3e3e42;border-radius:4px;padding:10px 12px;font-size:.83em;color:#d4d4d4;overflow-x:auto;white-space:pre;margin:0;font-family:Consolas,'Courier New',monospace;max-height:400px;overflow-y:auto}
.sdp-table{border-collapse:collapse;width:100%}
.sdp-table tr+tr td{border-top:1px solid #2d2d30}
.sdp-k{color:#9cdcfe;padding:4px 10px 4px 0;white-space:nowrap;vertical-align:top;font-size:.83em}
.sdp-v{color:#ce9178;padding:4px 0;word-break:break-all;font-size:.83em}
.sdp-empty{color:#666;font-size:.88em;padding:10px 0;font-style:italic}
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
.run-step-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1000;display:flex;align-items:center;justify-content:center}
.run-step-modal{background:#252526;border:1px solid #555;border-radius:6px;padding:24px 28px;width:min(700px,90vw);max-height:80vh;overflow-y:auto;display:flex;flex-direction:column;gap:14px}
.rsm-title{font-size:1.05em;font-weight:700;color:#e8e8e8}
.rsm-subtitle{font-size:.9em;color:#aaa;margin-top:4px;margin-bottom:8px}
.rsm-section{font-size:.78em;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:6px;margin-top:2px}
.rsm-refs-grid{display:flex;flex-direction:column;gap:6px}
.rsm-ref-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center}
.rsm-ref-name{font-family:monospace;font-size:.82em;color:#9cdcfe;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rsm-ref-input{background:#2d2d30;border:1px solid #3e3e42;color:#e0e0e0;padding:5px 8px;border-radius:3px;font-size:.82em;width:100%}
.rsm-ref-input:focus{outline:none;border-color:#0078d4}
.rsm-envvars{display:flex;flex-direction:column;gap:5px}
.rsm-envrow{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:center}
.rsm-envkey,.rsm-envval{background:#2d2d30;border:1px solid #3e3e42;color:#e0e0e0;padding:4px 7px;border-radius:3px;font-size:.82em;width:100%;font-family:monospace}
.rsm-envkey:focus,.rsm-envval:focus{outline:none;border-color:#0078d4}
.rsm-actions{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px}
.rsm-run-btn{background:#0078d4;border:none;color:#fff;padding:8px 18px;border-radius:3px;cursor:pointer;font-size:.9em;font-weight:600}.rsm-run-btn:hover{background:#005a9e}
.rsm-cancel-btn{background:#3d3d3f;border:1px solid #555;color:#ccc;padding:8px 14px;border-radius:3px;cursor:pointer;font-size:.88em;font-weight:600}.rsm-cancel-btn:hover{background:#4a4a4e;border-color:#888}
.sidebar-run-btn{background:none;border:none;color:#5a9fd4;cursor:pointer;font-size:.72em;padding:1px 5px;border-radius:2px;flex-shrink:0;line-height:1.4;opacity:0;margin-left:auto}
.sidebar-task-row:hover .sidebar-run-btn{opacity:1}.sidebar-run-btn:hover{background:#0078d4;color:#fff}
#pageLoader{position:fixed;inset:0;background:#1e1e1e;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:9999}
#pageLoader .pl-spinner{width:28px;height:28px;border:3px solid #3e3e42;border-top-color:#569cd6;border-radius:50%;animation:aps-spin .8s linear infinite}
#pageLoader .pl-text{font-size:.85em;color:#666}
</style></head>
<body>
<div id="pageLoader"><div class="pl-spinner"></div><div class="pl-text">Loading…</div></div>
<div id="__aps_data" data-top-params="${topLevelParametersJson}" data-known-vars="${knownVarsJson}" data-saved-vars="${savedVarsJson}" data-expanded-steps="${expandedStepsJson}" data-source-text="${originalSourceText}" data-pipeline-dir="${esc(baseName && fileName ? fileName.slice(0, fileName.length - baseName.length - 1) : '')}"></div>
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
          <span class="status-msg" id="statusMsg"></span>
        </div>
      </div>
    </div>
        <div class="body" id="renderBody">
            <div class="body-toolbar"><button class="res-browser-btn" id="browserBtn" onclick="openResultsInBrowser()" style="display:none">&#127760; Open in Browser</button></div>
      <div id="stageContents">${stageContentsHtml || '<div class="empty-msg">No stages found</div>'}</div>
      <div id="resultsPanel"></div>
    </div>
  </div>
</div>
<div id="runStepModalBg" class="run-step-modal-bg" style="display:none" onclick="if(event.target===this)closeRunStepModal()">
  <div class="run-step-modal">
    <div class="rsm-title">Run Single Step</div>
    <div class="rsm-subtitle" id="rsmSubtitle"></div>
    <div id="rsmParamsSection" style="display:none">
      <div class="rsm-section">Parameters</div>
      <div class="rsm-refs-grid" id="rsmParamRows"></div>
    </div>
    <div id="rsmMacrosSection" style="display:none">
      <div class="rsm-section">Environment Variables</div>
      <div class="rsm-refs-grid" id="rsmMacroRows"></div>
    </div>
    <div id="rsmVarsSection" style="display:none">
      <div class="rsm-section">Variables</div>
      <div class="rsm-refs-grid" id="rsmVarRows"></div>
    </div>
    <div id="rsmEnvSection" style="display:none">
      <div class="rsm-section">Additional Environment</div>
      <div class="rsm-envvars" id="rsmEnvRows"></div>
      <button class="add-var-btn" onclick="addRsmEnvRow()" style="margin-top:6px">+ Add</button>
    </div>
    <div class="rsm-actions">
      <div style="display:flex;gap:8px">
        <button class="rsm-run-btn" onclick="submitRunStep()">&#9654; Run Step</button>
        <button class="rsm-cancel-btn" onclick="closeRunStepModal()">Cancel</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="rsmDebugMode" style="cursor:pointer;accent-color:#0078d4;width:14px;height:14px">
        <label for="rsmDebugMode" class="field-label" style="cursor:pointer">Enable Debug</label>
      </div>
    </div>
  </div>
</div>
<script>
window.onerror=function(msg,src,line,col,err){var l=document.getElementById('pageLoader');if(l){l.innerHTML='<div style="color:#f47174;padding:20px;font-family:monospace;font-size:13px"><b>JS Error (line '+line+'):</b><br>'+msg+'<br><br>'+(err&&err.stack?err.stack.replace(/\\n/g,'<br>'):'')+'</div>';}return false;};
window.addEventListener('unhandledrejection',function(e){var l=document.getElementById('pageLoader');if(l){l.innerHTML='<div style="color:#f47174;padding:20px;font-family:monospace;font-size:13px"><b>Unhandled Promise Rejection:</b><br>'+String(e.reason)+'</div>';}});
const vscode=acquireVsCodeApi();let varCount=0;let libVarCount=0;let taskFilter=null;let lastResults=null;
const _b64Decode=(str)=>{try{return new TextDecoder().decode(Uint8Array.from(atob(str),c=>c.charCodeAt(0)));}catch(e){console.error('b64Decode error:',e,str&&str.slice(0,40));return str;}};const dataEl=document.getElementById('__aps_data');function _safeJsonParse(b64,fallback){try{var dec=_b64Decode(b64||'');console.log('[aps] decoded (first 80):', dec&&dec.slice(0,80));return JSON.parse(dec);}catch(e){console.error('[aps] _safeJsonParse failed, b64=',b64&&b64.slice(0,40),e);return fallback;}}const _rawKnownVars=_safeJsonParse(dataEl.getAttribute('data-known-vars'),{});const knownVars={azure:Array.isArray(_rawKnownVars.azure)?_rawKnownVars.azure:[],pipeline:Array.isArray(_rawKnownVars.pipeline)?_rawKnownVars.pipeline:[],groups:Array.isArray(_rawKnownVars.groups)?_rawKnownVars.groups:[]};const _rawSavedVars=_safeJsonParse(dataEl.getAttribute('data-saved-vars'),{});const savedVars={overrides:(_rawSavedVars.overrides&&typeof _rawSavedVars.overrides==='object')?_rawSavedVars.overrides:{},libData:Array.isArray(_rawSavedVars.libData)?_rawSavedVars.libData:[],toolPaths:(_rawSavedVars.toolPaths&&typeof _rawSavedVars.toolPaths==='object')?_rawSavedVars.toolPaths:{}};const topLevelParameterDefinitions=_safeJsonParse(dataEl.getAttribute('data-top-params'),[]);window._expandedSteps=_safeJsonParse(dataEl.getAttribute('data-expanded-steps'),[]);window._originalSourceText=_safeJsonParse(dataEl.getAttribute('data-source-text'),'');window._pipelineDir=dataEl.getAttribute('data-pipeline-dir')||'';console.log('[aps] init: stages=',document.querySelectorAll('.sidebar-stage').length,'knownVars.azure=',knownVars.azure.length,'topLevelParams=',topLevelParameterDefinitions.length);function _normParamType(t){return String(t||'string').trim().toLowerCase();}
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
function _selectOnlyStage(stageName){
    const target=String(stageName||'').trim();
    if(!target)return false;
    let found=false;
    document.querySelectorAll('.stage-cb').forEach(function(cb){
        const name=String((cb && cb.dataset && cb.dataset.name) || '').trim();
        const matches=name===target;
        cb.checked=matches;
        if(matches)found=true;
    });
    syncSelectAllStages();
    return found;
}
function runSingleStage(event,button){
    if(event)event.stopPropagation();
    const stageName=String((button&&button.getAttribute('data-stage-name'))||'').trim();
    if(!stageName)return;
    const found=_selectOnlyStage(stageName);
    if(!found){
        const status=document.getElementById('statusMsg');
        if(status)status.textContent='⚠ Could not find selected stage';
        return;
    }
    runSimulation();
}
function _scrollToInBody(el){
    var rb=document.getElementById('renderBody');
    if(!rb||!el)return;
    var top=el.getBoundingClientRect().top-rb.getBoundingClientRect().top+rb.scrollTop-8;
    rb.scrollTo({top:Math.max(0,top),behavior:'smooth'});
}
function selectStage(index){
    taskFilter=null;
    document.querySelectorAll('.sidebar-task-row').forEach(el=>el.classList.remove('active'));
    document.querySelectorAll('.sidebar-stage').forEach((el,i)=>{el.classList.toggle('active',i===index);});
    document.querySelectorAll('.stage-content').forEach((el,i)=>{el.classList.toggle('active',i===index);});
    document.querySelectorAll('.sdp').forEach(function(el){el.style.display='none';});
    var rp=document.getElementById('resultsPanel');
    if(rp)rp.style.display='';
    applyTaskFilter();
    var stageEl=document.querySelector('.res-stage[data-stage-index="'+String(index)+'"]');
    if(stageEl){
        var body=stageEl.querySelector('.res-body');
        if(body)body.classList.remove('collapsed');
        var tog=stageEl.querySelector('.res-tog');
        if(tog)tog.textContent='\u25bc';
        _scrollToInBody(stageEl);
    }
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
function toggleSidebarJob(event,bodyId,toggleId,stageIndex,jobIndex){
    if(event)event.stopPropagation();
    toggleCollapse(bodyId,toggleId);
    if(stageIndex!==undefined){
        selectStage(stageIndex);
        var jobEl=document.querySelector('.res-job[data-stage-index="'+String(stageIndex)+'"][data-job-index="'+String(jobIndex)+'"]');
        if(jobEl){
            var body=jobEl.querySelector('.res-body');
            if(body)body.classList.remove('collapsed');
            var tog=jobEl.querySelector('.res-tog');
            if(tog)tog.textContent='\u25bc';
            _scrollToInBody(jobEl);
        }
    }
}
function selectSidebarTask(event,stageIndex,jobIndex,stepIndex){
    if(event)event.stopPropagation();
    selectStage(stageIndex);
    taskFilter={stageIndex,jobIndex,stepIndex};
    document.querySelectorAll('.sidebar-task-row').forEach(el=>el.classList.remove('active'));
    if(event&&event.currentTarget)event.currentTarget.classList.add('active');
    document.querySelectorAll('.sdp').forEach(function(el){el.style.display='none';});
    var sdp=document.getElementById('sdp-'+stageIndex+'-'+jobIndex+'-'+stepIndex);
    if(sdp){_populateSdpResult(sdp,stageIndex,jobIndex,stepIndex);sdp.style.display='';}
    expandResultsForTask(stageIndex,jobIndex);
    applyTaskFilter();
    var rp=document.getElementById('resultsPanel');
    if(rp)rp.style.display='none';
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
function addToolPath(){var tb=document.getElementById('toolPathsRows');if(!tb)return;var tr=document.createElement('tr');tr.innerHTML='<td style="width:48%"><input class="var-key tool-name" placeholder="tool (e.g. bash)"></td><td><div style="display:flex;gap:4px;align-items:center"><input class="var-val tool-path" placeholder="path" style="flex:1;min-width:0"><button class="add-var-btn" title="Browse for executable" onclick="browseToolPath(this)" style="flex-shrink:0;padding:2px 6px">&#128193;</button></div></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){tr.remove();};tb.appendChild(tr);var inp=tr.querySelector('.tool-name');if(inp)inp.focus();}
function _collectToolPaths(){var paths={};document.querySelectorAll('#toolPathsRows tr').forEach(function(row){var n=row.querySelector('.tool-name');var p=row.querySelector('.tool-path');if(n&&p&&n.value.trim()&&p.value.trim())paths[n.value.trim()]=p.value.trim();});return paths;}
function saveToolPaths(btn){vscode.postMessage({command:'saveToolPaths',data:{toolPaths:_collectToolPaths()}});_btnFeedback(btn,'Saved \u2713','#4ec9b0');}
function clearToolPaths(btn){var tb=document.getElementById('toolPathsRows');if(tb)tb.innerHTML='';vscode.postMessage({command:'clearToolPaths'});_btnFeedback(btn,'Cleared','#ce9178');}
var _toolPathBrowseRow=null;
function browseToolPath(btn){_toolPathBrowseRow=btn.closest('tr');vscode.postMessage({command:'browseToolPath'});}
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
    if(knownVars.pipeline&&knownVars.pipeline.length){
        html+='<div class="var-group-label var-toggle" data-target="pipelineVarsBody" onclick="toggleVarSubSection(this)"><span class="sidebar-toggle" style="transform:rotate(90deg)"></span>Pipeline Variables<button class="sec-save-btn" onclick="_btnClick(event,saveVars)" title="Save Pipeline Variables">Save</button></div>';
        html+='<div id="pipelineVarsBody"><table class="vars-table vars-ref-table"><thead><tr><th class="varth" style="width:40%">Variable</th><th class="varth" style="width:30%">Default (YAML)</th><th class="varth">Override</th></tr></thead><tbody>';
        knownVars.pipeline.forEach(function(v){
            var en=e(v.name);
            var ev=e(v.value||'');
            html+='<tr><td class="varref-name">'+en+'</td><td class="varref-val">'+ev+'</td><td><input class="var-override-input var-val" data-varname="'+en+'" placeholder="'+ev+'" value="'+ev+'" style="width:100%"></td></tr>';
        });
        html+='</tbody></table></div>';
    }
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
    vscode.postMessage({command:'saveLibVars',data:{libData:_collectLibData()}});
    vscode.postMessage({command:'saveAzureVars',data:{overrides:_collectAzureOverrides()}});
    vscode.postMessage({command:'runSimulation',stages,buildCounter,variables,libraryVariables:libVars,parameters,toolPaths:_collectToolPaths()});
  }catch(e){console.error('[aps] runSimulation error',e);document.getElementById('resultsPanel').innerHTML='';document.getElementById('statusMsg').textContent='⚠ JS error: '+String(e);document.getElementById('runBtn').disabled=false;}
}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
let _rsmState={si:0,ji:0,ti:0};
function _extractRefsFromYaml(sourceText,searchContext){
  const params=new Set(),vars=new Set(),macros=new Set();
  let m;
  const pr=/\$\{\{\s*parameters?\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  const vr=/\$\{\{\s*variables?\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  const mr=/\$\(([A-Za-z_][A-Za-z0-9_.]*)\)/g;
  const s=String(sourceText||'');
  console.log('_extractRefsFromYaml input (first 300 chars):',s.substring(0,300));
  console.log('Testing regex mr on sample: $(...) matches?', /\$\(([A-Za-z_][A-Za-z0-9_.]*)\)/g.test(s));
  while((m=pr.exec(s))!==null){console.log('Found param:',m[1]);params.add(m[1]);}
  while((m=vr.exec(s))!==null){console.log('Found var:',m[1]);vars.add(m[1]);}
  while((m=mr.exec(s))!==null){console.log('Found macro:',m[1]);macros.add(m[1]);}
  return{params:[...params],vars:[...vars],macros:[...macros]};
}
function openRunStepModal(event,si,ji,ti){
  try{
  event.stopPropagation();
  const stepArr=(window._expandedSteps[si]||[]);
  const step=(stepArr[ji]||[])[ti];
  if(!step){console.error('Step not found',si,ji,ti);return;}
  _rsmState={si,ji,ti};
  document.getElementById('rsmSubtitle').textContent=step.label||'Step';
  
  // Template params take priority; fall back to runtime var refs for steps not from a template
  const paramDefs=Array.isArray(step.templateParams)&&step.templateParams.length?step.templateParams:null;
  const params=new Set(paramDefs?paramDefs.map(function(p){return p.name;}):(Array.isArray(step.referencedRuntimeVars)?step.referencedRuntimeVars:[]));
  // Variables = all $(VAR) refs in the expanded step, excluding template param names
  const allVarRefs=[...(Array.isArray(step.referencedRuntimeVars)?step.referencedRuntimeVars:[]),...(Array.isArray(step.referencedCompileTimeVars)?step.referencedCompileTimeVars:[])];
  const vars=new Set(allVarRefs.filter(function(name){return !params.has(name);}));
  var _sbEl=document.getElementById('sourceBranch');var _brEl=document.getElementById('buildReason');var _dbgEl=document.getElementById('debugMode');var _bcEl=document.getElementById('buildCounter');var _settingsDerived={};
  if(_sbEl&&_sbEl.value.trim()){var _sv=_sbEl.value.trim();var _sbn=_sv.startsWith('refs/heads/')?_sv.slice(11):(_sv.split('/').pop()||_sv);_settingsDerived['Build.SourceBranch']=_sv;_settingsDerived['Build.SourceBranchName']=_sbn;}
  if(_brEl&&_brEl.value)_settingsDerived['Build.Reason']=_brEl.value;
  if(_dbgEl)_settingsDerived['System.Debug']=_dbgEl.checked?'true':'false';
  if(_bcEl&&_bcEl.value){_settingsDerived['Build.BuildNumber']=_bcEl.value;_settingsDerived['Build.BuildId']=_bcEl.value;}
  var _agentDefaults=(function(){var d=window._pipelineDir||'/agent/_work/1';var sim=d+'/simulation';return{'Agent.TempDirectory':sim+'/agent/tmp','Agent.BuildDirectory':sim+'/build-artifacts','Agent.WorkFolder':sim,'Agent.HomeDirectory':sim+'/agent','Agent.ToolsDirectory':sim+'/agent','Agent.OS':'Linux','Build.SourcesDirectory':sim+'/workspace','Build.Repository.LocalPath':sim+'/workspace','System.DefaultWorkingDirectory':sim+'/workspace','Build.ArtifactStagingDirectory':sim+'/artifacts','Build.StagingDirectory':sim+'/staging','Build.BinariesDirectory':sim+'/binaries','Pipeline.Workspace':sim+'/workspace','System.TeamProject':'MyProject'};})();
  const varDefaults=Object.assign({},_agentDefaults,_settingsDerived,savedVars&&savedVars.overrides?savedVars.overrides:{},_collectAzureOverrides());
  
  // Build paramDefaults: template param values take priority, then stepEnv, then saved overrides
  const paramDefaults={};
  if(paramDefs){
    paramDefs.forEach(function(p){if(p.value!==undefined&&p.value!==null)paramDefaults[p.name]=String(p.value);});
  }
  const envObj=step.stepEnv||{};
  Object.keys(envObj).forEach(function(key){if(params.has(key)&&!paramDefaults[key])paramDefaults[key]=String(envObj[key]||'');});
  
  // Collect current values from top-level parameter controls in the Settings panel
  const paramPanelValues={};
  document.querySelectorAll('.param-control[data-param-name]').forEach(function(ctrl){
    var pname=ctrl.getAttribute('data-param-name');
    if(!pname)return;
    var val=ctrl.type==='checkbox'?(ctrl.checked?'true':'false'):(ctrl.value||ctrl.getAttribute('data-param-default')||'');
    if(val)paramPanelValues[pname]=val;
  });
  
  // Supplement defaults from known pipeline variables
  if(Array.isArray(knownVars&&knownVars.pipeline)){
    knownVars.pipeline.forEach(function(pv){
      if(!pv||!pv.name)return;
      if(params.has(pv.name)&&!paramDefaults[pv.name])paramDefaults[pv.name]=pv.value||'';
      if(!(pv.name in varDefaults))varDefaults[pv.name]=pv.value||'';
    });
  }
  
  const rsmParamRows=document.getElementById('rsmParamRows');
  const rsmParamsSection=document.getElementById('rsmParamsSection');
  rsmParamRows.innerHTML='';
  if(params.size){
    rsmParamsSection.style.display='';
    params.forEach(function(name){
      const row=document.createElement('div');row.className='rsm-ref-row';
      const defaultVal=paramDefaults[name]||paramPanelValues[name]||'';
      row.innerHTML='<span class="rsm-ref-name" title="'+escHtml(name)+'">'+escHtml(name)+'</span>'
        +'<input class="rsm-ref-input" data-ref-type="param" data-ref-key="'+escHtml(name)+'" placeholder="'+escHtml(defaultVal)+'" value="'+escHtml(defaultVal)+'">';
      rsmParamRows.appendChild(row);
    });
  }else{rsmParamsSection.style.display='none';}
  
  const rsmMacroRows=document.getElementById('rsmMacroRows');
  const rsmMacrosSection=document.getElementById('rsmMacrosSection');
  rsmMacrosSection.style.display='none';
  
  const rsmVarRows=document.getElementById('rsmVarRows');
  const rsmVarsSection=document.getElementById('rsmVarsSection');
  rsmVarRows.innerHTML='';
  if(vars.size){
    rsmVarsSection.style.display='';
    vars.forEach(function(name){
      const row=document.createElement('div');row.className='rsm-ref-row';
      const defaultVal=varDefaults[name]||'';
      row.innerHTML='<span class="rsm-ref-name" title="'+escHtml(name)+'">'+escHtml(name)+'</span>'
        +'<input class="rsm-ref-input" data-ref-type="var" data-ref-key="'+escHtml(name)+'" placeholder="'+escHtml(defaultVal)+'" value="'+escHtml(defaultVal)+'">';
      rsmVarRows.appendChild(row);
    });
  }else{rsmVarsSection.style.display='none';}
  
  document.getElementById('rsmEnvSection').style.display='none';
  const modalBg=document.getElementById('runStepModalBg');
  modalBg.style.display='flex';
  }catch(e){console.error('[aps] openRunStepModal error:',e);var _sm=document.getElementById('statusMsg');if(_sm)_sm.textContent='\u26a0 Modal error: '+String(e);}
}
function closeRunStepModal(){document.getElementById('runStepModalBg').style.display='none';}
function addRsmEnvRow(key,val){
  const row=document.createElement('div');row.className='rsm-envrow';
  row.innerHTML='<input class="rsm-envkey" placeholder="KEY" value="'+escHtml(key||'')+'">'
    +'<input class="rsm-envval" placeholder="value" value="'+escHtml(String(val||''))+'">'  
    +'<button class="remove-var-btn" onclick="this.parentElement.remove()">&times;</button>';
  document.getElementById('rsmEnvRows').appendChild(row);
}
function submitRunStep(){
  const variableOverrides={};
  const paramOverrides=[];
  var _curStep=(window._expandedSteps[_rsmState.si]||[]);
  _curStep=Array.isArray(_curStep[_rsmState.ji])?_curStep[_rsmState.ji][_rsmState.ti]:null;
  document.querySelectorAll('.rsm-ref-input').forEach(function(inp){
    const k=(inp.getAttribute('data-ref-key')||'').trim();
    const v=(inp.value||'').trim();
    if(!k)return;
    if(inp.getAttribute('data-ref-type')==='param'){
      var paramDef=_curStep&&Array.isArray(_curStep.templateParams)&&_curStep.templateParams.find(function(p){return p.name===k;});
      var oldVal=paramDef?String(paramDef.value!=null?paramDef.value:''):
'';
      if(v!==oldVal)paramOverrides.push({name:k,oldValue:oldVal,newValue:v});
    }else{
      if(v)variableOverrides[k]=v;
    }
  });
  const debugEl=document.getElementById('rsmDebugMode');
  if(debugEl&&debugEl.checked)variableOverrides['System.Debug']='true';
  const envVars={};
  document.querySelectorAll('#rsmEnvRows .rsm-envrow').forEach(function(row){
    const k=(row.querySelector('.rsm-envkey')&&row.querySelector('.rsm-envkey').value||'').trim();
    const v=(row.querySelector('.rsm-envval')&&row.querySelector('.rsm-envval').value||'').trim();
    if(k)envVars[k]=v;
  });
  const bc=parseInt((document.getElementById('buildCounter')&&document.getElementById('buildCounter').value)||'1',10);
  if(Object.keys(variableOverrides).length){
    Object.assign(savedVars.overrides,variableOverrides);
    vscode.postMessage({command:'saveStepVarOverrides',data:variableOverrides});
  }
  closeRunStepModal();
  document.getElementById('runBtn').disabled=true;
  document.getElementById('statusMsg').textContent='Running single step\u2026';
  document.getElementById('resultsPanel').innerHTML='<div class="sim-loading"><div class="sim-spinner"></div><span>Running single step\u2026</span></div>';
  var rb=document.getElementById('renderBody');if(rb)rb.classList.remove('hidden');
  var s=document.getElementById('settingsContent');if(s){s.classList.add('collapsed');document.getElementById('settingsPanel').classList.add('collapsed');var btn=document.getElementById('settingsToggle');if(btn)btn.innerHTML='&#9660; Settings';}
  var bb=document.getElementById('backBtn');if(bb)bb.style.display='inline-block';
  vscode.postMessage({command:'runSingleStep',stageIndex:_rsmState.si,jobIndex:_rsmState.ji,stepIndex:_rsmState.ti,buildCounter:isNaN(bc)?1:bc,variableOverrides:variableOverrides,paramOverrides:paramOverrides,envVars:envVars});
}
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
function _populateSdpResult(sdpEl,si,ji,ti){
  if(!lastResults)return;
  var stg=lastResults.stages[si];if(!stg)return;
  var job=stg.jobs[ji];if(!job)return;
  var step=job.steps[ti];if(!step)return;
  var ICON={Succeeded:'\u2714',Failed:'\u2716',Skipped:'\u29d8'};
  var COL={Succeeded:'#4ec94e',Failed:'#f47174',Skipped:'#c8a84b'};
  var res=step.result||'Skipped';
  var col=COL[res]||'#888';
  var body='<div style="margin-bottom:10px"><span style="color:'+col+'">'+(ICON[res]||'?')+' '+escHtml(res)+'</span></div>';
  if(step.stdout&&step.stdout.trim()){body+='<div class="sdp-section"><div class="sdp-section-title">Output</div><pre class="sdp-script">'+escHtml(step.stdout.trim())+'</pre></div>';}
  if(step.stderr&&step.stderr.trim()){body+='<div class="sdp-section"><div class="sdp-section-title">Errors / Warnings</div><pre class="sdp-script" style="color:#f47174">'+escHtml(step.stderr.trim())+'</pre></div>';}
  var ov=Object.entries(step.outputVariables||{});
  if(ov.length)body+='<div class="sdp-section"><div class="sdp-section-title">Output Variables</div><table class="sdp-table">'+ov.map(function(kv){return '<tr><td class="sdp-k">'+escHtml(kv[0])+'</td><td class="sdp-v">'+escHtml(String(kv[1]))+'</td></tr>';}).join('')+'</table></div>';
  var hd=sdpEl.querySelector('.sdp-hd');
  sdpEl.innerHTML=(hd?hd.outerHTML:'')+body;
}
function renderResults(r){
  lastResults=r;
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
                var activeSdp=document.getElementById('sdp-'+taskFilter.stageIndex+'-'+taskFilter.jobIndex+'-'+taskFilter.stepIndex);
                if(activeSdp){_populateSdpResult(activeSdp,taskFilter.stageIndex,taskFilter.jobIndex,taskFilter.stepIndex);}
        }
    applyTaskFilter();
  _scrollToInBody(panel);
}
document.getElementById('resultsPanel').addEventListener('click',function(e){
  var hd=e.target.closest('.res-collapsible');if(!hd)return;
  var body=hd.nextElementSibling;if(!body)return;
  var c=body.classList.toggle('collapsed');
  var t=hd.querySelector('.res-tog');if(t)t.textContent=c?'\u25b6':'\u25bc';
});
requestAnimationFrame(function(){requestAnimationFrame(function(){var l=document.getElementById('pageLoader');if(l)l.remove();});});
renderTopLevelParameters();
function _syncOverrideToSettings(vn,val){if(vn==='Build.SourceBranch'){var sb=document.getElementById('sourceBranch');if(sb)sb.value=val;}else if(vn==='Build.SourceBranchName'){/* skip */}else if(vn==='Build.Reason'){var br=document.getElementById('buildReason');if(br)br.value=val;}else if(vn==='System.Debug'){var dbg=document.getElementById('debugMode');if(dbg)dbg.checked=val==='true'||val==='1';}else if(vn==='Build.BuildNumber'||vn==='Build.BuildId'){var bc=document.getElementById('buildCounter');if(bc&&vn==='Build.BuildNumber')bc.value=val;}}function _applyVarsLoaded(data){if(!data)return;var o=data.overrides||{};document.querySelectorAll('.var-override-input').forEach(function(inp){var name=inp.getAttribute('data-varname');if(o[name]!==undefined)inp.value=o[name];});if(Array.isArray(data.libData)){data.libData.forEach(function(entry){var gi=knownVars.groups.indexOf(entry.group);if(gi<0)return;var tb=document.getElementById('libvars-'+gi);if(!tb)return;tb.innerHTML='';if(!Array.isArray(entry.vars))return;entry.vars.forEach(function(v){var tr=document.createElement('tr');tr.setAttribute('data-group',entry.group);var en=escHtml(v.name||'');var ev=escHtml(v.value||'');tr.innerHTML='<td style="width:48%"><input class="var-key lib-name" placeholder="variable" value="'+en+'"></td><td><input class="var-val lib-val" placeholder="value" value="'+ev+'"></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){tr.remove();};tb.appendChild(tr);});});}if(data.toolPaths&&typeof data.toolPaths==='object'){var ttp=document.getElementById('toolPathsRows');if(ttp){ttp.innerHTML='';Object.entries(data.toolPaths).forEach(function(kv){var tr=document.createElement('tr');var en=escHtml(kv[0]||'');var ev=escHtml(kv[1]||'');tr.innerHTML='<td style="width:48%"><input class="var-key tool-name" placeholder="tool (e.g. bash)" value="'+en+'"></td><td><div style="display:flex;gap:4px;align-items:center"><input class="var-val tool-path" placeholder="path" value="'+ev+'" style="flex:1;min-width:0"><button class="add-var-btn" title="Browse for executable" onclick="browseToolPath(this)" style="flex-shrink:0;padding:2px 6px">&#128193;</button></div></td><td><button class="remove-var-btn">&times;</button></td>';tr.querySelector('.remove-var-btn').onclick=function(){tr.remove();};ttp.appendChild(tr);});}}try{syncSpecialVarToPanel();}catch(e){}}window.addEventListener('load',function(){_renderVariablesPanel();_renderToolPathsPanel();_applyVarsLoaded(savedVars);setTimeout(function(){expandAll(false);selectStage(0);syncSpecialVarToPanel();syncSelectAllStages();var pb=document.getElementById('variablesPanelBody');if(pb)pb.addEventListener('input',function(e){var inp=e.target;if(!inp.classList.contains('var-override-input'))return;_syncOverrideToSettings(inp.getAttribute('data-varname'),inp.value);});vscode.postMessage({command:'loadVars'});},50);});
window.addEventListener('message',e=>{
  const d=e.data;
  if(d.command==='simulationStarted'){document.getElementById('runBtn').disabled=false;}
  else if(d.command==='simulationResults'){
    document.getElementById('runBtn').disabled=false;
    if(d.singleStep){
      const _savedFilter=taskFilter;
      taskFilter=null;
      renderResults(d.results);
      taskFilter=_savedFilter;
      const _sr=d.results&&d.results.stages&&d.results.stages[0]&&d.results.stages[0].jobs&&d.results.stages[0].jobs[0]&&d.results.stages[0].jobs[0].steps&&d.results.stages[0].jobs[0].steps[0];
      if(_sr){setSidebarResult('ssr-task-'+d.si+'-'+d.ji+'-'+d.ti,_sr.result);}
      var _activeSdp=document.getElementById('sdp-'+d.si+'-'+d.ji+'-'+d.ti);
      if(_activeSdp)_populateSdpResult(_activeSdp,0,0,0);
    }else{renderResults(d.results);}
  }
    else if(d.command==='simulationError'){document.getElementById('resultsPanel').innerHTML='';document.getElementById('statusMsg').textContent='\u26a0 '+d.error;document.getElementById('runBtn').disabled=false;var browserBtn=document.getElementById('browserBtn');if(browserBtn)browserBtn.style.display='none';var _sc=document.getElementById('settingsContent');if(_sc){_sc.classList.remove('collapsed');var _sp=document.getElementById('settingsPanel');if(_sp)_sp.classList.remove('collapsed');var _sb=document.getElementById('settingsToggle');if(_sb)_sb.innerHTML='&#9650; Collapse';}}
  else if(d.command==='triggerRerun'){runSimulation();}
  else if(d.command==='varsLoaded'){_applyVarsLoaded(d.data);}
  else if(d.command==='toolPathBrowseResult'){if(_toolPathBrowseRow&&d.path){var _tp=_toolPathBrowseRow.querySelector('.tool-path');if(_tp)_tp.value=d.path;}_toolPathBrowseRow=null;}
});
<\/script>
</body></html>`;
    /* eslint-enable prettier/prettier */
}

module.exports = { _generateSimulationViewHtml };
