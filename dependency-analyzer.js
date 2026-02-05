const YAML = require('yaml');

class DependencyAnalyzer {
    constructor(parser) {
        this._parser = parser;
    }

    analyzeDependencies(sourceFilePath, sourceText, overrides = {}) {
        return this.analyzePipeline(sourceText, overrides);
    }

    analyzePipeline(sourceText, overrides = {}) {
        try {
            const { yamlDoc, jsonDoc } = this._parser.parseYamlDocument(sourceText, undefined, false);

            const dependencies = {
                stages: [],
                jobs: [],
                templates: [],
                resources: [],
                dependencyGraph: [],
            };

            this._extractStages(jsonDoc, dependencies);
            this._extractJobs(jsonDoc, dependencies);
            this._extractTemplates(jsonDoc, dependencies);
            this._extractResources(jsonDoc, dependencies);

            return dependencies;
        } catch (error) {
            console.error('Failed to analyze pipeline dependencies:', error);
            return {
                error: error.message,
                stages: [],
                jobs: [],
                templates: [],
                resources: [],
                dependencyGraph: [],
            };
        }
    }

    _extractStages(doc, dependencies) {
        if (!doc.stages || !Array.isArray(doc.stages)) {
            return;
        }

        doc.stages.forEach((stage, index) => {
            const stageInfo = {
                name: stage.stage || `Stage_${index}`,
                displayName: stage.displayName || stage.stage || `Stage ${index + 1}`,
                dependsOn: [],
            };

            if (stage.dependsOn) {
                stageInfo.dependsOn = Array.isArray(stage.dependsOn) ? stage.dependsOn : [stage.dependsOn];
            }

            if (stage.jobs && Array.isArray(stage.jobs)) {
                stageInfo.jobs = stage.jobs.map((job, jobIndex) => {
                    return job.job || job.deployment || job.template || `Job_${jobIndex}`;
                });
            }

            dependencies.stages.push(stageInfo);

            if (stageInfo.dependsOn.length > 0) {
                stageInfo.dependsOn.forEach((dep) => {
                    dependencies.dependencyGraph.push({
                        type: 'stage',
                        from: stageInfo.name,
                        to: dep,
                    });
                });
            }
        });
    }

    _extractJobs(doc, dependencies) {
        let jobsList = [];

        if (doc.jobs && Array.isArray(doc.jobs)) {
            jobsList = doc.jobs;
        } else if (doc.stages && Array.isArray(doc.stages)) {
            doc.stages.forEach((stage) => {
                if (stage.jobs && Array.isArray(stage.jobs)) {
                    jobsList.push(...stage.jobs.map((j) => ({ ...j, _stage: stage.stage })));
                }
            });
        }

        jobsList.forEach((job, index) => {
            const jobInfo = {
                name: job.job || job.deployment || `Job_${index}`,
                displayName: job.displayName || job.job || job.deployment || `Job ${index + 1}`,
                dependsOn: [],
                stage: job._stage,
            };

            if (job.dependsOn) {
                jobInfo.dependsOn = Array.isArray(job.dependsOn) ? job.dependsOn : [job.dependsOn];
            }

            if (job.steps && Array.isArray(job.steps)) {
                jobInfo.stepCount = job.steps.length;
            }

            dependencies.jobs.push(jobInfo);

            if (jobInfo.dependsOn.length > 0) {
                jobInfo.dependsOn.forEach((dep) => {
                    dependencies.dependencyGraph.push({
                        type: 'job',
                        from: jobInfo.name,
                        to: dep,
                        stage: jobInfo.stage,
                    });
                });
            }
        });
    }

    _extractTemplates(doc, dependencies) {
        this._findTemplateReferences(doc, dependencies, []);
    }

    _findTemplateReferences(node, dependencies, path) {
        if (typeof node !== 'object' || node === null) {
            return;
        }

        if (node.template && typeof node.template === 'string') {
            const templateInfo = {
                path: node.template,
                parameters: node.parameters || {},
                usedIn: path.length > 0 ? path.join(' > ') : 'root',
            };
            dependencies.templates.push(templateInfo);
        }

        if (Array.isArray(node)) {
            node.forEach((item, index) => {
                this._findTemplateReferences(item, dependencies, [...path, `[${index}]`]);
            });
        } else {
            Object.keys(node).forEach((key) => {
                if (key !== 'template' && typeof node[key] === 'object') {
                    this._findTemplateReferences(node[key], dependencies, [...path, key]);
                }
            });
        }
    }

