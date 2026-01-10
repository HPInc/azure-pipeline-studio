const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const jsep = require('jsep');
const adoFunctions = require('./ado-functions');

const CHECKOUT_TASK = '6d15af64-176c-496d-b583-fd2ae21d4df4@1';
// Mapping of shorthand keys to Azure task identifiers
const TASK_TYPE_MAP = Object.freeze({
    script: 'CmdLine@2',
    bash: 'Bash@3',
    pwsh: 'PowerShell@2',
    powershell: 'PowerShell@2',
    checkout: CHECKOUT_TASK,
});

class AzurePipelineParser {
    constructor(options = {}) {
        this.expressionCache = new Map();
        this.globQuotePattern = /\*\*|[*/]\/|\/[*/]/;
    }

    expandPipelineFromFile(filePath, overrides = {}) {
        const input = fs.readFileSync(filePath, 'utf8');
        const baseDir = path.dirname(filePath);
        const enhancedOverrides = {
            ...overrides,
            fileName: filePath,
            baseDir,
            templateStack: [filePath],
        };
        return this.expandPipelineFromString(input, enhancedOverrides);
    }

    expandPipelineFromString(sourceText, overrides = {}) {
        const { yaml } = this.expandPipeline(sourceText, overrides);
        return yaml;
    }

    expandPipeline(sourceText, overrides = {}) {
        let yamlDoc = null;
        let document = {};

        try {
            yamlDoc = YAML.parseDocument(sourceText);
            document = yamlDoc.toJSON() || {};
        } catch (error) {
            throw new Error(`Failed to parse YAML: ${error.message}`);
        }
        const context = this.buildExecutionContext(document, overrides);
        context.quoteResult = this.captureQuoteStyles(yamlDoc.contents, []);
        context.azureCompatible = overrides.azureCompatible || false;
        context.templateQuoteStyles = new Map();

        const expandedDocument = this.expandNode(document, context);

        // Convert variables from object format to array format while preserving quotes
        this.convertVariablesToArrayFormat(expandedDocument, context);

        const finalYamlDoc = YAML.parseDocument(YAML.stringify(expandedDocument));
        this.restoreQuoteStyles(finalYamlDoc.contents, [], context);

        console.log(`Azure Compatibility mode: ${context.azureCompatible}`);
        this.applyBlockScalarStyles(finalYamlDoc.contents, context);

        let output = finalYamlDoc.toString({
            lineWidth: 0,
            indent: 2,
            defaultStringType: 'PLAIN',
            defaultKeyType: 'PLAIN',
            simpleKeys: false,
            aliasDuplicateObjects: false,
        });

        // Remove quotes from plain numbers in YAML value positions
        // Preserves JSON syntax by detecting quoted keys (e.g., "name": 42)
        output = output.replace(/^(\s*(?:-\s+)?[^":\n]+:\s*)["'](\d+(?:\.\d+)?)["']/gm, (match, prefix, num) => {
            // Skip if prefix contains quotes (JSON key syntax)
            if (prefix.includes('"')) {
                return match;
            }
            // Unquote the number
            return prefix + num;
        });

        // Convert boolean markers to unquoted capitalized booleans (Azure format)
        output = output.replace(/(['\"]?)__(TRUE|FALSE)__\1/g, (match, quote, token) => {
            const value = token === 'TRUE' ? 'True' : 'False';
            return quote ? `${quote}${value}${quote}` : value;
        });

        // Handle trailing newlines and blank line removal based on mode
        if (context.azureCompatible) {
            // Remove extra blank lines between sections
            output = output.replace(/^(\S.+)\n\n(\s*-\s)/gm, '$1\n$2');
            output = output.replace(/^(\S.+)\n\n(\s*\w+:)/gm, '$1\n$2');

            if (!output.endsWith('\n\n\n')) {
                output = output.replace(/\n*$/, '\n\n\n');
            }
        } else {
            output = output.replace(/\n*$/, '\n');
        }
        // Return both the expanded JS document and the final YAML string
        return { document: expandedDocument, yaml: output, context };
    }

    /**
     * Convert variables from object format to array format while preserving quote styles.
     * Azure Pipelines accepts both formats, but array format is canonical.
     * @param {object} doc - The expanded document to modify
     * @param {object} context - Expansion context containing quote styles
     */
    convertVariablesToArrayFormat(doc, context) {
        // Check if variables need conversion (object format → array format)
        if (!doc.variables || typeof doc.variables !== 'object' || Array.isArray(doc.variables)) {
            return;
        }

        const variableQuoteStyles = new Map();
        const quoteStyles = this._getQuoteStylesMap(context);

        // Capture quote styles for each variable value before conversion
        Object.entries(doc.variables).forEach(([name, value]) => {
            if (typeof value === 'string') {
                const originalKey = this.getQuoteStyleUniqueKey(['variables', name], value);
                const quoteStyle = quoteStyles.get(originalKey);
                if (quoteStyle) {
                    variableQuoteStyles.set(name, { value, quoteStyle });
                }
            }
        });

        // Convert to array format
        doc.variables = Object.entries(doc.variables).map(([name, value]) => ({
            name: name,
            value: value,
        }));

        if (variableQuoteStyles.size === 0) {
            return;
        }

        // Update quote styles with new array-based paths
        doc.variables.forEach((varObj, index) => {
            const preserved = variableQuoteStyles.get(varObj.name);
            if (preserved && preserved.value === varObj.value) {
                // New path: variables.index.value
                const newKey = this.getQuoteStyleUniqueKey(['variables', index, 'value'], varObj.value);
                quoteStyles.set(newKey, preserved.quoteStyle);
            }
        });
    }

    /**
     * Extract quote styles from YAML AST.
     * Uses path-based matching for exact preservation, with context-aware hash fallback.
     * Context is determined by displayName/task/name in the ancestor chain.
     * @param {object} node - YAML AST node
     * @param {array} path - Current path in the document
     * @param {Map} quoteStyles - Map to store quote styles
     */
    extractQuoteStyles(node, path, quoteStyles) {
        const handler = this.buildQuoteHandler(this.setQuoteStyle.bind(this), {});
        this.traverseQuoteStyleNodes(node, path, handler, quoteStyles);
    }

    /**
     * Capture quote styles from a YAML AST root and return an object containing
     * the collected Map and a `save` function that will attach merged styles
     * to an expanded document. This consolidates extraction and later saving
     * into a single logical operation.
     * @param {object} node - YAML AST node (root)
     * @param {array} path - starting path (usually [])
     * @returns {{quoteStyles: Map, save: function}}
     */
    captureQuoteStyles(node, path) {
        const quoteStyles = new Map();
        try {
            this.extractQuoteStyles(node, path, quoteStyles);
        } catch (err) {
            // Extraction failure should not break expansion; return empty map
        }

        const save = (expandedDocument, context) => {
            const allQuoteStyles = new Map(quoteStyles);
            if (context && context.templateQuoteStyles) {
                for (const [, templateStyles] of context.templateQuoteStyles.entries()) {
                    for (const [key, style] of templateStyles.entries()) {
                        if (!allQuoteStyles.has(key)) {
                            allQuoteStyles.set(key, style);
                        }
                    }
                }
            }
            // Keep attaching for compatibility, but also return the merged map
            expandedDocument.__quoteStyles = allQuoteStyles;
            return allQuoteStyles;
        };

        return { quoteStyles, save };
    }

    /**
     * Restore quote styles using path match, then context-aware hash.
     * @param {object} node - YAML AST node
     * @param {array} path - Current path in the document
     * @param {Map} quoteStyles - Map of stored quote styles
     * @param {string} identifier - Identifier from ancestor
     */
    restoreQuoteStyles(node, path, context = {}) {
        const quoteStyles = this._getQuoteStylesMap(context);
        const stringsWithExpressions = context.stringsWithExpressions || new Set();

        // Delegate to the generic traversal with a handler that applies stored styles
        const handler = this.buildQuoteHandler(this.getQuoteStyle.bind(this), {
            post: (quoteStyle, valueNode) => {
                if (valueNode?.value !== undefined && typeof valueNode.value === 'string') {
                    // Skip restoring quotes for strings that had MIXED template expressions
                    // Check using path-based unique key (stored during expansion)
                    const uniqueKey = this.getQuoteStyleUniqueKey(path, valueNode.value);
                    if (stringsWithExpressions.has(uniqueKey)) {
                        valueNode.type = 'PLAIN';
                    } else if (quoteStyle) {
                        // If value contains colon, normalize to single quotes (Azure behavior)
                        if (valueNode.value.includes(':')) {
                            valueNode.type = 'QUOTE_SINGLE';
                        } else {
                            valueNode.type = quoteStyle;
                        }
                    }
                }
            },
        });
        this.traverseQuoteStyleNodes(node, path, handler, quoteStyles);
    }

    /**
     * Generate a unique key for storing/retrieving quote styles.
     * Normalizes path by removing conditional directive segments (e.g., ${{ if ... }})
     * to ensure paths match after conditional expansion.
     * Format: "normalized.path.segments:keyName:valueContent"
     * @param {array} path - path array (may include numeric indices for arrays)
     * @param {string} value - string value content
     * @returns {string} - unique key for quote style lookup
     */
    getQuoteStyleUniqueKey(path, value) {
        // Filter out conditional directive segments
        const normalizedPath = path.filter((segment) => {
            // Remove conditional directives: ${{ if ... }}, ${{ else }}, ${{ elseif ... }}
            if (typeof segment === 'string' && segment.includes('${{')) {
                return false;
            }
            return true;
        });

        return `${normalizedPath.join('.')}:${value}`;
    }

    /**
     * Helper to capture quote style metadata for a single string value node.
     * Stores quote styles using normalized path with key:value pattern.
     * @param {array} path - current path array (mutated externally)
     * @param {object} keyNode - YAML key node
     * @param {object} valueNode - YAML value node (string)
     * @param {Map} quoteStyles - map to record styles into
     */
    setQuoteStyle(path, keyNode, valueNode, quoteStyles) {
        const quoteType = valueNode.type;
        if (quoteType !== 'QUOTE_SINGLE' && quoteType !== 'QUOTE_DOUBLE') return;
        if (typeof valueNode.value !== 'string') return;

        const uniqueKey = this.getQuoteStyleUniqueKey(path, valueNode.value);

        // Store by normalized path with key:value
        quoteStyles.set(uniqueKey, quoteType);
    }

    /**
     * Lookup a quote style for a value using normalized path with key:value pattern.
     * @param {array} path - path array (will be joined)
     * @param {object} keyNode - YAML key node
     * @param {object} valueNode - YAML value node (may be undefined)
     * @param {Map} quoteStyles - map of captured styles
     * @returns {string|undefined} - quote style token or undefined
     */
    getQuoteStyle(path, keyNode, valueNode, quoteStyles) {
        if (!quoteStyles) return undefined;

        const keyName = keyNode && keyNode.value ? keyNode.value : undefined;
        const valContent = valueNode && typeof valueNode.value === 'string' ? valueNode.value : undefined;

        // Lookup using the same unique key generation as setQuoteStyle
        if (keyName !== undefined && valContent !== undefined) {
            const uniqueKey = this.getQuoteStyleUniqueKey(path, valContent);
            return quoteStyles.get(uniqueKey);
        }

        return undefined;
    }

    /**
     * Generic YAMLMap/YAMLSeq traversal used by both extract and restore flows.
     * The handler is invoked for each pair in a YAMLMap with signature
     * (pair, pathArray, currentIdentifier, quoteStyles).
     * @param {object} node - YAML AST node
     * @param {array} path - current path array (mutated by traversal)
     * @param {function} handler - function(pair, pathArray, currentIdentifier, quoteStyles)
     * @param {Map} quoteStyles - map passed through to handlers
     */
    traverseQuoteStyleNodes(node, path, handler, quoteStyles = new Map()) {
        if (!node) return;

        if (node.items && node.constructor.name === 'YAMLMap') {
            const currentID = this.getContextIdentifier(node, '');
            for (const pair of node.items) {
                const keyNode = pair.key;
                if (!keyNode || !keyNode.value) continue;

                path.push(keyNode.value);
                //console.log(`Visiting path: ${path.join('.')}`);
                try {
                    handler(pair, path, currentID, quoteStyles);
                } catch (err) {
                    // Handler should not break traversal; swallow errors
                }

                if (pair.value) {
                    this.traverseQuoteStyleNodes(pair.value, path, handler, quoteStyles);
                }
                path.pop();
            }
        } else if (node.items && node.constructor.name === 'YAMLSeq') {
            for (let index = 0; index < node.items.length; index += 1) {
                path.push(index);
                this.traverseQuoteStyleNodes(node.items[index], path, handler, quoteStyles);
                path.pop();
            }
        }
    }

    /**
     * Build a generic handler for YAML mapping pairs that invokes an injected
     * helper (e.g. `setQuoteStyle` or `getQuoteStyle`).
     * @param {string} handlerKey - name of helper on `helpers` object
     * @param {function} fallback - fallback function bound to `this`
     * @param {object} options - { post: function }
     * @returns {function} handler(pair, pathArr, currentID, quoteStyles, helpers)
     */
    buildQuoteHandler(func, options = {}) {
        const { post: postFunc = null } = options;
        return (pair, pathArr, currentID, qStyles) => {
            const keyNode = pair.key;
            const valueNode = pair.value;
            if (!keyNode || !keyNode.value || !valueNode || typeof valueNode.value !== 'string') {
                return;
            }

            const quoteStyle = func(pathArr, keyNode, valueNode, qStyles);
            if (typeof postFunc === 'function') {
                try {
                    postFunc(quoteStyle, valueNode);
                } catch (err) {
                    // swallow post errors
                }
            }
        };
    }

    /**
     * Extract a context identifier from a YAMLMap node.
     * Priority: `name` > `displayName` > `task` > fallback value
     * @param {object} node - YAMLMap node
     * @param {string} fallback - Fallback context value
     * @returns {string} context identifier
     */
    getContextIdentifier(node, fallback = '') {
        if (!node || !node.items || node.constructor.name !== 'YAMLMap') {
            return fallback;
        }

        let name = '';
        let displayName = '';
        let task = '';
        for (const pair of node.items) {
            if (pair.key && pair.value && typeof pair.value.value === 'string') {
                const keyName = pair.key.value;
                if (keyName === 'name') {
                    name = pair.value.value;
                    break;
                }
                if (keyName === 'displayName') displayName = pair.value.value;
                if (keyName === 'task') task = pair.value.value;
            }
        }

        return name || displayName || task || fallback;
    }

    /**
     * Apply Azure-compatible block scalar styles to script values.
     * Uses heuristics to choose between > (folded) and | (literal).
     * Our heuristic priority:
     * - Keep > (folded) if source already uses it
     * - Use > (folded) if content originally had ${{}} expressions (tracked during expansion)
     * - Use | (literal) otherwise for scripts - preserves newlines
     * @param {object} node - YAML AST node
     * @param {object} context - Expansion context
     */
    applyBlockScalarStyles(node, context = {}) {
        if (!node) return;
        if (node.items && node.constructor.name === 'YAMLMap') {
            for (const pair of node.items) {
                if (!pair.key?.value || !pair.value) continue;

                const { value } = pair;

                // Recurse for non-multiline or non-string values
                if (!this.isMultilineString(value.value)) {
                    this.applyBlockScalarStyles(value, context);
                    continue;
                }

                let content = value.value;

                // If Azure mode and trailing spaces exist, or value is already explicitly double-quoted,
                // preserve the double-quoted type and recurse for normalization without changing further logic.
                if ((context.azureCompatible && this.hasTrailingSpaces(content)) || value.type === 'QUOTE_DOUBLE') {
                    if (context.azureCompatible && this.hasTrailingSpaces(content)) {
                        value.type = 'QUOTE_DOUBLE';
                    }
                    this.applyBlockScalarStyles(value, context);
                    continue;
                }

                const trimmedKey = content.replace(/\s+$/, '');
                const hadExpression = context.scriptsWithExpressions?.has(trimmedKey);
                if (context.azureCompatible) {
                    value.type = hadExpression ? 'BLOCK_FOLDED' : 'BLOCK_LITERAL';
                }
                value.value = this.normalizeTrailingNewlines(content, context.azureCompatible);
                this.applyBlockScalarStyles(value, context);
            }
        } else if (node.items && node.constructor.name === 'YAMLSeq') {
            for (const item of node.items) this.applyBlockScalarStyles(item, context);
        }
    }

    hasTrailingSpaces(content) {
        const lines = content.split('\n');
        return lines.some((line, idx) => (idx < lines.length - 1 || line !== '' ? /[ \t]$/.test(line) : false));
    }

    /**
     * Return true when the provided value is a string containing at least one newline.
     * Safely returns false for non-strings.
     * @param {any} value
     * @returns {boolean}
     */
    isMultilineString(value) {
        return typeof value === 'string' && value.includes('\n');
    }

    /**
     * Return true when the provided value is a string containing a template expression
     * in the form ${{ ... }}. Safely returns false for non-strings.
     * @param {any} value
     * @returns {boolean}
     */
    hasTemplateExpr(value) {
        return typeof value === 'string' && value.includes('${{');
    }

    normalizeTrailingNewlines(content, azureCompatible) {
        if (azureCompatible) {
            return /\n[ \t]*\n\s*$/.test(content) ? content.replace(/\n+$/, '') + '\n\n' : content;
        }
        return /\n\n+$/.test(content) ? content.replace(/\n+$/, '') + '\n' : content;
    }

    /**
     * Check if the last non-empty line is an Azure compile-time variable expression
     * Used to determine if "keep" (+) chomping should be applied BEFORE expansion
     * The line must end with }} to be considered a template expression line
     * @param {string} content - The block scalar content (before expansion)
     * @returns {boolean} - True if last non-empty line ends with }}
     */
    lastLineHasTemplateExpression(content) {
        if (!content || !this.isMultilineString(content)) {
            return false;
        }

        // Split into lines and find last non-empty line
        const lines = content.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line) {
                // Check if this line ends with }} (is a compile-time variable expression)
                // This matches lines like: ${{ parameters.properties }}
                return line.endsWith('}}');
            }
        }
        return false;
    }