    _extractResources(doc, dependencies) {
        if (!doc.resources) {
            return;
        }

        if (doc.resources.repositories && Array.isArray(doc.resources.repositories)) {
            doc.resources.repositories.forEach((repo) => {
                dependencies.resources.push({
                    type: 'repository',
                    name: repo.repository || 'unknown',
                    repoType: repo.type || 'unknown',
                    endpoint: repo.endpoint,
                });
            });
        }

        if (doc.resources.pipelines && Array.isArray(doc.resources.pipelines)) {
            doc.resources.pipelines.forEach((pipeline) => {
                dependencies.resources.push({
                    type: 'pipeline',
                    name: pipeline.pipeline || 'unknown',
                    source: pipeline.source,
                });
            });
        }

        if (doc.resources.containers && Array.isArray(doc.resources.containers)) {
            doc.resources.containers.forEach((container) => {
                dependencies.resources.push({
                    type: 'container',
                    name: container.container || 'unknown',
                    image: container.image,
                });
            });
        }
    }

    generateMermaidDiagram(dependencies) {
        const lines = ['graph LR'];

        const criticalPath = this._calculateCriticalPath(dependencies);
        const criticalPathSet = new Set(criticalPath);

        // Create a map of consecutive pairs in critical path for edge checking
        const criticalEdgeMap = new Map();
        for (let i = 0; i < criticalPath.length - 1; i++) {
            const key = `${criticalPath[i]}->${criticalPath[i + 1]}`;
            criticalEdgeMap.set(key, true);
        }

        const stageEmojis = {
            configure: '⚙️',
            lint: '✨',
            build: '🔨',
            test: '🧪',
            security: '🔒',
            signing: '🔐',
            package: '📦',
            release: '🚀',
            scan: '📋',
            artifact: '📦',
            unit: '🧪',
            system: '🧪',
        };

        const getStageType = (name) => {
            const lower = name.toLowerCase();
            if (lower.includes('configure')) return 'configure';
            if (lower.includes('lint')) return 'lint';
            if (lower.includes('build')) return 'build';
            if (lower.includes('test') || lower.includes('unit')) return 'test';
            if (lower.includes('artifact') || lower.includes('scan')) return 'artifactScan';
            if (lower.includes('sign')) return 'signing';
            if (lower.includes('package') || lower.includes('publish')) return 'package';
            if (lower.includes('release')) return 'release';
            return 'build';
        };

        const getEmoji = (name) => {
            const type = getStageType(name);
            return stageEmojis[type] || '🔧';
        };

        const criticalEdges = [];
        let edgeIndex = 0;

        if (dependencies.stages.length > 0) {
            dependencies.stages.forEach((stage) => {
                const nodeId = `stage_${this._sanitizeId(stage.name)}`;
                const emoji = getEmoji(stage.displayName);
                const isOnCriticalPath = criticalPathSet.has(stage.name);
                const styleClass = isOnCriticalPath ? 'stageCritical' : getStageType(stage.displayName);
                const displayText = stage.displayName || stage.name;

                lines.push(`    ${nodeId}["${emoji} ${displayText}"]:::${styleClass}`);
            });

            dependencies.dependencyGraph
                .filter((dep) => dep.type === 'stage')
                .forEach((dep) => {
                    const fromId = `stage_${this._sanitizeId(dep.from)}`;
                    const toId = `stage_${this._sanitizeId(dep.to)}`;
                    // Check if this edge is consecutive in the critical path
                    const edgeKey = `${dep.from}->${dep.to}`;
                    const isOnCriticalPath = criticalEdgeMap.has(edgeKey);
                    const edgeStyle = isOnCriticalPath ? '==>' : '-->';
                    lines.push(`    ${toId} ${edgeStyle} ${fromId}`);

                    if (isOnCriticalPath) {
                        criticalEdges.push(edgeIndex);
                    }
                    edgeIndex++;
                });
        }

        if (dependencies.jobs.length > 0 && dependencies.stages.length === 0) {
            dependencies.jobs.forEach((job) => {
                const nodeId = `job_${this._sanitizeId(job.name)}`;
                const emoji = getEmoji(job.displayName);
                const isOnCriticalPath = criticalPathSet.has(job.name);
                const styleClass = isOnCriticalPath ? 'jobCritical' : getStageType(job.displayName);
                const displayText = job.displayName || job.name;
                lines.push(`    ${nodeId}["${emoji} ${displayText}"]:::${styleClass}`);
            });

            dependencies.dependencyGraph
                .filter((dep) => dep.type === 'job')
                .forEach((dep) => {
                    const fromId = `job_${this._sanitizeId(dep.from)}`;
                    const toId = `job_${this._sanitizeId(dep.to)}`;
                    // Check if this edge is consecutive in the critical path
                    const edgeKey = `${dep.from}->${dep.to}`;
                    const isOnCriticalPath = criticalEdgeMap.has(edgeKey);
                    const edgeStyle = isOnCriticalPath ? '==>' : '-->';
                    lines.push(`    ${toId} ${edgeStyle} ${fromId}`);

                    if (isOnCriticalPath) {
                        criticalEdges.push(edgeIndex);
                    }
                    edgeIndex++;
                });
        }

        // Define styles for different stage types - matching pipeline-dependencies.html
        lines.push('    classDef configure fill:#e0f2fe,stroke:#0369a1,stroke-width:3px,color:#0c4a6e');
        lines.push('    classDef lint fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#1e3a8a');
        lines.push('    classDef build fill:#bfdbfe,stroke:#1d4ed8,stroke-width:3px,color:#1e3a8a');
        lines.push('    classDef test fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#1e3a8a');
        lines.push('    classDef artifactScan fill:#bbf7d0,stroke:#16a34a,stroke-width:3px,color:#14532d');
        lines.push('    classDef signing fill:#fed7aa,stroke:#ea580c,stroke-width:3px,color:#7c2d12');
        lines.push('    classDef package fill:#e0f2fe,stroke:#0369a1,stroke-width:3px,color:#0c4a6e');
        lines.push('    classDef release fill:#bbf7d0,stroke:#16a34a,stroke-width:3px,color:#14532d');

        // Critical path styling - bright red/orange as specified
        lines.push('    classDef stageCritical fill:#fecaca,stroke:#D13438,stroke-width:5px,color:#7f1d1d');
        lines.push('    classDef jobCritical fill:#fecaca,stroke:#D13438,stroke-width:5px,color:#7f1d1d');

        // Apply red color to critical path arrows
        criticalEdges.forEach((index) => {
            lines.push(`    linkStyle ${index} stroke:#D13438,stroke-width:3px`);
        });

        return lines.join('\n');
    }

    _calculateCriticalPath(dependencies) {
        const items = dependencies.stages.length > 0 ? dependencies.stages : dependencies.jobs;
        const graph = dependencies.dependencyGraph.filter(
            (dep) => dep.type === (dependencies.stages.length > 0 ? 'stage' : 'job')
        );

        if (items.length === 0) {
            return [];
        }

        // Build forward dependency map (who depends on whom)
        const forwardGraph = new Map();
        const reverseGraph = new Map();

        items.forEach((item) => {
            forwardGraph.set(item.name, []);
            reverseGraph.set(item.name, []);
        });

        graph.forEach((dep) => {
            // dep.to depends on dep.from
            if (!forwardGraph.has(dep.from)) {
                forwardGraph.set(dep.from, []);
            }
            if (!reverseGraph.has(dep.to)) {
                reverseGraph.set(dep.to, []);
            }
            forwardGraph.get(dep.from).push(dep.to);
            reverseGraph.get(dep.to).push(dep.from);
        });

        // Find the longest path using dynamic programming
        const longestPathLength = new Map();
        const longestPathPrev = new Map();

        items.forEach((item) => {
            longestPathLength.set(item.name, 0);
            longestPathPrev.set(item.name, null);
        });

        // Topological sort with DFS
        const visited = new Set();
        const topologicalOrder = [];

        const dfs = (node) => {
            if (visited.has(node)) return;
            visited.add(node);

            const dependencies = reverseGraph.get(node) || [];
            dependencies.forEach((dep) => dfs(dep));

            topologicalOrder.push(node);
        };

        items.forEach((item) => dfs(item.name));

        // Calculate longest path
        topologicalOrder.forEach((node) => {
            const deps = reverseGraph.get(node) || [];
            if (deps.length === 0) {
                longestPathLength.set(node, 1);
            } else {
                let maxLen = 0;
                let maxPrev = null;

                deps.forEach((dep) => {
                    const len = longestPathLength.get(dep) || 0;
                    if (len > maxLen) {
                        maxLen = len;
                        maxPrev = dep;
                    }
                });

                longestPathLength.set(node, maxLen + 1);
                longestPathPrev.set(node, maxPrev);
            }
        });

        // Find the node with longest path (the end of critical path)
        // If there are ties, pick the one that comes first alphabetically for consistency
        let maxLength = 0;
        let endNode = null;

        longestPathLength.forEach((length, node) => {
            if (length > maxLength || (length === maxLength && (!endNode || node < endNode))) {
                maxLength = length;
                endNode = node;
            }
        });

        // Trace back the critical path - only ONE path
        const criticalPath = [];
        let current = endNode;

        while (current !== null) {
            criticalPath.unshift(current);
            current = longestPathPrev.get(current);
        }

        return criticalPath;
    }