    buildExecutionContext(document, overrides) {
        const { parameters, parameterMap } = this.extractParameters(document);
        const variables = this.extractVariables(document);
        const resources = this.normalizeResourcesConfig(
            document && typeof document === 'object' ? document.resources : undefined
        );

        const overrideParameters = overrides.parameters || {};
        const overrideVariables = overrides.variables || {};
        const overrideResources = this.normalizeResourcesConfig(overrides.resources);
        const locals = overrides.locals || {};
        const baseDir = overrides.baseDir || (overrides.fileName ? path.dirname(overrides.fileName) : process.cwd());
        const repositoryBaseDir = overrides.repositoryBaseDir !== undefined ? overrides.repositoryBaseDir : baseDir;

        const mergedResources = this.mergeResourcesConfig(resources, overrideResources);
        const resourceLocations = overrides.resourceLocations || {};

        return {
            parameters: { ...parameters, ...overrideParameters },
            parameterMap: { ...parameterMap },
            variables: { ...variables, ...overrideVariables },
            resources: mergedResources,
            locals: { ...locals },
            baseDir,
            repositoryBaseDir,
            resourceLocations,
            templateStack: overrides.templateStack || [],
            expansionPath: [], // Track current path during expansion for path-based tracking
            scriptsWithExpressions: new Set(), // Track scripts that had ${{}} before expansion
            scriptsWithLastLineExpressions: new Set(), // Track scripts that had ${{}} on last line before expansion
            stringsWithExpressions: new Set(), // Track path-based keys for strings that had ${{}} expressions
        };
    }

    normalizeResourcesConfig(resourcesNode) {
        if (!resourcesNode || typeof resourcesNode !== 'object') {
            return {};
        }

        const normalized = Object.keys(resourcesNode).reduce((acc, key) => {
            if (key === 'repositories') return acc;
            acc[key] = this.deepClone(resourcesNode[key]);
            return acc;
        }, {});

        if (resourcesNode.repositories !== undefined) {
            normalized.repositories = this.normalizeRepositoryList(resourcesNode.repositories);
        }

        return normalized;
    }

    mergeResourcesConfig(baseResources = {}, overrideResources = {}) {
        const merged = {};
        // Clone base resource keys except repositories
        Object.entries(baseResources || {}).forEach(([k, v]) => {
            if (k === 'repositories') return;
            merged[k] = this.deepClone(v);
        });

        // Merge repositories specially
        merged.repositories = this.mergeRepositoryConfigs(baseResources?.repositories, overrideResources?.repositories);

        // Override with overrideResources keys (except repositories)
        Object.entries(overrideResources || {}).forEach(([k, v]) => {
            if (k === 'repositories') return;
            merged[k] = this.deepClone(v);
        });

        return merged;
    }

    normalizeRepositoryList(value) {
        if (!value) {
            return [];
        }

        const list = [];
        if (Array.isArray(value)) {
            for (const entry of value) {
                if (entry && typeof entry === 'object') list.push(this.deepClone(entry));
            }
        } else if (typeof value === 'object') {
            for (const [key, entry] of Object.entries(value)) {
                if (!entry || typeof entry !== 'object') continue;
                const cloned = this.deepClone(entry);
                if (!cloned.repository && key) cloned.repository = key;
                list.push(cloned);
            }
        }

        return this.attachRepositoryAliases(list);
    }

    mergeRepositoryConfigs(baseValue, overrideValue) {
        const baseList = this.normalizeRepositoryList(baseValue);
        const overrideList = this.normalizeRepositoryList(overrideValue);

        if (!overrideList.length) {
            return baseList;
        }

        const mergedOrder = [];
        const mergedMap = new Map();

        const addEntry = (entry, source) => {
            if (!entry || typeof entry !== 'object') return;

            const clone = this.deepClone(entry);
            const matchCriteria = clone.__match && typeof clone.__match === 'object' ? clone.__match : undefined;
            if (matchCriteria) delete clone.__match;

            const alias = this.getRepositoryAlias(clone);
            const key = alias && !this.isNumericString(alias) ? alias : `__index_${mergedOrder.length}`;
            if (!clone.repository && alias && !this.isNumericString(alias)) clone.repository = alias;

            const existing = mergedMap.get(key);
            if (source === 'override' && existing && matchCriteria) {
                if (!this.repositoryMatchesCriteria(existing, matchCriteria)) return;
            }

            if (source === 'override' && clone.location && existing && !existing.location)
                existing.location = clone.location;

            if (existing) {
                mergedMap.set(key, { ...existing, ...clone });
            } else {
                mergedMap.set(key, clone);
                mergedOrder.push(key);
            }
        };

        baseList.forEach((entry) => addEntry(entry, 'base'));
        overrideList.forEach((entry) => addEntry(entry, 'override'));

        const mergedList = mergedOrder.map((key) => this.deepClone(mergedMap.get(key)));
        return this.attachRepositoryAliases(mergedList);
    }

    attachRepositoryAliases(list) {
        if (!Array.isArray(list)) {
            return list;
        }

        const seen = new Set();
        list.forEach((entry) => {
            const alias = this.getRepositoryAlias(entry);
            if (!alias || this.isNumericString(alias) || seen.has(alias)) {
                return;
            }
            Object.defineProperty(list, alias, {
                value: entry,
                writable: true,
                enumerable: true,
                configurable: true,
            });
            seen.add(alias);
        });

        return list;
    }

    getRepositoryAlias(entry) {
        if (!entry || typeof entry !== 'object') {
            return undefined;
        }
        if (typeof entry.repository === 'string' && entry.repository.length) {
            return entry.repository;
        }
        if (typeof entry.alias === 'string' && entry.alias.length) {
            return entry.alias;
        }
        if (typeof entry.name === 'string' && entry.name.length) {
            return entry.name;
        }
        return undefined;
    }

    repositoryMatchesCriteria(existing, criteria = {}) {
        if (!existing || typeof existing !== 'object') {
            return false;
        }

        for (const [key, expected] of Object.entries(criteria)) {
            if (expected === undefined || expected === null || expected === '') {
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(existing, key)) {
                return false;
            }
            if (existing[key] !== expected) {
                return false;
            }
        }

        return true;
    }

    deepClone(value) {
        if (value === undefined || value === null || typeof value !== 'object') {
            return value;
        }
        return JSON.parse(JSON.stringify(value));
    }

    isNumericString(value) {
        return typeof value === 'string' && /^\d+$/.test(value);
    }

    extractParameters(document) {
        const result = { parameters: {}, parameterMap: {} };
        if (!document || typeof document !== 'object') {
            return result;
        }

        const { parameters } = document;
        if (!parameters) {
            return result;
        }

        if (Array.isArray(parameters)) {
            for (const param of parameters) {
                if (param && typeof param === 'object' && param.name) {
                    const value = param.default;
                    result.parameters[param.name] = value !== undefined ? value : null;
                    result.parameterMap[`parameters.${param.name}`] = `parameters.${parameters.indexOf(param)}.default`;
                }
            }
        } else if (typeof parameters === 'object') {
            for (const [name, param] of Object.entries(parameters)) {
                if (param && typeof param === 'object') {
                    const value = param.default;
                    result.parameters[name] = value !== undefined ? value : null;
                } else {
                    result.parameters[name] = param;
                }
                result.parameterMap[`parameters.${name}`] = `parameters.${name}`;
            }
        }

        return result;
    }

    validateTemplateParameters(doc, providedParameters, templatePath, context) {
        if (!doc || typeof doc !== 'object' || !doc.parameters) return;

        const errors = { missingRequired: [], invalidValues: [], typeErrors: [], unknownParameters: [] };
        const checkParameter = (param, name) => this._validateParameter(param, name, providedParameters, errors);

        if (Array.isArray(doc.parameters)) {
            for (const param of doc.parameters) {
                checkParameter(param);
            }
        } else if (typeof doc.parameters === 'object') {
            for (const [name, param] of Object.entries(doc.parameters)) {
                checkParameter(param, name);
            }
        }

        this._checkUnknownParameters(doc.parameters, providedParameters, errors);
        this._reportValidationErrors(errors, templatePath, context);
    }

    _validateParameter(param, paramName, providedParameters, errors) {
        if (!param || typeof param !== 'object') return;

        const name = paramName || param.name;
        if (!name) return;

        const hasDefault = param.default !== undefined || param.value !== undefined || param.values !== undefined;
        const wasProvided = providedParameters && Object.prototype.hasOwnProperty.call(providedParameters, name);
        const paramValue = wasProvided ? providedParameters[name] : undefined;

        if (!hasDefault && !wasProvided) {
            errors.missingRequired.push(name);
        }

        // Skip validation when value is undefined or a runtime variable reference
        const isRuntimeVariable = typeof paramValue === 'string' && /\$\([^)]+\)/.test(paramValue);
        if (wasProvided && param.type !== undefined && paramValue !== undefined && !isRuntimeVariable) {
            const typeError = this._validateParameterType(name, param.type, paramValue);
            if (typeError) errors.typeErrors.push(typeError);
        }