    generateTextReport(dependencies) {
        const lines = ['# Pipeline Dependencies\n'];

        if (dependencies.error) {
            lines.push(`⚠️ Error: ${dependencies.error}\n`);
            return lines.join('\n');
        }

        const criticalPath = this._calculateCriticalPath(dependencies);

        if (criticalPath.length > 0) {
            lines.push('## 🔴 Critical Path\n');
            lines.push(`${criticalPath.join(' → ')}`);
            lines.push(
                `\n*Path Length: ${criticalPath.length} ${dependencies.stages.length > 0 ? 'stages' : 'jobs'}*\n`
            );
        }

        if (dependencies.stages.length > 0) {
            lines.push('## Stages\n');
            dependencies.stages.forEach((stage) => {
                const isCritical = criticalPath.includes(stage.name);
                const marker = isCritical ? '🔴 ' : '';
                lines.push(`${marker}**${stage.displayName}**`);
                if (stage.dependsOn && stage.dependsOn.length > 0) {
                    lines.push(`  ↳ ${stage.dependsOn.join(', ')}`);
                }
                if (stage.jobs && stage.jobs.length > 0) {
                    lines.push(`  ├─ ${stage.jobs.length} job${stage.jobs.length !== 1 ? 's' : ''}`);
                }
            });
            lines.push('');
        }

        if (dependencies.jobs.length > 0 && dependencies.stages.length === 0) {
            lines.push('## Jobs\n');
            dependencies.jobs.forEach((job) => {
                const isCritical = criticalPath.includes(job.name);
                const marker = isCritical ? '🔴 ' : '';
                lines.push(`${marker}**${job.displayName}**`);
                if (job.dependsOn && job.dependsOn.length > 0) {
                    lines.push(`  ↳ ${job.dependsOn.join(', ')}`);
                }
                if (job.stepCount) {
                    lines.push(`  ├─ ${job.stepCount} step${job.stepCount !== 1 ? 's' : ''}`);
                }
            });
            lines.push('');
        }

        if (dependencies.templates.length > 0) {
            lines.push('## Templates\n');
            const uniqueTemplates = new Map();
            dependencies.templates.forEach((tmpl) => {
                if (!uniqueTemplates.has(tmpl.path)) {
                    uniqueTemplates.set(tmpl.path, []);
                }
                uniqueTemplates.get(tmpl.path).push(tmpl.usedIn);
            });

            uniqueTemplates.forEach((usages, templatePath) => {
                lines.push(`\`${templatePath}\``);
            });
            lines.push('');
        }

        if (dependencies.resources.length > 0) {
            lines.push('## Resources\n');
            dependencies.resources.forEach((resource) => {
                if (resource.type === 'repository') {
                    lines.push(`📦 ${resource.name}`);
                } else if (resource.type === 'pipeline') {
                    lines.push(`⚙️ ${resource.name}`);
                } else if (resource.type === 'container') {
                    lines.push(`🐳 ${resource.name}`);
                }
            });
            lines.push('');
        }

        if (
            dependencies.dependencyGraph.length === 0 &&
            dependencies.stages.length === 0 &&
            dependencies.jobs.length === 0
        ) {
            lines.push('*No dependencies found*\n');
        }

        return lines.join('\n');
    }

    _sanitizeId(str) {
        return str.replace(/[^a-zA-Z0-9_]/g, '_');
    }
}

module.exports = { DependencyAnalyzer };