        if (wasProvided && param.values && Array.isArray(param.values)) {
            if (!isRuntimeVariable && !param.values.includes(paramValue)) {
                errors.invalidValues.push({ name, value: paramValue, allowed: param.values });
            }
        }
    }

    _validateParameterType(name, paramType, paramValue) {
        const typeStr = String(paramType).toLowerCase();
        const actualType = typeof paramValue;

        switch (typeStr) {
            case 'string':
                if (!['string', 'number', 'boolean'].includes(actualType)) {
                    return { name, expected: 'string', actual: actualType, value: paramValue };
                }
                break;
            case 'number':
                if (!(actualType === 'number' || (actualType === 'string' && !isNaN(paramValue)))) {
                    return { name, expected: 'number', actual: actualType, value: paramValue };
                }
                break;
            case 'boolean':
                if (actualType !== 'boolean') {
                    if (actualType === 'string') {
                        const lower = paramValue.toLowerCase();
                        if (!['true', 'false', '__true__', '__false__'].includes(lower)) {
                            return { name, expected: 'boolean', actual: actualType, value: paramValue };
                        }
                    } else {
                        return { name, expected: 'boolean', actual: actualType, value: paramValue };
                    }
                }
                break;
            case 'object':
                if (name === 'dependsOn') {
                    if (!(actualType === 'string' || (actualType === 'object' && paramValue !== null))) {
                        return { name, expected: 'object', actual: actualType, value: paramValue };
                    }
                } else if (!(actualType === 'object' && paramValue !== null)) {
                    return { name, expected: 'object', actual: actualType, value: paramValue };
                }
                break;
            case 'step':
            case 'steplist':
            case 'job':
            case 'joblist':
            case 'deployment':
            case 'deploymentlist':
            case 'stage':
            case 'stagelist':
                if (!Array.isArray(paramValue)) {
                    return { name, expected: 'array (' + typeStr + ')', actual: actualType, value: paramValue };
                }
                break;
        }
        return null;
    }

    _checkUnknownParameters(templateParams, providedParameters, errors) {
        if (!providedParameters || typeof providedParameters !== 'object') return;

        const definedParams = new Set();
        if (Array.isArray(templateParams)) {
            templateParams.forEach((param) => param?.name && definedParams.add(param.name));
        } else if (typeof templateParams === 'object') {
            Object.keys(templateParams).forEach((name) => definedParams.add(name));
        }

        Object.keys(providedParameters).forEach((providedName) => {
            if (providedName !== '' && !definedParams.has(providedName)) {
                errors.unknownParameters.push(providedName);
            }
        });
    }

    _reportValidationErrors(errors, templatePath, context) {
        const errorMessages = [];
        const templateName = templatePath || 'template';

        if (errors.missingRequired.length > 0) {
            const paramList = errors.missingRequired.map((p) => `'${p}'`).join(', ');
            errorMessages.push(
                `Missing required parameter(s) for template '${templateName}': ${paramList}. ` +
                    `These parameters do not have default values and must be provided when calling the template.`
            );
        }

        if (errors.typeErrors.length > 0) {
            const errorDetails = errors.typeErrors
                .map(
                    (err) =>
                        `Parameter '${err.name}' expects type '${err.expected}' but received '${err.actual}' (value: ${JSON.stringify(err.value)})`
                )
                .join('\n    ');
            errorMessages.push(`Invalid parameter type(s) for template '${templateName}':\n    ${errorDetails}`);
        }

        if (errors.invalidValues.length > 0) {
            const errorDetails = errors.invalidValues
                .map(
                    (err) =>
                        `Parameter '${err.name}' has value '${err.value}' which is not in allowed values: [${err.allowed.join(', ')}]`
                )
                .join('\n    ');
            errorMessages.push(`Invalid parameter value(s) for template '${templateName}':\n    ${errorDetails}`);
        }

        if (errors.unknownParameters.length > 0) {
            const paramList = errors.unknownParameters.map((p) => `'${p}'`).join(', ');
            errorMessages.push(
                `Unknown parameter(s) for template '${templateName}': ${paramList}. ` +
                    `These parameters are not defined in the template.`
            );
        }

        if (errorMessages.length > 0) {
            let errorMessage = errorMessages.join('\n\n');
            if (context?.templateStack?.length > 0) {
                errorMessage += '\n  Template call stack:';
                errorMessage += '\n    ' + context.templateStack[0];
                for (let i = 1; i < context.templateStack.length; i++) {
                    errorMessage += '\n    ' + '  '.repeat(i) + '└── ' + context.templateStack[i];
                }
            }
            throw new Error(errorMessage);
        }
    }

    extractVariables(document) {
        const result = {};
        if (!document || typeof document !== 'object') {
            return result;
        }

        const { variables } = document;
        if (!variables) {
            return result;
        }

        if (Array.isArray(variables)) {
            for (const variable of variables) {
                if (variable && typeof variable === 'object' && variable.name) {
                    result[variable.name] = this.pickFirstDefined(variable.value, variable.default);
                }
            }
        } else if (typeof variables === 'object') {
            for (const [name, value] of Object.entries(variables)) {
                if (value && typeof value === 'object' && 'value' in value) {
                    result[name] = value.value;
                } else {
                    result[name] = value;
                }
            }
        }

        return result;
    }

    expandNode(node, context, parentKey = null) {
        let expanded;
        if (Array.isArray(node)) {
            expanded = this.expandArray(node, context, parentKey);
        } else if (node && typeof node === 'object') {
            expanded = this.expandObject(node, context, parentKey);
        } else {
            expanded = this.expandScalar(node, context);
        }

        // If this is the root call (parentKey is null), handle all metadata
        if (parentKey === null && expanded && typeof expanded === 'object' && !Array.isArray(expanded)) {
            // Attach script metadata collected during expansion
            expanded.__scriptsWithExpressions = context.scriptsWithExpressions || new Set();
            expanded.__scriptsWithLastLineExpressions = context.scriptsWithLastLineExpressions || new Set();

            // Save quote styles using quoteResult
            const quoteResult = context.quoteResult;
            if (quoteResult && typeof quoteResult.save === 'function') {
                quoteResult.save(expanded, context);
            }

            // Extract and clean up all metadata from expanded document
            context.scriptsWithExpressions = expanded.__scriptsWithExpressions || new Set();
            delete expanded.__scriptsWithExpressions;
            context.scriptsWithLastLineExpressions = expanded.__scriptsWithLastLineExpressions || new Set();
            delete expanded.__scriptsWithLastLineExpressions;
            if (expanded.__quoteStyles) delete expanded.__quoteStyles;
        }

        return expanded;
    }

    expandArray(array, context, parentKey = null) {
        const result = [];
        const isVarArray = parentKey === 'variables';

        for (let index = 0; index < array.length; index += 1) {
            const element = array[index];

            if (context.expansionPath) {
                context.expansionPath.push(index);
            }

            try {
                if (this.isTemplateReference(element)) {
                    this._expandTemplateReferenceToResult(element, context, result, isVarArray);
                    continue;
                }

                const singleKeyHandled = this._handleSingleKeyObjectInArray(element, array, index, context, result);
                if (singleKeyHandled.handled) {
                    index = typeof singleKeyHandled.nextIndex === 'number' ? singleKeyHandled.nextIndex : index;
                    continue;
                }

                const expanded = this.expandNode(element, context, parentKey);
                if (expanded === undefined) continue;

                // Handle array expansion - check items for template references
                if (Array.isArray(expanded)) {
                    this._expandAndAppendArrayItems(expanded, context, result, isVarArray);
                } else {
                    result.push(expanded);
                    this._updateVariableContext(expanded, isVarArray, context);
                }
            } finally {
                if (context.expansionPath) {
                    context.expansionPath.pop();
                }
            }
        }

        return result;
    }

    /**
     * Helper to expand a template reference element and push results into the provided result array.
     * If `isVarArray` is true, the helper also updates `context.variables` for any variable objects
     * produced by the template, preserving behavior previously duplicated in multiple locations.
     * @param {object} element - The template reference node or template item
     * @param {object} context - Expansion context
     * @param {array} result - Array to append expanded items to
     * @param {boolean} isVarArray - True when expanding inside a `variables` array
     */
    _expandTemplateReferenceToResult(element, context, result, isVarArray) {
        const templateItems = this.expandTemplateReference(element, context);
        if (Array.isArray(templateItems) && templateItems.length) {
            result.push(...templateItems);

            if (isVarArray) {
                for (const item of templateItems) {
                    if (item && typeof item === 'object' && !Array.isArray(item)) {
                        const varName = item.name;
                        const varValue = this.pickFirstDefined(item.value, item.default);
                        if (varName && varValue !== undefined) {
                            context.variables[varName] = varValue;
                        }
                    }
                }
            }
        }
    }

    /**
     * Expand array items and append to result, handling template references and variable updates.
     * @param {array} items - Array of items to expand
     * @param {object} context - Expansion context
     * @param {array} result - Result array to append to
     * @param {boolean} isVarArray - Whether we're in a variables array
     */
    _expandAndAppendArrayItems(items, context, result, isVarArray) {
        for (const item of items) {
            if (this.isTemplateReference(item)) {
                this._expandTemplateReferenceToResult(item, context, result, isVarArray);
            } else {
                result.push(item);
                this._updateVariableContext(item, isVarArray, context);
            }
        }
    }

    /**
     * Update context.variables if the expanded item is a variable object.
     * @param {any} item - The expanded item
     * @param {boolean} isVarArray - Whether we're in a variables array
     * @param {object} context - Expansion context
     */
    _updateVariableContext(item, isVarArray, context) {
        if (!isVarArray || !item || typeof item !== 'object' || Array.isArray(item)) return;

        const varName = item.name;
        const varValue = this.pickFirstDefined(item.value, item.default);
        if (varName && varValue !== undefined) {
            context.variables[varName] = varValue;
        }
    }

    /**
     * Get quote styles map from context, creating empty map if needed.
     * @param {object} context - Expansion context
     * @returns {Map} Quote styles map
     */
    _getQuoteStylesMap(context) {
        return context.quoteResult?.quoteStyles || new Map();
    }

    /**
     * Track a string value that had template expressions for quote and script handling.
     * @param {string} expandedValue - The expanded string value
     * @param {object} context - Expansion context
     * @param {object} flags - Object with tracking flags
     */
    _trackExpressionValue(expandedValue, context, flags) {
        const { hadMultilineExpr, lastLineHadExpression } = flags;

        if (!hadMultilineExpr || typeof expandedValue !== 'string') return;

        const contentKey = expandedValue.replace(/\s+$/, '');

        if (!context.scriptsWithExpressions) {
            context.scriptsWithExpressions = new Set();
        }
        context.scriptsWithExpressions.add(contentKey);

        if (lastLineHadExpression) {
            if (!context.scriptsWithLastLineExpressions) {
                context.scriptsWithLastLineExpressions = new Set();
            }
            context.scriptsWithLastLineExpressions.add(contentKey);
        }
    }

    /**
     * Handle quote style tracking for mixed and full expressions.
     * @param {string} expandedValue - The expanded value
     * @param {string} originalValue - The original template value
     * @param {object} context - Expansion context
     * @param {object} flags - Object with expression type flags
     */
    _handleQuoteStyleTracking(expandedValue, originalValue, context, flags) {
        const { isMixedExpression, isSingleLineFullExpression } = flags;

        if (!context.expansionPath || typeof expandedValue !== 'string') return;

        const quoteStyles = this._getQuoteStylesMap(context);
        const expansionPathKey = this.getQuoteStyleUniqueKey(context.expansionPath, expandedValue);

        // Handle mixed expressions (not full expressions)
        if (isMixedExpression && !this.isMultilineString(expandedValue)) {
            if (expandedValue.includes(':')) {
                quoteStyles.set(expansionPathKey, 'QUOTE_SINGLE');
            } else {
                if (!context.stringsWithExpressions) {
                    context.stringsWithExpressions = new Set();
                }
                context.stringsWithExpressions.add(expansionPathKey);
            }
            return;
        }

        // Handle full expressions that expanded
        if (isSingleLineFullExpression && expandedValue !== originalValue) {
            let parameterPath = context.expansionPath;
            let quoteStyle = null;

            if (this.isParameter(originalValue)) {
                const param = this.stripExpressionDelimiters(originalValue);
                if (context.parameterMap[param]) {
                    parameterPath = context.parameterMap[param].split('.');
                }
                const parameterKey = this.getQuoteStyleUniqueKey(parameterPath, expandedValue);
                quoteStyle = quoteStyles.get(parameterKey);
                let variablePath = context.expansionPath;
                if (context.expansionPath.length >= 3 && context.expansionPath[2] === 'variables') {
                    variablePath = context.expansionPath.filter((_, i) => i !== 2);
                }
                const variableKey = this.getQuoteStyleUniqueKey(variablePath, expandedValue);
                if (quoteStyle) {
                    quoteStyles.set(variableKey, quoteStyle);
                }
            } else {
                // Look up quote style using the original expression, not the expanded value
                const originalKey = this.getQuoteStyleUniqueKey(context.expansionPath, originalValue);
                const quoteStyle = quoteStyles.get(originalKey);
                if (quoteStyle) {
                    quoteStyles.set(expansionPathKey, expandedValue.includes(':') ? 'QUOTE_SINGLE' : quoteStyle);
                }
            }
        }
    }

    /**
     * Handle a single-key object found inside an array during expansion.
     * Recognizes ${{ each }} and conditional directives and applies them,
     * appending produced items to `result`.
     *
     * Note on `nextIndex`: when returned, `nextIndex` is the "last-consumed-index"
     * within the input `array` (i.e., the final index that was processed as
     * part of the directive). Callers iterating with a `for` loop should set
     * the loop index to `nextIndex` (the loop will increment it to continue),
     * while callers using a `while` loop should advance to `nextIndex + 1`.
     *
     * @param {any} element - The array element to inspect
     * @param {array} array - The parent array being iterated
     * @param {number} index - Current index within the parent array
     * @param {object} context - Expansion context
     * @param {array} result - Result array to append expanded items to
     * @returns {{handled: boolean, nextIndex?: number}} - Whether the element was handled and updated next index
     */
    _handleSingleKeyObjectInArray(element, array, index, context, result) {
        if (!this.isSingleKeyObject(element)) return { handled: false };

        const key = Object.keys(element)[0];

        if (this.isEachDirective(key)) {
            const applied = this.applyEachDirective(key, element[key], context);
            if (applied && Array.isArray(applied.items) && applied.items.length) {
                result.push(...applied.items);
            }
            return { handled: true };
        }

        if (this.isConditionalDirective(key)) {
            const expanded = this.expandConditionalBlock(array, index, context);
            if (expanded && Array.isArray(expanded.items) && expanded.items.length) {
                result.push(...expanded.items);
            }
            return { handled: true, nextIndex: expanded.nextIndex };
        }

        return { handled: false };
    }

    expandObject(object, context, parentKey = null) {
        const entries = Object.entries(object);
        const result = {};

        for (let index = 0; index < entries.length; index += 1) {
            const [rawKey, value] = entries[index];

            if (this.isEachDirective(rawKey)) {
                const eachResult = this.expandEachEntries(entries, index, context);
                Object.assign(result, eachResult.merged);
                index = eachResult.nextIndex;
                continue;
            } else if (this.isConditionalDirective(rawKey)) {
                const conditional = this.expandConditionalEntries(entries, index, context);
                Object.assign(result, conditional.merged);
                index = conditional.nextIndex;
                continue;
            } else if (this.isInsertDirective(rawKey)) {
                const expandedValue = this.expandNodePreservingTemplates(value, context);
                if (expandedValue && typeof expandedValue === 'object' && !Array.isArray(expandedValue)) {
                    Object.assign(result, expandedValue);
                }
                continue;
            }

            const key = this.replaceExpressionsInString(rawKey, context);
            if (context.expansionPath) {
                context.expansionPath.push(key);
            }

            try {
                // Expression-related flags
                const flags = {
                    hadMultilineExpr: this.hasTemplateExpr(value) && this.isMultilineString(value),
                    stringHadExpressions: this.hasTemplateExpr(value),
                    lastLineHadExpression: this.lastLineHasTemplateExpression(value) && this.isMultilineString(value),
                    isSingleLineFullExpression: this.isFullExpression(value) && !this.isMultilineString(value),
                    isMixedExpression: false,
                };
                flags.isMixedExpression = flags.stringHadExpressions && !flags.isSingleLineFullExpression;

                const expandedValue = this.expandNode(value, context, key);
                if (expandedValue === undefined) continue;

                this._handleQuoteStyleTracking(expandedValue, value, context, flags);
                this._trackExpressionValue(expandedValue, context, flags);

                // Track single-line full expressions that expanded to multiline
                if (flags.isSingleLineFullExpression && this.isMultilineString(expandedValue)) {
                    const contentKey = expandedValue.replace(/\s+$/, '');
                    context.scriptsWithExpressions.add(contentKey);
                    context.scriptsWithLastLineExpressions.add(contentKey);
                }

                result[key] = expandedValue;
            } finally {
                if (context.expansionPath) {
                    context.expansionPath.pop();
                }
            }
        }

        // Convert shorthand (bash/script/pwsh/powershell/checkout) to task format when safe
        const shortKey = ['bash', 'script', 'pwsh', 'powershell', 'checkout'].find((k) =>
            Object.prototype.hasOwnProperty.call(result, k)
        );

        if (shortKey && !result.task && !result.inputs && !result.targetType && parentKey !== 'inputs') {
            const shortValue = result[shortKey];
            delete result[shortKey];

            const taskResult = { task: TASK_TYPE_MAP[shortKey] };

            if (shortKey === 'checkout') {
                const { condition, displayName, ...inputProps } = result;
                if (displayName) {
                    taskResult.displayName = displayName;
                }

                const taskCondition = condition !== undefined ? condition : shortValue === 'none' ? false : undefined;
                if (taskCondition !== undefined) {
                    taskResult.condition = taskCondition;
                }

                taskResult.inputs = Object.assign({ repository: shortValue }, inputProps);
            } else {
                const { workingDirectory, ...taskProps } = result;
                Object.assign(taskResult, taskProps);

                let inputs;
                if (shortKey !== 'script') {
                    inputs = { targetType: 'inline', script: shortValue };
                    if (shortKey === 'pwsh') {
                        inputs.pwsh = true;
                    }
                } else {
                    inputs = { script: shortValue };
                }

                if (workingDirectory !== undefined) {
                    inputs.workingDirectory = workingDirectory;
                }
                taskResult.inputs = inputs;
            }

            return taskResult;
        }

        // Convert pool string to object format for Azure Pipelines compatibility
        if (result.pool && typeof result.pool === 'string') {
            result.pool = {
                name: result.pool,
            };
        }

        // Convert dependsOn string to array format for consistent YAML formatting
        // Azure Pipelines accepts both, but we normalize to array for consistency
        if (result.dependsOn && typeof result.dependsOn === 'string') {
            result.dependsOn = [result.dependsOn];
        }

        // Set condition: false for checkout tasks with repository: none
        if (result.task === CHECKOUT_TASK && result.inputs?.repository === 'none' && !result.condition) {
            result.condition = false;
        }

        return result;
    }

    expandScalar(value, context) {
        if (typeof value !== 'string') {
            return value;
        }

        const trimmed = value.trim();
        if (this.isFullExpression(trimmed)) {
            const expr = this.stripExpressionDelimiters(trimmed);
            const result = this.evaluateExpression(expr, context);
            // If the expression evaluates to a template reference, expand it
            if (this.isTemplateReference(result)) {
                const expanded = this.expandTemplateReference(result, context);
                return expanded.length === 1 ? expanded[0] : expanded;
            }
            // Azure Azure Pipelines outputs booleans from expressions as "True"/"False"
            if (typeof result === 'boolean') {
                return this.returnBoolean(result);
            }
            return result;
        }

        return this.replaceExpressionsInString(value, context);
    }

    /**
     * Expand a sequence of conditional single-key objects (if/elseif/else) in an array.
     *
     * Returns an object with `items` (expanded branch items) and `nextIndex` indicating
     * the last array index that was consumed as part of the conditional chain. Callers
     * should treat `nextIndex` as "last-consumed-index" and advance to `nextIndex + 1`
     * when using a while-loop, or set the for-loop index to `nextIndex` (the for-loop
     * will increment it) when using a for-loop.
     *
     * @param {array} array - Parent array containing potential conditional chain
     * @param {number} startIndex - Index in `array` where the conditional chain may start
     * @param {object} context - Expansion context
     * @returns {{items: array, nextIndex: number}}
     */
    expandConditionalBlock(array, startIndex, context) {
        let index = startIndex;
        let branchTaken = false;
        let items = [];

        while (index < array.length) {
            const element = array[index];
            if (!this.isSingleKeyObject(element)) {
                break;
            }

            const [key] = Object.keys(element);
            const body = element[key];

            if (!this.isConditionalDirective(key)) {
                break;
            }

            // New if chain starts - break if not the first element
            if (this.isIfDirective(key) && index !== startIndex) {
                break;
            }

            if (!branchTaken && this.evaluateConditional(key, context)) {
                items = this.flattenBranchValue(body, context);
                branchTaken = true;
            }

            index += 1;
            if (this.isElseDirective(key)) break;
        }

        return { items, nextIndex: index - 1 };
    }

    /**
     * Expand a sequence of conditional mapping entries (if/elseif/else) within an object's
     * entries array. Returns `{ merged, nextIndex }` where `nextIndex` is the last
     * entry index consumed by the conditional chain ("last-consumed-index").
     */
    expandConditionalEntries(entries, startIndex, context) {
        let index = startIndex;
        let branchTaken = false;
        let merged = {};

        while (index < entries.length) {
            const [key, body] = entries[index];
            if (!this.isConditionalDirective(key)) {
                break;
            }

            if (!branchTaken && this.evaluateConditional(key, context)) {
                merged = this.expandConditionalMappingBranch(body, context);
                branchTaken = true;
            }

            index += 1;
            if (this.isElseDirective(key)) break;
        }

        return { merged, nextIndex: Math.max(startIndex, index - 1) };
    }

    expandConditionalMappingBranch(body, context) {
        if (Array.isArray(body)) {
            return this.expandArray(body, context).reduce((acc, item) => {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    return { ...acc, ...item };
                }
                return acc;
            }, {});
        }

        if (body && typeof body === 'object') return this.expandObject(body, context);

        const scalar = this.expandScalar(body, context);
        return scalar === undefined ? {} : { value: scalar };
    }

    /**
     * Expand a sequence of `each` mapping entries starting at `startIndex`.
     * Returns `{ merged, nextIndex }` where `nextIndex` is the last entry index
     * consumed by the expansion ("last-consumed-index").
     */
    expandEachEntries(entries, startIndex, context) {
        let index = startIndex;
        const merged = {};

        while (index < entries.length) {
            const [key, body] = entries[index];
            if (!this.isEachDirective(key)) {
                break;
            }

            const loop = this.parseEachDirective(key);
            if (!loop) {
                index += 1;
                continue;
            }

            const collectionValue = this.evaluateExpression(loop.collection, context);
            const normalizedCollection = this.normalizeCollection(collectionValue);

            normalizedCollection.forEach((item, itemIndex) => {
                const locals = {
                    [loop.variable]: item,
                    [`${loop.variable}Index`]: itemIndex,
                };
                const iterationContext = this.createChildContext(context, locals);
                const branch = this.expandConditionalMappingBranch(body, iterationContext);

                if (Object.prototype.hasOwnProperty.call(branch, '--')) {
                    const iterationKey = this.resolveEachIterationKey(item, itemIndex, iterationContext, loop.variable);
                    const value = branch['--'];
                    delete branch['--'];
                    if (iterationKey !== undefined && iterationKey !== null) {
                        merged[iterationKey] = value;
                    }
                }

                Object.assign(merged, branch);
            });

            index += 1;
        }

        return {
            merged,
            nextIndex: Math.max(startIndex, index - 1),
        };
    }

    resolveEachIterationKey(item, index, iterationContext, variableName) {
        if (item === undefined || item === null) {
            return String(index);
        }

        const unwrap = (value) => {
            if (value === undefined || value === null) {
                return undefined;
            }
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                return String(value);
            }
            return undefined;
        };

        const simple = unwrap(item);
        if (simple !== undefined) {
            return simple;
        }

        if (item && typeof item === 'object') {
            const candidateKeys = ['key', 'name', 'matrixKey', 'label', 'id'];
            for (const prop of candidateKeys) {
                if (Object.prototype.hasOwnProperty.call(item, prop)) {
                    const candidate = unwrap(item[prop]);
                    if (candidate !== undefined) {
                        return candidate;
                    }
                }
            }

            if (Object.prototype.hasOwnProperty.call(item, 'value')) {
                const nested = unwrap(item.value);
                if (nested !== undefined) {
                    return nested;
                }
            }
        }

        if (typeof variableName === 'string' && variableName.length) {
            const evaluated = this.evaluateExpression(variableName, iterationContext);
            const fallback = unwrap(evaluated);
            if (fallback !== undefined) {
                return fallback;
            }
        }

        return String(index);
    }

    flattenBranchValue(value, context) {
        if (Array.isArray(value)) {
            return this.expandArray(value, context);
        }

        if (value && typeof value === 'object') {
            return [this.expandObject(value, context)];
        }

        const scalar = this.expandScalar(value, context);
        return scalar === undefined ? [] : [scalar];
    }

    /**
     * Apply a single `each` directive (directive string + body) and return expanded
     * items. This helper operates on a single directive and therefore does not
     * return a `nextIndex` — callers should advance by one index after using it.
     *
     * @returns {{items: array}}
     */
    applyEachDirective(directive, body, context) {
        const loop = this.parseEachDirective(directive);
        if (!loop) {
            return { items: [] };
        }

        const collectionValue = this.evaluateExpression(loop.collection, context);
        const normalizedCollection = this.normalizeCollection(collectionValue);
        const items = [];

        normalizedCollection.forEach((item, idx) => {
            const locals = { [loop.variable]: item, [`${loop.variable}Index`]: idx };
            const iterationContext = this.createChildContext(context, locals);
            const expanded = this.flattenBranchValue(body, iterationContext);
            items.push(...expanded);
        });

        return { items };
    }

    replaceExpressionsInString(input, context) {
        if (typeof input !== 'string') {
            return input;
        }

        let result = input.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (match, expr) => {
            const value = this.evaluateExpression(expr, context);
            if (value === undefined || value === null) {
                // Check if this is a parameter reference that might be a runtime variable
                // If so, convert it to a runtime variable reference format
                if (expr.trim().startsWith('parameters.')) {
                    const paramName = expr.trim().substring('parameters.'.length);
                    // Return as runtime variable $(paramName) instead of empty string
                    return `$(${paramName})`;
                }
                return '';
            }
            if (typeof value === 'object') {
                return JSON.stringify(value);
            }
            // Handle boolean markers - convert to proper case
            if (typeof value === 'string') {
                const lower = value.toLowerCase();
                if (lower === '__true__') return 'True';
                if (lower === '__false__') return 'False';
            }
            // Handle JavaScript booleans
            if (typeof value === 'boolean') {
                return this.returnBoolean(value);
            }
            return String(value);
        });

        // Clean up whitespace-only lines (from expressions expanding to empty)
        // Removes spaces/tabs but preserves the newline character for >+ chomping
        result = result.replace(/^[ \t]+$/gm, '');

        return result;
    }

    evaluateExpression(expression, context) {
        if (expression === undefined || expression === null) {
            return undefined;
        }

        const expr = String(expression).trim();
        if (expr.length === 0) {
            return undefined;
        }

        const ast = this.parseExpressionAst(expr);
        if (ast) {
            return this.evaluateAst(ast, context);
        }

        const resolved = this.resolveContextValue(expr, context);
        if (resolved !== undefined) {
            return resolved;
        }

        if (this.looksLikeContextPath(expr)) {
            return undefined;
        }

        return expr;
    }

    evaluateFunction(name, args) {
        const fn = String(name || '');
        const func = adoFunctions[fn];
        return func ? func(args) : undefined;
    }

    parseExpressionAst(expr) {
        if (this.expressionCache.has(expr)) {
            return this.expressionCache.get(expr);
        }

        try {
            const preprocessed = this.preprocessExpressionString(expr);
            const ast = jsep(preprocessed);
            this.expressionCache.set(expr, ast);
            return ast;
        } catch (error) {
            this.expressionCache.set(expr, null);
            return null;
        }
    }

    preprocessExpressionString(expr) {
        if (typeof expr !== 'string') {
            return expr;
        }

        // Fix unescaped backslashes in string literals for Azure Pipelines compatibility
        // Azure Pipelines allows '\' in strings, but JavaScript requires '\\'
        // Use regex to find string literals and escape single backslashes within them

        return expr.replace(/(['"])((?:\\.|(?!\1).)*?)\1/g, (match, quote, content) => {
            // Process the string content to escape single backslashes
            // Replace single backslash with double, but preserve existing escape sequences
            const escaped = content.replace(/\\(?![\\'"nrtbfv0xu])/g, '\\\\');
            return quote + escaped + quote;
        });
    }

    evaluateAst(node, context) {
        if (!node) {
            return undefined;
        }

        switch (node.type) {
            case 'Literal':
                return node.value;
            case 'Identifier':
                return this.resolveIdentifier(node.name, context);
            case 'ThisExpression':
                return context;
            case 'ArrayExpression':
                return node.elements.map((element) => this.evaluateAst(element, context));
            case 'ObjectExpression': {
                const obj = {};
                node.properties.forEach((prop) => {
                    const keyNode = prop.key;
                    const key = prop.computed
                        ? this.evaluateAst(keyNode, context)
                        : keyNode.type === 'Identifier'
                          ? keyNode.name
                          : this.evaluateAst(keyNode, context);
                    if (key === undefined) {
                        return;
                    }
                    obj[key] = this.evaluateAst(prop.value, context);
                });
                return obj;
            }
            case 'UnaryExpression':
                return this.evaluateUnary(node.operator, this.evaluateAst(node.argument, context));
            case 'BinaryExpression':
                return this.evaluateBinary(
                    node.operator,
                    this.evaluateAst(node.left, context),
                    this.evaluateAst(node.right, context)
                );
            case 'LogicalExpression': {
                const left = this.evaluateAst(node.left, context);
                if (node.operator === '&&') {
                    return this.toBoolean(left) ? this.evaluateAst(node.right, context) : left;
                }
                if (node.operator === '||') {
                    return this.toBoolean(left) ? left : this.evaluateAst(node.right, context);
                }
                if (node.operator === '??') {
                    return left !== undefined && left !== null ? left : this.evaluateAst(node.right, context);
                }
                return undefined;
            }
            case 'ConditionalExpression':
                return this.toBoolean(this.evaluateAst(node.test, context))
                    ? this.evaluateAst(node.consequent, context)
                    : this.evaluateAst(node.alternate, context);
            case 'MemberExpression': {
                const target = this.evaluateAst(node.object, context);
                if (target === undefined || target === null) {
                    return undefined;
                }
                const property = node.computed
                    ? this.evaluateAst(node.property, context)
                    : node.property.type === 'Identifier'
                      ? node.property.name
                      : this.evaluateAst(node.property, context);
                if (property === undefined || property === null) {
                    return undefined;
                }
                return target[property];
            }
            case 'CallExpression': {
                const callable = this.resolveCallable(node.callee, context);
                const args = node.arguments.map((arg) => this.evaluateAst(arg, context));
                if (callable?.builtinName) {
                    const result = this.evaluateFunction(callable.builtinName, args);
                    if (result !== undefined) {
                        return result;
                    }
                }
                if (callable && typeof callable.fn === 'function') {
                    return callable.fn.apply(callable.thisArg !== undefined ? callable.thisArg : context, args);
                }
                return undefined;
            }
            default:
                return undefined;
        }
    }

    resolveIdentifier(name, context) {
        if (!name) {
            return undefined;
        }

        const lowered = name.toLowerCase();
        if (lowered === 'true') return true;
        if (lowered === 'false') return false;
        if (lowered === 'null') return null;
        if (lowered === 'undefined') return undefined;

        if (context.locals && Object.prototype.hasOwnProperty.call(context.locals, name)) {
            return context.locals[name];
        }

        if (Object.prototype.hasOwnProperty.call(context.parameters, name)) {
            return context.parameters[name];
        }

        if (Object.prototype.hasOwnProperty.call(context.variables, name)) {
            return context.variables[name];
        }

        switch (name) {
            case 'parameters':
                return context.parameters;
            case 'variables':
                return context.variables;
            case 'resources':
                return context.resources;
            case 'locals':
                return context.locals;
            default:
                return undefined;
        }
    }

    resolveCallable(callee, context) {
        if (!callee) {
            return {};
        }

        if (callee.type === 'Identifier') {
            const name = callee.name;
            const value = this.resolveIdentifier(name, context);
            if (typeof value === 'function') {
                return { fn: value };
            }
            return { builtinName: name };
        }

        if (callee.type === 'MemberExpression') {
            const target = this.evaluateAst(callee.object, context);
            if (target === undefined || target === null) {
                return {};
            }

            const property = callee.computed
                ? this.evaluateAst(callee.property, context)
                : callee.property.type === 'Identifier'
                  ? callee.property.name
                  : this.evaluateAst(callee.property, context);

            if (property === undefined || property === null) {
                return {};
            }

            const fn = target[property];
            if (typeof fn === 'function') {
                return { fn, thisArg: target };
            }

            return { builtinName: property };
        }

        const value = this.evaluateAst(callee, context);
        if (typeof value === 'function') {
            return { fn: value };
        }

        return {};
    }

    evaluateUnary(operator, value) {
        switch (operator) {
            case '!':
                return !this.toBoolean(value);
            case '+':
                return Number(value);
            case '-':
                return -Number(value);
            default:
                return undefined;
        }
    }

    evaluateBinary(operator, left, right) {
        switch (operator) {
            case '==':
            case '===':
                return this.compareValues(left, right) === 0;
            case '!=':
            case '!==':
                return this.compareValues(left, right) !== 0;
            case '<':
                return this.compareValues(left, right) < 0;
            case '<=':
                return this.compareValues(left, right) <= 0;
            case '>':
                return this.compareValues(left, right) > 0;
            case '>=':
                return this.compareValues(left, right) >= 0;
            case '+':
                if (typeof left === 'string' || typeof right === 'string') {
                    return `${left ?? ''}${right ?? ''}`;
                }
                return (Number(left) || 0) + (Number(right) || 0);
            case '-':
                return (Number(left) || 0) - (Number(right) || 0);
            case '*':
                return (Number(left) || 0) * (Number(right) || 0);
            case '/':
                return (Number(left) || 0) / (Number(right) || 0);
            case '%':
                return (Number(left) || 0) % (Number(right) || 0);
            default:
                return undefined;
        }
    }

    contains(container, value) {
        if (typeof container === 'string') {
            return typeof value === 'string' ? container.includes(value) : false;
        }
        if (Array.isArray(container)) {
            return container.some((item) => this.compareValues(item, value) === 0);
        }
        if (container && typeof container === 'object') {
            return Object.prototype.hasOwnProperty.call(container, value);
        }
        return false;
    }

    compareValues(left, right) {
        const normalize = (input) => {
            if (input === undefined || input === null) {
                return '';
            }
            if (typeof input === 'string') {
                const trimmed = input.trim();
                if (trimmed.length === 0) {
                    return '';
                }
                const lowered = trimmed.toLowerCase();
                if (lowered === 'true' || lowered === '__true__') {
                    return true;
                }
                if (lowered === 'false' || lowered === '__false__') {
                    return false;
                }
                if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
                    return Number(trimmed);
                }
                return trimmed;
            }
            return input;
        };

        const a = normalize(left);
        const b = normalize(right);

        if (a === b) {
            return 0;
        }

        if (typeof a === typeof b && (typeof a === 'number' || typeof a === 'boolean')) {
            return a > b ? 1 : -1;
        }

        const aString = String(a);
        const bString = String(b);

        if (aString === bString) {
            return 0;
        }

        return aString > bString ? 1 : -1;
    }

    resolveContextValue(path, context) {
        const sanitized = this.sanitizePath(path);
        const segments = sanitized.split('.').filter((segment) => segment.length > 0);
        if (segments.length === 0) {
            return undefined;
        }

        const [first, ...rest] = segments;

        if (context.locals && Object.prototype.hasOwnProperty.call(context.locals, first)) {
            return this.walkSegments(context.locals[first], rest);
        }

        if (first === 'parameters') {
            return this.walkSegments(context.parameters, rest);
        }

        if (first === 'variables') {
            return this.walkSegments(context.variables, rest);
        }

        if (first === 'resources') {
            return this.walkSegments(context.resources, rest);
        }

        if (Object.prototype.hasOwnProperty.call(context.parameters, first)) {
            return this.walkSegments(context.parameters[first], rest);
        }

        if (Object.prototype.hasOwnProperty.call(context.variables, first)) {
            return this.walkSegments(context.variables[first], rest);
        }

        if (context.locals && Object.prototype.hasOwnProperty.call(context.locals, first)) {
            return this.walkSegments(context.locals[first], rest);
        }

        return undefined;
    }

    walkSegments(current, segments) {
        let value = current;
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (value === undefined || value === null) {
                return undefined;
            }
            // If we're accessing a nested property (not top-level) that doesn't exist on an object,
            // return empty string instead of undefined (Azure DevOps behavior)
            if (i > 0 && typeof value === 'object' && !Array.isArray(value) && !(segment in value)) {
                return '';
            }
            value = value[segment];
        }
        return value;
    }

    sanitizePath(path) {
        return path.replace(/\[(\d+)\]/g, '.$1').replace(/\[(?:'|")([^'"]+)(?:'|")\]/g, '.$1');
    }

    looksLikeContextPath(expr) {
        if (typeof expr !== 'string') {
            return false;
        }
        return /^[a-zA-Z_][\w]*[.\[]/.test(expr.trim());
    }

    toBoolean(value) {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            return value !== 0;
        }
        if (typeof value === 'string') {
            const lowered = value.toLowerCase();
            if (lowered === '__true__' || lowered === 'true') {
                return true;
            }
            if (lowered === '__false__' || lowered === 'false' || lowered.length === 0) {
                return false;
            }
        }
        return Boolean(value);
    }

    /** Returns boolean as marker string (__TRUE__/__FALSE__) for Azure-compatible output. */
    returnBoolean(value) {
        return value ? '__TRUE__' : '__FALSE__';
    }

    createChildContext(parent, locals) {
        return {
            parameters: parent.parameters,
            parameterMap: parent.parameterMap,
            variables: parent.variables,
            resources: parent.resources,
            locals: { ...parent.locals, ...locals },
            baseDir: parent.baseDir,
            repositoryBaseDir: parent.repositoryBaseDir,
            resourceLocations: parent.resourceLocations || {},
            scriptsWithExpressions: parent.scriptsWithExpressions, // Preserve scripts tracking
            scriptsWithLastLineExpressions: parent.scriptsWithLastLineExpressions, // Preserve last line tracking
            templateQuoteStyles: parent.templateQuoteStyles, // Preserve template quote styles map
            quoteResult: parent.quoteResult, // Preserve captured quote result
        };
    }

    createTemplateContext(parent, parameterOverrides, baseDir, options = {}) {
        return {
            parameters: { ...parent.parameters, ...parameterOverrides },
            parameterMap: { ...parent.parameterMap },
            variables: { ...parent.variables }, // Preserve variables from parent context (includes overrides)
            resources: parent.resources,
            locals: { ...parent.locals },
            baseDir: baseDir || parent.baseDir,
            repositoryBaseDir:
                options.repositoryBaseDir !== undefined ? options.repositoryBaseDir : parent.repositoryBaseDir,
            resourceLocations: parent.resourceLocations || {},
            templateStack: parent.templateStack || [],
            templateQuoteStyles: parent.templateQuoteStyles, // Preserve template quote styles map
            scriptsWithExpressions: parent.scriptsWithExpressions, // Preserve scripts tracking
            scriptsWithLastLineExpressions: parent.scriptsWithLastLineExpressions, // Preserve last line tracking
            expansionPath: parent.expansionPath || [], // Preserve expansion path for quote tracking
            stringsWithExpressions: parent.stringsWithExpressions, // Preserve strings with expressions tracking
            quoteResult: parent.quoteResult, // Preserve quote result for quote tracking
        };
    }

    normalizeCollection(value) {
        if (Array.isArray(value)) {
            return value;
        }
        if (value && typeof value === 'object') {
            return Object.entries(value).map(([key, entryValue]) => ({ key, value: entryValue }));
        }
        return [];
    }

    isSingleKeyObject(element) {
        return element && typeof element === 'object' && !Array.isArray(element) && Object.keys(element).length === 1;
    }

    isTemplateReference(element) {
        return element && typeof element === 'object' && !Array.isArray(element) && 'template' in element;
    }

    expandTemplateReference(node, context) {
        const templateRaw = node.template;
        const templatePathValue =
            typeof templateRaw === 'string'
                ? this.replaceExpressionsInString(templateRaw, context)
                : this.expandScalar(templateRaw, context);

        if (!templatePathValue || typeof templatePathValue !== 'string') {
            return [];
        }

        const repositoryRef = this.parseRepositoryTemplateReference(templatePathValue);

        let resolvedPath;
        let templateBaseDir;
        let repositoryBaseDirectoryForContext = context.repositoryBaseDir || undefined;

        if (repositoryRef) {
            const repositoryEntry = this.resolveRepositoryEntry(repositoryRef.repository, context);
            if (!repositoryEntry) {
                throw new Error(
                    `Repository resource '${repositoryRef.repository}' is not defined for template '${templatePathValue}'.`
                );
            }

            const repositoryLocation = this.resolveRepositoryLocation(repositoryEntry, context);
            if (!repositoryLocation) {
                throw new Error(
                    `Repository resource '${repositoryRef.repository}' does not define a local location. ` +
                        `Set a 'location' for this resource (for example via the 'azurePipelineStudio.resourceLocations' setting).`
                );
            }

            const repositoryBaseDirectory = this.resolveRepositoryBaseDirectory(repositoryLocation, context);
            repositoryBaseDirectoryForContext = repositoryBaseDirectory;
            const currentDirectory = context.baseDir || repositoryBaseDirectory;
            resolvedPath = this.resolveTemplateWithinRepository(
                repositoryRef.templatePath,
                currentDirectory,
                repositoryBaseDirectory
            );

            if (!resolvedPath) {
                throw new Error(
                    `Template file not found for repository '${repositoryRef.repository}': ${repositoryRef.templatePath}`
                );
            }

            templateBaseDir = path.dirname(resolvedPath);
        } else {
            const repositoryBaseDirectory = context.repositoryBaseDir || undefined;
            const candidatePath = this.resolveTemplateWithinRepository(
                templatePathValue,
                context.baseDir,
                repositoryBaseDirectory
            );

            if (candidatePath) {
                resolvedPath = candidatePath;
                templateBaseDir = path.dirname(resolvedPath);
                repositoryBaseDirectoryForContext = repositoryBaseDirectoryForContext || repositoryBaseDirectory;
            } else {
                const baseDir = context.baseDir || process.cwd();
                resolvedPath = path.isAbsolute(templatePathValue)
                    ? templatePathValue
                    : path.resolve(baseDir, templatePathValue);
                templateBaseDir = path.dirname(resolvedPath);
            }
        }

        if (!fs.existsSync(resolvedPath)) {
            const identifier = repositoryRef
                ? `${repositoryRef.templatePath}@${repositoryRef.repository}`
                : templatePathValue;
            throw new Error(`Template file not found: ${identifier}`);
        }

        const templateSource = fs.readFileSync(resolvedPath, 'utf8');

        let templateDocument;
        try {
            // Parse as document to extract quote styles
            const yamlDoc = YAML.parseDocument(templateSource);
            const templateQuoteStyles = new Map();
            this.extractQuoteStyles(yamlDoc.contents, [], templateQuoteStyles);

            // Register template quote styles so captureQuoteStyles.save() can merge them later
            if (templateQuoteStyles.size > 0) {
                context.templateQuoteStyles.set(resolvedPath, templateQuoteStyles);

                // Merge template quote styles into current context immediately
                // so they're available during expansion
                if (context.quoteResult && context.quoteResult.quoteStyles) {
                    for (const [key, style] of templateQuoteStyles.entries()) {
                        if (!context.quoteResult.quoteStyles.has(key)) {
                            context.quoteResult.quoteStyles.set(key, style);
                        }
                    }
                }
            }

            templateDocument = yamlDoc.toJSON() || {};
        } catch (error) {
            throw new Error(`Failed to parse template '${templatePathValue}': ${error.message}`);
        }

        const { parameters: defaultParameters, parameterMap: defaultParameterMap } =
            this.extractParameters(templateDocument);
        const providedParameters = this.normalizeTemplateParameters(node.parameters, context);

        const templateDisplayPath = repositoryRef
            ? `${repositoryRef.templatePath}@${repositoryRef.repository}`
            : templatePathValue;

        const updatedContext = {
            ...context,
            templateStack: [...(context.templateStack || []), templateDisplayPath],
            parameterMap: { ...context.parameterMap, ...defaultParameterMap }, // Merge template's parameterMap
        };

        this.validateTemplateParameters(templateDocument, providedParameters, templatePathValue, updatedContext);

        const mergedParameters = { ...defaultParameters, ...providedParameters };

        const templateContext = this.createTemplateContext(updatedContext, mergedParameters, templateBaseDir, {
            repositoryBaseDir: repositoryBaseDirectoryForContext,
        });

        const expandedTemplate = this.expandNode(templateDocument, templateContext) || {};

        console.log(
            '[DEBUG] expandedTemplate.variables type:',
            typeof expandedTemplate.variables,
            'isArray:',
            Array.isArray(expandedTemplate.variables)
        );
        console.log('[DEBUG] expandedTemplate.variables:', JSON.stringify(expandedTemplate.variables, null, 2));

        // Convert template variables to array format before extracting body
        this.convertVariablesToArrayFormat(expandedTemplate, templateContext);

        const body = this.extractTemplateBody(expandedTemplate);

        // If the body is a variables array, normalize any remaining shorthand formats
        if (Array.isArray(body) && body.length > 0 && this.isVariableArray(body)) {
            const normalized = this.normalizeVariableArray(body, templateContext);
            console.log('[DEBUG] Normalized template variables:', JSON.stringify(normalized, null, 2));
            console.log(
                '[DEBUG] Quote styles after normalization:',
                Array.from(templateContext.quoteResult?.quoteStyles.entries() || [])
            );
            return normalized;
        }

        return body;
    }

    parseRepositoryTemplateReference(templatePathValue) {
        if (typeof templatePathValue !== 'string') {
            return undefined;
        }

        const atIndex = templatePathValue.lastIndexOf('@');
        if (atIndex <= 0 || atIndex === templatePathValue.length - 1) {
            return undefined;
        }

        const templatePath = templatePathValue.slice(0, atIndex).trim();
        const repository = templatePathValue.slice(atIndex + 1).trim();

        if (!templatePath || !repository) {
            return undefined;
        }

        return {
            templatePath,
            repository,
        };
    }

    resolveRepositoryEntry(alias, context) {
        if (!alias || !context) {
            return undefined;
        }

        let repositoryEntry = undefined;

        // First check YAML-defined resources
        if (context.resources) {
            const repositories = context.resources.repositories;
            if (repositories) {
                if (repositories[alias]) {
                    repositoryEntry = repositories[alias];
                } else if (Array.isArray(repositories)) {
                    repositoryEntry = repositories.find((entry) => this.getRepositoryAlias(entry) === alias);
                }
            }
        }

        // If found in YAML but has no location, supplement with external resourceLocations
        if (repositoryEntry && context.resourceLocations && context.resourceLocations[alias]) {
            // Check if the repository entry already has a location field
            const hasLocation =
                repositoryEntry.location ||
                repositoryEntry.path ||
                repositoryEntry.directory ||
                repositoryEntry.localPath;

            if (!hasLocation) {
                // Add location from external resourceLocations
                repositoryEntry = {
                    ...repositoryEntry,
                    location: context.resourceLocations[alias],
                };
            }
        }

        // If not found in YAML at all, check external resourceLocations
        if (!repositoryEntry && context.resourceLocations && context.resourceLocations[alias]) {
            // Return a minimal repository entry with the location
            repositoryEntry = {
                repository: alias,
                location: context.resourceLocations[alias],
            };
        }

        return repositoryEntry;
    }

    resolveRepositoryLocation(repositoryEntry, context) {
        if (!repositoryEntry || typeof repositoryEntry !== 'object') {
            return undefined;
        }

        const location = [
            repositoryEntry.location,
            repositoryEntry.path,
            repositoryEntry.directory,
            repositoryEntry.localPath,
        ].find((value) => typeof value === 'string' && value.trim().length);

        if (!location) {
            return undefined;
        }

        const replaced = this.replaceExpressionsInString(location, context);
        if (!replaced || typeof replaced !== 'string') {
            return undefined;
        }

        const trimmed = replaced.trim();
        if (!trimmed) {
            return undefined;
        }

        const expanded = this.expandUserHome(trimmed);

        if (expanded && typeof repositoryEntry === 'object') {
            // Preserve original value so callers can reference the resolved location later.
            repositoryEntry.__resolvedLocation = expanded;

            if (
                !repositoryEntry.location ||
                repositoryEntry.location === location ||
                repositoryEntry.location === trimmed
            ) {
                repositoryEntry.location = expanded;
            } else if (!repositoryEntry.localLocation) {
                repositoryEntry.localLocation = expanded;
            }
        }

        return expanded;
    }

    expandUserHome(input) {
        if (typeof input !== 'string') {
            return input;
        }

        if (input.startsWith('~')) {
            return path.join(os.homedir(), input.slice(1));
        }

        return input;
    }

    resolveRepositoryBaseDirectory(repositoryLocation, context) {
        const fallback = context.baseDir || process.cwd();

        if (!repositoryLocation) {
            return fallback;
        }

        const absoluteLocation = path.isAbsolute(repositoryLocation)
            ? repositoryLocation
            : path.resolve(fallback, repositoryLocation);

        try {
            const stat = fs.statSync(absoluteLocation);
            if (stat.isFile()) {
                return path.dirname(absoluteLocation);
            }
            if (stat.isDirectory()) {
                return absoluteLocation;
            }
        } catch (error) {
            // Path does not currently exist; fall back to the resolved location
        }

        return absoluteLocation;
    }

    resolveTemplateWithinRepository(templatePath, currentDirectory, repositoryBaseDirectory) {
        if (!templatePath) {
            return undefined;
        }

        const parts = String(templatePath)
            .replace(/^[\\/]+/, '')
            .split(/[\\/]+/)
            .filter((segment) => segment?.length);

        const candidateBases = [];

        if (repositoryBaseDirectory) {
            candidateBases.push(repositoryBaseDirectory);
        }

        if (
            currentDirectory &&
            (!repositoryBaseDirectory || path.normalize(repositoryBaseDirectory) !== path.normalize(currentDirectory))
        ) {
            candidateBases.push(currentDirectory);
        }

        if (!candidateBases.length) {
            return undefined;
        }

        const candidateFiles = candidateBases.map((base) =>
            parts.length ? path.resolve(base, ...parts) : path.normalize(base)
        );

        for (const candidate of candidateFiles) {
            try {
                const stat = fs.statSync(candidate);
                if (stat.isFile()) {
                    return path.normalize(candidate);
                }
            } catch (error) {
                // Candidate does not exist relative to this base; continue searching
            }
        }

        return candidateFiles[0];
    }

    expandNodePreservingTemplates(node, context) {
        if (node === null || node === undefined) {
            return node;
        }

        // Helper to push expanded values into result array
        const pushExpanded = (result, expanded) => {
            if (expanded === null || expanded === undefined) return;
            if (Array.isArray(expanded)) {
                result.push(...expanded);
            } else {
                result.push(expanded);
            }
        };

        if (Array.isArray(node)) {
            const result = [];
            let i = 0;

            while (i < node.length) {
                const item = node[i];

                if (this.isTemplateReference(item)) {
                    result.push(item);
                    i++;
                    continue;
                }

                if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                    const handled = this._handleSingleKeyObjectInArray(item, node, i, context, result);
                    if (handled && handled.handled) {
                        i = handled.nextIndex !== undefined ? handled.nextIndex + 1 : i + 1;
                        continue;
                    }
                }

                const expanded = this.expandNodePreservingTemplates(item, context);
                if (expanded !== null && expanded !== undefined) {
                    if (
                        typeof expanded === 'object' &&
                        !Array.isArray(expanded) &&
                        Object.keys(expanded).length === 0
                    ) {
                        i++;
                        continue;
                    }
                    result.push(expanded);
                }
                i++;
            }
            return result;
        }

        if (typeof node === 'object') {
            if (this.isTemplateReference(node)) {
                const result = { template: node.template };
                if (node.parameters) {
                    result.parameters = this.expandNodePreservingTemplates(node.parameters, context);
                }
                return result;
            }

            const result = {};
            const entries = Object.entries(node);
            let i = 0;

            while (i < entries.length) {
                const [key, value] = entries[i];

                if (this.isConditionalDirective(key)) {
                    let branchTaken = false;
                    let j = i;

                    while (j < entries.length) {
                        const [condKey, condBody] = entries[j];
                        if (!this.isConditionalDirective(condKey)) {
                            break;
                        }

                        if (!branchTaken && this.evaluateConditional(condKey, context)) {
                            const expanded = this.expandNodePreservingTemplates(condBody, context);
                            if (expanded && typeof expanded === 'object' && !Array.isArray(expanded)) {
                                Object.assign(result, expanded);
                            }
                            branchTaken = true;
                        }

                        j++;
                        if (this.isElseDirective(condKey)) break;
                    }
                    i = j;
                    continue;
                }

                // Handle ${{ insert }} directive
                if (this.isInsertDirective(key)) {
                    const expandedValue = this.expandNodePreservingTemplates(value, context);
                    if (expandedValue && typeof expandedValue === 'object' && !Array.isArray(expandedValue)) {
                        Object.assign(result, expandedValue);
                    }
                    i++;
                    continue;
                }

                const expandedKey = typeof key === 'string' ? this.replaceExpressionsInString(key, context) : key;
                result[expandedKey] = this.expandNodePreservingTemplates(value, context);
                i++;
            }
            return result;
        }

        return this.expandScalar(node, context);
    }

    normalizeTemplateParameters(parametersNode, context) {
        if (parametersNode === undefined) {
            return {};
        }

        // Expand parameters but preserve template references for later expansion
        const evaluated = this.expandNodePreservingTemplates(parametersNode, context);

        if (evaluated && typeof evaluated === 'object' && !Array.isArray(evaluated)) {
            return evaluated;
        } else {
            return this._normalizeParameterArray(evaluated);
        }
    }

    _normalizeParameterArray(paramArray) {
        const result = {};
        paramArray.forEach((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return;

            if (Object.prototype.hasOwnProperty.call(item, 'name')) {
                const key = item.name;
                if (typeof key === 'string' && key.trim().length) {
                    const value = this.pickFirstDefined(item.value, item.default, item.values);
                    result[key.trim()] = value;
                }
                return;
            }

            Object.entries(item).forEach(([key, value]) => {
                if (typeof key === 'string' && key.trim().length) {
                    result[key.trim()] = value;
                }
            });
        });
        return result;
    }

    extractTemplateBody(expandedTemplate) {
        if (!expandedTemplate || typeof expandedTemplate !== 'object') {
            return [];
        }

        if (Array.isArray(expandedTemplate)) {
            return expandedTemplate;
        }

        const sanitized = Object.fromEntries(Object.entries(expandedTemplate).filter(([key]) => key !== 'parameters'));

        const candidates = ['stages', 'jobs', 'steps', 'variables', 'stage', 'job', 'deployment', 'deployments'];
        for (const key of candidates) {
            if (key in sanitized) {
                const value = sanitized[key];
                if (Array.isArray(value)) {
                    return value;
                }
                if (value !== undefined) {
                    return [value];
                }
            }
        }

        return Object.keys(sanitized).length > 0 ? [sanitized] : [];
    }

    /**
     * Check if an array looks like a variables array.
     * @param {array} arr - Array to check
     * @returns {boolean}
     */
    isVariableArray(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        // Check if items look like variable definitions
        return arr.some(
            (item) =>
                item &&
                typeof item === 'object' &&
                !Array.isArray(item) &&
                (('name' in item && ('value' in item || 'default' in item)) ||
                    (Object.keys(item).length === 1 && !('template' in item)))
        );
    }

    /**
     * Normalize a variable array, converting any shorthand formats to full format.
     * @param {array} variables - Variable array to normalize
     * @param {object} context - Expansion context for quote tracking
     * @returns {array} Normalized array
     */
    normalizeVariableArray(variables, context) {
        const quoteStyles = context?.quoteResult?.quoteStyles;

        return variables.map((item, index) => {
            console.log(`[DEBUG normalizeVariableArray] Processing item ${index}:`, JSON.stringify(item));

            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return item;
            }

            // Already in array format
            if ('name' in item && ('value' in item || 'default' in item)) {
                console.log(`[DEBUG normalizeVariableArray] Item ${index} already in array format`);
                return item;
            }

            // Template reference - don't convert
            if ('template' in item) {
                return item;
            }

            // Object format (shorthand) - convert to array format
            // { varName: value } => { name: 'varName', value: value }
            const entries = Object.entries(item);
            if (entries.length === 1) {
                const [name, value] = entries[0];

                // Transfer quote style from old path to new path
                if (quoteStyles && typeof value === 'string') {
                    // Before conversion: variables.0.varName:value
                    // After conversion: variables.0.value:value
                    const oldKey = this.getQuoteStyleUniqueKey(['variables', index, name], value);
                    const quoteStyle = quoteStyles.get(oldKey);
                    console.log(`[DEBUG normalizeVariableArray] index=${index}, name=${name}, value='${value}'`);
                    console.log(`[DEBUG normalizeVariableArray] oldKey=${oldKey}, quoteStyle=${quoteStyle}`);
                    if (quoteStyle) {
                        const newKey = this.getQuoteStyleUniqueKey(['variables', index, 'value'], value);
                        console.log(`[DEBUG normalizeVariableArray] Setting newKey=${newKey} to ${quoteStyle}`);
                        quoteStyles.set(newKey, quoteStyle);
                    }
                }

                return { name, value };
            }

            return item;
        });
    }

    /** Evaluates a conditional directive key and returns true if the branch should execute. */
    evaluateConditional(condKey, context) {
        if (this.isElseDirective(condKey)) {
            return true;
        }
        const condition = this.isIfDirective(condKey)
            ? this.parseIfCondition(condKey)
            : this.parseElseIfCondition(condKey);
        return this.toBoolean(this.evaluateExpression(condition, context));
    }

    isFullExpression(text) {
        if (typeof text !== 'string') return false;
        const trimmed = text.trim();
        if (!trimmed.startsWith('${{') || !trimmed.endsWith('}}')) {
            return false;
        }
        const withoutOuter = trimmed.slice(3, -2);
        return !withoutOuter.includes('}}');
    }

    stripExpressionDelimiters(expr) {
        if (typeof expr !== 'string') {
            return '';
        }
        const trimmed = expr.trim();
        return trimmed
            .replace(/^\$\{\{/, '')
            .replace(/\}\}$/, '')
            .trim();
    }

    isInsertDirective(text) {
        const trimmed = text.trim();
        if (this.isFullExpression(trimmed)) {
            return typeof text === 'string' && /^\$\{\{\s*insert\s*\}\}$/.test(trimmed);
        }
        return false;
    }

    isEachDirective(text) {
        return typeof text === 'string' && /^\$\{\{\s*each\s+/.test(text.trim());
    }

    isConditionalDirective(text) {
        return this.isIfDirective(text) || this.isElseIfDirective(text) || this.isElseDirective(text);
    }

    isIfDirective(text) {
        return typeof text === 'string' && /^\$\{\{\s*if\s+/.test(text.trim());
    }

    isElseIfDirective(text) {
        return typeof text === 'string' && /^\$\{\{\s*elseif\s+/.test(text.trim());
    }

    isElseDirective(text) {
        return typeof text === 'string' && /^\$\{\{\s*else\s*\}\}$/.test(text.trim());
    }

    isParameter(text) {
        return typeof text === 'string' && /^\$\{\{\s*parameters\./.test(text.trim());
    }

    isVariable(text) {
        return typeof text === 'string' && /^\$\{\{\s*variables\./.test(text.trim());
    }

    parseIfCondition(text) {
        if (typeof text !== 'string') {
            return '';
        }
        const t = text.trim();
        const match = t.match(/^\$\{\{\s*if\s+(.+?)\s*\}\}$/);
        return match ? match[1] : '';
    }

    parseElseIfCondition(text) {
        if (typeof text !== 'string') {
            return '';
        }
        const t = text.trim();
        const match = t.match(/^\$\{\{\s*elseif\s+(.+?)\s*\}\}$/);
        return match ? match[1] : '';
    }

    parseEachDirective(text) {
        if (typeof text !== 'string') {
            return undefined;
        }
        const t = text.trim();
        const match = t.match(/^\$\{\{\s*each\s+([a-zA-Z_]\w*)\s+in\s+(.+?)\s*\}\}$/);
        if (!match) {
            return undefined;
        }
        return { variable: match[1], collection: match[2] };
    }

    pickFirstDefined(...values) {
        for (const value of values) {
            if (value !== undefined) {
                return value;
            }
        }
        return undefined;
    }
}

module.exports = {
    AzurePipelineParser,
};

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        console.error('Usage: node parser.js <yaml-file-path>');
        process.exit(1);
    }

    const filePath = argv[0];
    const parserInstance = new AzurePipelineParser({ printTree: false });

    try {
        const expanded = parserInstance.expandPipelineFromFile(filePath);
        process.stdout.write(expanded);
    } catch (error) {
        console.error(`Failed to expand pipeline: ${error.message}`);
        process.exit(1);
    }
}
