const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const antlr4 = require('antlr4');
const jsep = require('jsep');
const adoYamlLexer = require('./generated-cjs/AzurePipelineLexer').default;
const adoYamlParser = require('./generated-cjs/AzurePipelineParser').default;

class CollectingErrorListener {
    constructor() {
        this.errors = [];
    }

    syntaxError(recognizer, offendingSymbol, line, column, msg) {
        this.errors.push({
            line,
            column,
            message: msg,
            symbol: offendingSymbol && offendingSymbol.text ? offendingSymbol.text : undefined,
        });
    }

    reportAmbiguity() {}

    reportAttemptingFullContext() {}

    reportContextSensitivity() {}
}

class PipelineConfig {
    constructor() {
        this.name = '';
        this.trigger = {};
        this.parameters = [];
        this.variables = [];
        this.resources = {};
        this.stages = [];
        this.jobs = [];
        this.steps = [];
        this.extends = {};
        this.expressions = [];
        this.ranges = [];
        this.syntaxErrors = 0;
        this.lexerErrors = 0;
        this.syntaxErrorDetails = [];
        this.lexerErrorDetails = [];
        this.hasErrors = false;
    }
}

class Range {
    constructor(startLine, startCol, endLine, endCol) {
        this.startLine = startLine;
        this.startCol = startCol;
        this.endLine = endLine;
        this.endCol = endCol;
    }
}

class AzurePipelineParser {
    constructor(options = {}) {
        this.printTree = !!options.printTree;
        this.expressionCache = new Map();
    }

    parseFile(filePath) {
        const input = fs.readFileSync(filePath, 'utf8');
        return this.parseString(input, filePath);
    }

    parseString(input, fileName = 'inline') {
        const pipelineInfo = new PipelineConfig();
        pipelineInfo.fileName = fileName;

        const chars = new antlr4.InputStream(input);
        const lexer = new adoYamlLexer(chars);
        const lexerErrorListener = new CollectingErrorListener();
        lexer.removeErrorListeners();
        lexer.addErrorListener(lexerErrorListener);
        const tokens = new antlr4.CommonTokenStream(lexer);
        const parser = new adoYamlParser(tokens);
        const parserErrorListener = new CollectingErrorListener();
        parser.removeErrorListeners();
        parser.addErrorListener(parserErrorListener);
        parser.buildParseTrees = true;
        const tree = parser.yamlFile();

        if (this.printTree) {
            console.log(tree.toStringTree(parser.ruleNames));
        }

        this.traverse(pipelineInfo, parser, tree, pipelineInfo, pipelineInfo.ranges, null);

        pipelineInfo.syntaxErrors = parserErrorListener.errors.length;
        pipelineInfo.lexerErrors = lexerErrorListener.errors.length;
        pipelineInfo.syntaxErrorDetails = parserErrorListener.errors;
        pipelineInfo.lexerErrorDetails = lexerErrorListener.errors;
        pipelineInfo.hasErrors = pipelineInfo.syntaxErrors > 0 || pipelineInfo.lexerErrors > 0;

        return pipelineInfo;
    }

    traverse(pipelineInfo, parser, node, configs, ranges, parent) {
        if (!node) {
            return;
        }

        const ruleName = parser.ruleNames[node.ruleIndex] || 'unknown';

        if (node.start && node.stop) {
            const range = new Range(node.start.line, node.start.column, node.stop.line, node.stop.column);
            ranges.push(range);
        }

        switch (ruleName) {
            case 'keyValue':
                this.handleKeyValue(pipelineInfo, node, configs);
                break;
            case 'listItem':
                this.handleListItem(pipelineInfo, node, configs);
                break;
            case 'value':
                this.handleValue(pipelineInfo, node, configs, parent);
                break;
            default:
                break;
        }

        if (node.children) {
            for (const child of node.children) {
                this.traverse(pipelineInfo, parser, child, configs, ranges, node);
            }
        }
    }

    handleKeyValue(pipelineInfo, node, configs) {
        if (!node.children || node.children.length < 3) {
            return;
        }

        const keyNode = node.children[0];
        const valueNode = node.children[2];

        if (keyNode && valueNode) {
            const key = keyNode.getText();
            const value = valueNode.getText();

            switch (key) {
                case 'name':
                    configs.name = value;
                    break;
                case 'trigger':
                    configs.trigger = this.extractNestedConfig(valueNode);
                    break;
                case 'parameters':
                    configs.parameters = this.extractListConfig(valueNode);
                    break;
                case 'variables':
                    configs.variables = this.extractListConfig(valueNode);
                    break;
                case 'stages':
                    configs.stages = this.extractListConfig(valueNode);
                    break;
                case 'jobs':
                    configs.jobs = this.extractListConfig(valueNode);
                    break;
                case 'steps':
                    configs.steps = this.extractListConfig(valueNode);
                    break;
                case 'extends':
                    configs.extends = this.extractNestedConfig(valueNode);
                    break;
                case 'resources':
                    configs.resources = this.extractNestedConfig(valueNode);
                    break;
                default:
                    break;
            }

            if (this.isExpression(value)) {
                configs.expressions.push({
                    key,
                    value,
                    type: this.getExpressionType(value),
                    functions: this.extractFunctions(value),
                    line: node.start ? node.start.line : 0,
                });
            }
        }
    }

    handleListItem(pipelineInfo, node, configs) {
        if (node.children && node.children.length > 1) {
            const itemContent = node.children[1];
            if (itemContent) {
                const itemValue = itemContent.getText();
                if (this.isExpression(itemValue)) {
                    configs.expressions.push({
                        type: this.getExpressionType(itemValue),
                        value: itemValue,
                        functions: this.extractFunctions(itemValue),
                        line: node.start ? node.start.line : 0,
                    });
                }
            }
        }
    }

    handleValue(pipelineInfo, node, configs) {
        const value = node.getText();
        if (this.isExpression(value)) {
            configs.expressions.push({
                type: this.getExpressionType(value),
                value,
                functions: this.extractFunctions(value),
                line: node.start ? node.start.line : 0,
            });
        }
    }

    isExpression(text) {
        if (!text || typeof text !== 'string') {
            return false;
        }
        return text.includes('${{') || text.includes('$[') || text.includes('$(');
    }

    getExpressionType(text) {
        if (text.includes('${{')) {
            return 'compile-time';
        }
        if (text.includes('$[')) {
            return 'runtime';
        }
        if (text.includes('$(')) {
            return 'variable';
        }
        return 'unknown';
    }

    extractFunctions(text) {
        const functions = [];
        const functionPattern = /([a-zA-Z_]\w*)\s*\(/g;
        let match;
        while ((match = functionPattern.exec(text)) !== null) {
            functions.push(match[1]);
        }
        return functions;
    }

    extractNestedConfig(node) {
        if (node.children) {
            return { raw: node.getText() };
        }
        return {};
    }

    extractListConfig(node) {
        if (node.children) {
            return [{ raw: node.getText() }];
        }
        return [];
    }

    expandPipelineFromFile(filePath, overrides = {}) {
        const input = fs.readFileSync(filePath, 'utf8');
        const baseDir = path.dirname(filePath);
        return this.expandPipelineToString(input, { ...overrides, fileName: filePath, baseDir });
    }

    expandPipelineToString(sourceText, overrides = {}) {
        const { document } = this.expandPipeline(sourceText, overrides);
        return YAML.stringify(document, { lineWidth: 0 });
    }

    expandPipeline(sourceText, overrides = {}) {
        const normalized = this.preprocessCompileTimeExpressions(sourceText);

        let document;
        try {
            document = YAML.parse(normalized) || {};
        } catch (error) {
            throw new Error(`Failed to parse YAML: ${error.message}`);
        }

        document = this.restoreCompileTimeExpressions(document);

        const context = this.buildExecutionContext(document, overrides);
        const expandedDocument = this.expandNode(document, context);

        return {
            document: expandedDocument,
            context,
        };
    }

    preprocessCompileTimeExpressions(sourceText) {
        if (typeof sourceText !== 'string' || sourceText.length === 0) {
            return sourceText;
        }

        return sourceText.replace(/\$\{\{([\s\S]*?)\}\}/g, (match) =>
            match.replace(/\$\{\{/g, '__AZURE_EXPR_OPEN__').replace(/\}\}/g, '__AZURE_EXPR_CLOSE__'),
        );
    }

    restoreCompileTimeExpressions(node) {
        if (typeof node === 'string') {
            return node.replace(/__AZURE_EXPR_OPEN__/g, '${{').replace(/__AZURE_EXPR_CLOSE__/g, '}}');
        }

        if (Array.isArray(node)) {
            return node.map((item) => this.restoreCompileTimeExpressions(item));
        }

        if (node && typeof node === 'object') {
            const restored = {};
            for (const [key, value] of Object.entries(node)) {
                const restoredKey = this.restoreCompileTimeExpressions(key);
                restored[restoredKey] = this.restoreCompileTimeExpressions(value);
            }
            return restored;
        }

        return node;
    }

    buildExecutionContext(document, overrides) {
        const parameters = this.extractParameters(document);
        const variables = this.extractVariables(document);
        const resources = this.normalizeResourcesConfig(
            document && typeof document === 'object' ? document.resources : undefined,
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
            variables: { ...variables, ...overrideVariables },
            resources: mergedResources,
            locals: { ...locals },
            baseDir,
            repositoryBaseDir,
            resourceLocations,
        };
    }

    normalizeResourcesConfig(resourcesNode) {
        if (!resourcesNode || typeof resourcesNode !== 'object') {
            return {};
        }

        const normalized = {};

        if (resourcesNode.repositories !== undefined) {
            normalized.repositories = this.normalizeRepositoryList(resourcesNode.repositories);
        }

        for (const [key, value] of Object.entries(resourcesNode)) {
            if (key === 'repositories') {
                continue;
            }
            normalized[key] = this.cloneResourceValue(value);
        }

        return normalized;
    }

    mergeResourcesConfig(baseResources = {}, overrideResources = {}) {
        const merged = {};

        for (const [key, value] of Object.entries(baseResources)) {
            if (key === 'repositories') {
                continue;
            }
            merged[key] = this.cloneResourceValue(value);
        }

        merged.repositories = this.mergeRepositoryConfigs(baseResources.repositories, overrideResources.repositories);

        for (const [key, value] of Object.entries(overrideResources)) {
            if (key === 'repositories') {
                continue;
            }
            merged[key] = this.cloneResourceValue(value);
        }

        return merged;
    }

    normalizeRepositoryList(value) {
        if (!value) {
            return [];
        }

        const list = [];

        if (Array.isArray(value)) {
            value.forEach((entry) => {
                if (entry && typeof entry === 'object') {
                    list.push(this.cloneResourceEntry(entry));
                }
            });
        } else if (typeof value === 'object') {
            for (const [key, entry] of Object.entries(value)) {
                if (!entry || typeof entry !== 'object') {
                    continue;
                }
                const cloned = this.cloneResourceEntry(entry);
                if (!cloned.repository && key) {
                    cloned.repository = key;
                }
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
            if (!entry || typeof entry !== 'object') {
                return;
            }

            const clone = this.cloneResourceEntry(entry);
            const matchCriteria = clone.__match && typeof clone.__match === 'object' ? clone.__match : undefined;
            if (matchCriteria) {
                delete clone.__match;
            }

            const alias = this.getRepositoryAlias(clone);
            const key = alias && !this.isNumericString(alias) ? alias : `__index_${mergedOrder.length}`;

            if (!clone.repository && alias && !this.isNumericString(alias)) {
                clone.repository = alias;
            }

            const existing = mergedMap.get(key);

            if (
                source === 'override' &&
                existing &&
                matchCriteria &&
                !this.repositoryMatchesCriteria(existing, matchCriteria)
            ) {
                return;
            }

            if (source === 'override' && clone.location && existing && !existing.location) {
                existing.location = clone.location;
            }

            if (existing) {
                mergedMap.set(key, { ...existing, ...clone });
            } else {
                mergedMap.set(key, clone);
                mergedOrder.push(key);
            }
        };

        baseList.forEach((entry) => addEntry(entry, 'base'));
        overrideList.forEach((entry) => addEntry(entry, 'override'));

        const mergedList = mergedOrder.map((key) => this.cloneResourceEntry(mergedMap.get(key)));
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

    cloneResourceEntry(entry) {
        if (!entry || typeof entry !== 'object') {
            return entry;
        }
        return JSON.parse(JSON.stringify(entry));
    }

    cloneResourceValue(value) {
        if (value === undefined) {
            return undefined;
        }
        return JSON.parse(JSON.stringify(value));
    }

    isNumericString(value) {
        return typeof value === 'string' && /^\d+$/.test(value);
    }

    extractParameters(document) {
        const result = {};
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
                    const value = this.pickFirstDefined(param.value, param.default, param.values);
                    result[param.name] = value !== undefined ? value : null;
                }
            }
        } else if (typeof parameters === 'object') {
            for (const [name, param] of Object.entries(parameters)) {
                if (param && typeof param === 'object') {
                    const value = this.pickFirstDefined(param.value, param.default, param.values);
                    result[name] = value !== undefined ? value : null;
                } else {
                    result[name] = param;
                }
            }
        }

        return result;
    }

    validateTemplateParameters(templateDocument, providedParameters, templatePath) {
        if (!templateDocument || typeof templateDocument !== 'object') {
            return;
        }

        const { parameters } = templateDocument;
        if (!parameters) {
            return;
        }

        const missingRequired = [];

        const checkParameter = (param, paramName) => {
            if (!param || typeof param !== 'object') {
                return;
            }

            const name = paramName || param.name;
            if (!name) {
                return;
            }

            // Check if parameter has a default value
            const hasDefault = param.default !== undefined || param.value !== undefined || param.values !== undefined;

            // Check if parameter was provided
            const wasProvided = providedParameters && Object.prototype.hasOwnProperty.call(providedParameters, name);

            // If no default and not provided, it's missing
            if (!hasDefault && !wasProvided) {
                missingRequired.push(name);
            }
        };

        if (Array.isArray(parameters)) {
            for (const param of parameters) {
                checkParameter(param);
            }
        } else if (typeof parameters === 'object') {
            for (const [name, param] of Object.entries(parameters)) {
                checkParameter(param, name);
            }
        }

        if (missingRequired.length > 0) {
            const templateName = templatePath || 'template';
            const paramList = missingRequired.map((p) => `'${p}'`).join(', ');
            throw new Error(
                `Missing required parameter(s) for template '${templateName}': ${paramList}. ` +
                    `These parameters do not have default values and must be provided when calling the template.`,
            );
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

    expandNode(node, context) {
        if (Array.isArray(node)) {
            return this.expandArray(node, context);
        }
        if (node && typeof node === 'object') {
            return this.expandObject(node, context);
        }
        return this.expandScalar(node, context);
    }

    expandArray(array, context) {
        const result = [];
        for (let index = 0; index < array.length; index += 1) {
            const element = array[index];

            if (process.env.ADO_YAML_DEBUG && typeof element === 'object' && element !== null) {
                const keys = Object.keys(element);
                if (keys.length > 0 && keys[0].includes('if') && keys[0].includes('parameters')) {
                    console.log('[debug] Array element with conditional-like key:', keys[0].substring(0, 100));
                    console.log('[debug] isConditionalDirective:', this.isConditionalDirective(keys[0]));
                }
            }

            if (this.isTemplateReference(element)) {
                const templateItems = this.expandTemplateReference(element, context);
                result.push(...templateItems);
                continue;
            }

            if (this.isSingleKeyObject(element)) {
                const key = Object.keys(element)[0];

                if (process.env.ADO_YAML_DEBUG && this.isConditionalDirective(key)) {
                    console.log('[debug] Processing conditional in array, key length:', key.length);
                }

                if (this.isEachDirective(key)) {
                    const applied = this.applyEachDirective(key, element[key], context);
                    result.push(...applied.items);
                    continue;
                }

                if (this.isConditionalDirective(key)) {
                    const expanded = this.expandConditionalBlock(array, index, context);
                    result.push(...expanded.items);
                    index = expanded.nextIndex;
                    continue;
                }
            }

            const expandedElement = this.expandNode(element, context);
            if (expandedElement === undefined) {
                continue;
            }

            if (Array.isArray(expandedElement)) {
                if (process.env.DEBUG_PARSER && expandedElement.length > 0) {
                    console.log('[debug] Expanded array element, checking', expandedElement.length, 'items');
                    console.log(
                        '[debug] First item type:',
                        typeof expandedElement[0],
                        'isTemplate:',
                        this.isTemplateReference(expandedElement[0]),
                    );
                    if (typeof expandedElement[0] === 'object' && expandedElement[0] !== null) {
                        console.log('[debug] First item keys:', Object.keys(expandedElement[0]));
                    }
                }
                // Recursively expand any template references in the expanded array
                for (const item of expandedElement) {
                    if (this.isTemplateReference(item)) {
                        if (process.env.DEBUG_PARSER) {
                            console.log('[debug] Found template reference in expanded array:', item.template);
                        }
                        const templateItems = this.expandTemplateReference(item, context);
                        result.push(...templateItems);
                    } else {
                        result.push(item);
                    }
                }
            } else {
                result.push(expandedElement);
            }
        }
        return result;
    }

    expandObject(object, context) {
        const entries = Object.entries(object);
        const result = {};

        if (process.env.DEBUG_PARSER && entries.length < 20) {
            const keys = entries.map(([k]) => (typeof k === 'string' ? k.substring(0, 40) : k));
            if (keys.some((k) => typeof k === 'string' && k.includes('{{') && k.length < 30)) {
                console.log(
                    '[debug] expandObject keys with {{:',
                    JSON.stringify(keys.filter((k) => typeof k === 'string' && k.includes('{{'))),
                );
            }
        }

        for (let index = 0; index < entries.length; index += 1) {
            const [rawKey, value] = entries[index];

            if (
                process.env.DEBUG_PARSER &&
                typeof rawKey === 'string' &&
                (rawKey.includes('insert') || rawKey.includes('AZURE'))
            ) {
                console.log('[debug] expandObject rawKey:', JSON.stringify(rawKey));
            }

            if (typeof rawKey === 'string' && this.isEachDirective(rawKey)) {
                const eachResult = this.expandEachEntries(entries, index, context);
                Object.assign(result, eachResult.merged);
                index = eachResult.nextIndex;
                continue;
            }

            if (typeof rawKey === 'string' && this.isConditionalDirective(rawKey)) {
                const conditional = this.expandConditionalEntries(entries, index, context);
                Object.assign(result, conditional.merged);
                index = conditional.nextIndex;
                continue;
            }

            // Handle ${{ insert }} directive to merge object properties
            if (typeof rawKey === 'string' && this.isFullExpression(rawKey.trim())) {
                const expr = this.stripExpressionDelimiters(rawKey.trim());
                if (process.env.DEBUG_PARSER) {
                    console.log('[debug] Full expression key - rawKey:', rawKey, 'expr:', expr.substring(0, 50));
                }
                if (expr.trim() === 'insert') {
                    // Use expandNodePreservingTemplates to avoid expanding template references prematurely
                    const expandedValue = this.expandNodePreservingTemplates(value, context);
                    if (process.env.DEBUG_PARSER) {
                        console.log('[debug] Insert directive: merging', Object.keys(expandedValue || {}));
                        if (expandedValue && expandedValue.preSteps) {
                            console.log(
                                '[debug] Insert: preSteps is array:',
                                Array.isArray(expandedValue.preSteps),
                                'length:',
                                expandedValue.preSteps.length,
                            );
                        }
                    }
                    if (expandedValue && typeof expandedValue === 'object' && !Array.isArray(expandedValue)) {
                        Object.assign(result, expandedValue);
                        continue;
                    }
                }
            }

            const key = typeof rawKey === 'string' ? this.replaceExpressionsInString(rawKey, context) : rawKey;

            if (process.env.DEBUG_PARSER && typeof rawKey === 'string' && rawKey.includes('insert')) {
                console.log('[debug] Key contains insert - rawKey:', rawKey, 'expanded:', key);
            }

            const expandedValue = this.expandNode(value, context);
            if (expandedValue === undefined) {
                continue;
            }

            result[key] = expandedValue;
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
            if (process.env.DEBUG_PARSER && expr.includes('preSteps')) {
                console.log('[debug] expandScalar preSteps expression:', expr);
                console.log(
                    '[debug] result type:',
                    typeof result,
                    'isArray:',
                    Array.isArray(result),
                    'length:',
                    result ? result.length : 'N/A',
                );
                if (Array.isArray(result)) {
                    for (let i = 0; i < Math.min(2, result.length); i++) {
                        console.log(
                            `[debug] result[${i}] type:`,
                            typeof result[i],
                            'isTemplate:',
                            result[i] && typeof result[i] === 'object' && 'template' in result[i],
                        );
                        if (result[i] && typeof result[i] === 'object') {
                            console.log(`[debug] result[${i}] keys:`, Object.keys(result[i]));
                        }
                    }
                }
            }
            // If the expression evaluates to a template reference, expand it
            if (this.isTemplateReference(result)) {
                if (process.env.DEBUG_PARSER) {
                    console.log('[debug] expandScalar: expression resolved to template reference:', result.template);
                }
                // Template references in array context should be expanded and their items spread
                // Return the template reference as-is and let the caller handle expansion
                // Actually, we need to expand it here since we're in scalar context
                const expanded = this.expandTemplateReference(result, context);
                if (process.env.DEBUG_PARSER) {
                    console.log('[debug] expandScalar: expanded template to', expanded.length, 'items');
                }
                // If we're in a scalar position but got multiple items, return them as array
                // The caller (expandArray) will handle spreading them
                return expanded.length === 1 ? expanded[0] : expanded;
            }
            return result;
        }

        return this.replaceExpressionsInString(value, context);
    }

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

            if (this.isIfDirective(key)) {
                // Only process this IF if we haven't taken a branch yet, OR if this is the first condition
                // This allows multiple independent IF conditions, but respects IF-ELSEIF-ELSE chains
                if (index !== startIndex && !this.isElseIfDirective(key) && !this.isElseDirective(key)) {
                    // This is a new independent IF, not part of the current IF-ELSEIF-ELSE chain
                    break;
                }

                const condition = this.parseIfCondition(key);
                const result = this.evaluateExpression(condition, context);
                if (process.env.ADO_YAML_DEBUG === '1') {
                    console.log('[debug] IF condition:', condition, '=>', result);
                    console.log('[debug] branchTaken:', branchTaken, ', toBoolean(result):', this.toBoolean(result));
                    if (result) {
                        console.log('[debug] Branch body type:', Array.isArray(body) ? 'array' : typeof body);
                        if (Array.isArray(body)) {
                            console.log('[debug] Branch body length:', body.length);
                            if (body.length > 0) {
                                console.log('[debug] First item:', JSON.stringify(body[0]).substring(0, 200));
                            }
                        }
                    }
                }
                if (!branchTaken && this.toBoolean(result)) {
                    items = this.flattenBranchValue(body, context);
                    branchTaken = true;
                    if (process.env.ADO_YAML_DEBUG === '1') {
                        console.log('[debug] Branch taken, returned', items.length, 'items');
                        if (items.length > 0 && items[0]) {
                            console.log('[debug] First returned item type:', typeof items[0]);
                            if (typeof items[0] === 'object' && items[0] !== null) {
                                console.log('[debug] First returned item keys:', Object.keys(items[0]).slice(0, 5));
                            }
                        }
                    }
                }
            } else if (this.isElseIfDirective(key)) {
                const condition = this.parseElseIfCondition(key);
                const result = this.evaluateExpression(condition, context);
                if (process.env.ADO_YAML_DEBUG === '1') {
                    console.log('[debug] ELSEIF condition:', condition, '=>', result);
                }
                if (!branchTaken && this.toBoolean(result)) {
                    items = this.flattenBranchValue(body, context);
                    branchTaken = true;
                }
            } else if (this.isElseDirective(key)) {
                if (process.env.ADO_YAML_DEBUG === '1') {
                    console.log('[debug] ELSE clause');
                }
                if (!branchTaken) {
                    items = this.flattenBranchValue(body, context);
                    branchTaken = true;
                }
                index += 1;
                break;
            } else {
                break;
            }

            index += 1;
        }

        return {
            items,
            nextIndex: index - 1,
        };
    }

    expandConditionalEntries(entries, startIndex, context) {
        let index = startIndex;
        let branchTaken = false;
        let merged = {};

        while (index < entries.length) {
            const [key, body] = entries[index];
            if (typeof key !== 'string' || !this.isConditionalDirective(key)) {
                break;
            }

            if (this.isIfDirective(key)) {
                const condition = this.parseIfCondition(key);
                const result = this.evaluateExpression(condition, context);
                if (process.env.ADO_YAML_DEBUG === '1') {
                    console.log('[debug] IF (object) condition:', condition, '=>', result);
                }
                if (!branchTaken && this.toBoolean(result)) {
                    merged = this.expandConditionalMappingBranch(body, context);
                    branchTaken = true;
                }
            } else if (this.isElseIfDirective(key)) {
                const condition = this.parseElseIfCondition(key);
                const result = this.evaluateExpression(condition, context);
                if (process.env.ADO_YAML_DEBUG === '1') {
                    console.log('[debug] ELSEIF (object) condition:', condition, '=>', result);
                }
                if (!branchTaken && this.toBoolean(result)) {
                    merged = this.expandConditionalMappingBranch(body, context);
                    branchTaken = true;
                }
            } else if (this.isElseDirective(key)) {
                if (process.env.ADO_YAML_DEBUG === '1') {
                    console.log('[debug] ELSE (object) clause');
                }
                if (!branchTaken) {
                    merged = this.expandConditionalMappingBranch(body, context);
                    branchTaken = true;
                }
                index += 1;
                break;
            }

            index += 1;
        }

        return {
            merged,
            nextIndex: Math.max(startIndex, index - 1),
        };
    }

    expandConditionalMappingBranch(body, context) {
        if (Array.isArray(body)) {
            const expandedArray = this.expandArray(body, context);
            return expandedArray.reduce((acc, item) => {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    return { ...acc, ...item };
                }
                return acc;
            }, {});
        }

        if (body && typeof body === 'object') {
            return this.expandObject(body, context);
        }

        const scalar = this.expandScalar(body, context);
        if (scalar === undefined) {
            return {};
        }

        return { value: scalar };
    }

    expandEachEntries(entries, startIndex, context) {
        let index = startIndex;
        const merged = {};

        while (index < entries.length) {
            const [key, body] = entries[index];
            if (typeof key !== 'string' || !this.isEachDirective(key)) {
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

        return input.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (match, expr) => {
            const value = this.evaluateExpression(expr, context);
            if (value === undefined || value === null) {
                return '';
            }
            if (typeof value === 'object') {
                return JSON.stringify(value);
            }
            return String(value);
        });
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
        const fn = name.toLowerCase();
        switch (fn) {
            // Comparison functions
            case 'eq':
                const result = this.compareValues(args[0], args[1]) === 0;
                if (process.env.ADO_YAML_DEBUG === '1') {
                    console.log('[debug] eq(', args[0], ',', args[1], ') =>', result);
                }
                return result;
            case 'ne':
                return this.compareValues(args[0], args[1]) !== 0;
            case 'gt':
                return this.compareValues(args[0], args[1]) > 0;
            case 'ge':
                return this.compareValues(args[0], args[1]) >= 0;
            case 'lt':
                return this.compareValues(args[0], args[1]) < 0;
            case 'le':
                return this.compareValues(args[0], args[1]) <= 0;

            // Logical functions
            case 'and':
                return args.every((arg) => this.toBoolean(arg));
            case 'or':
                return args.some((arg) => this.toBoolean(arg));
            case 'not':
                return !this.toBoolean(args[0]);
            case 'xor':
                return this.toBoolean(args[0]) !== this.toBoolean(args[1]);

            // Containment functions
            case 'coalesce':
                return args.find((arg) => arg !== undefined && arg !== null && arg !== '');
            case 'contains':
                return this.contains(args[0], args[1]);
            case 'containsvalue':
                return this.containsValue(args[0], args[1]);
            case 'in':
                return args.slice(1).some((candidate) => this.compareValues(args[0], candidate) === 0);
            case 'notin':
                return !args.slice(1).some((candidate) => this.compareValues(args[0], candidate) === 0);

            // String functions
            case 'lower':
                return typeof args[0] === 'string' ? args[0].toLowerCase() : args[0];
            case 'upper':
                return typeof args[0] === 'string' ? args[0].toUpperCase() : args[0];
            case 'startswith':
                return this.startsWith(args[0], args[1]);
            case 'endswith':
                return this.endsWith(args[0], args[1]);
            case 'trim':
                return typeof args[0] === 'string' ? args[0].trim() : args[0];
            case 'replace':
                return this.replaceString(args[0], args[1], args[2]);
            case 'split':
                return this.splitString(args[0], args[1]);
            case 'join':
                return this.joinArray(args[0], args[1]);
            case 'format':
                return this.formatString(args);

            // Other functions
            case 'length':
                if (typeof args[0] === 'string' || Array.isArray(args[0])) {
                    return args[0].length;
                }
                if (args[0] && typeof args[0] === 'object') {
                    return Object.keys(args[0]).length;
                }
                return 0;
            case 'converttojson':
                return this.convertToJson(args[0]);
            case 'counter':
                return this.counter(args[0], args[1]);
            case 'iif':
                return this.toBoolean(args[0]) ? args[1] : args[2];

            // Job status check functions
            case 'always':
                return true;
            case 'canceled':
                return this.isCanceled(args);
            case 'failed':
                return this.isFailed(args);
            case 'succeeded':
                return this.isSucceeded(args);
            case 'succeededorfailed':
                return this.isSucceededOrFailed(args);

            default:
                return undefined;
        }
    }

    // Helper functions for string operations
    startsWith(str, prefix) {
        if (typeof str !== 'string' || typeof prefix !== 'string') {
            return false;
        }
        return str.toLowerCase().startsWith(prefix.toLowerCase());
    }

    endsWith(str, suffix) {
        if (typeof str !== 'string' || typeof suffix !== 'string') {
            return false;
        }
        return str.toLowerCase().endsWith(suffix.toLowerCase());
    }

    replaceString(str, search, replacement) {
        if (typeof str !== 'string') {
            return str;
        }
        if (typeof search !== 'string') {
            search = String(search);
        }
        if (typeof replacement !== 'string') {
            replacement = String(replacement);
        }
        return str.split(search).join(replacement);
    }

    splitString(str, delimiter) {
        if (typeof str !== 'string') {
            return [str];
        }
        if (typeof delimiter !== 'string') {
            delimiter = String(delimiter);
        }
        return str.split(delimiter);
    }

    joinArray(separator, array) {
        if (!Array.isArray(array)) {
            return typeof array === 'string' ? array : String(array);
        }
        if (typeof separator !== 'string') {
            separator = String(separator);
        }
        return array
            .map((item) => {
                if (item === null || item === undefined) {
                    return '';
                }
                if (typeof item === 'object') {
                    return '';
                }
                return String(item);
            })
            .join(separator);
    }

    formatString(args) {
        if (args.length === 0) {
            return '';
        }

        let format = String(args[0]);
        const values = args.slice(1);

        // Handle positional placeholders {0}, {1}, etc.
        format = format.replace(/\{(\d+)(?::([^}]+))?\}/g, (match, index, formatSpec) => {
            const idx = parseInt(index, 10);
            if (idx >= values.length) {
                return match;
            }

            let value = values[idx];

            // Handle date/time formatting if formatSpec is provided
            if (formatSpec && value instanceof Date) {
                return this.formatDateTime(value, formatSpec);
            }

            if (value === null || value === undefined) {
                return '';
            }

            return String(value);
        });

        // Handle literal braces {{ and }}
        format = format.replace(/\{\{/g, '{').replace(/\}\}/g, '}');

        return format;
    }

    formatDateTime(date, formatSpec) {
        // Basic date/time format support
        const pad = (num, size = 2) => String(num).padStart(size, '0');

        return formatSpec
            .replace(/yyyy/g, date.getFullYear())
            .replace(/yy/g, String(date.getFullYear()).slice(-2))
            .replace(/MM/g, pad(date.getMonth() + 1))
            .replace(/M/g, date.getMonth() + 1)
            .replace(/dd/g, pad(date.getDate()))
            .replace(/d/g, date.getDate())
            .replace(/HH/g, pad(date.getHours()))
            .replace(/H/g, date.getHours())
            .replace(/mm/g, pad(date.getMinutes()))
            .replace(/m/g, date.getMinutes())
            .replace(/ss/g, pad(date.getSeconds()))
            .replace(/s/g, date.getSeconds())
            .replace(/ffff/g, pad(date.getMilliseconds(), 4))
            .replace(/ff/g, pad(Math.floor(date.getMilliseconds() / 10)))
            .replace(/f/g, Math.floor(date.getMilliseconds() / 100));
    }

    convertToJson(value) {
        if (value === undefined) {
            return 'null';
        }
        try {
            return JSON.stringify(value, null, 2);
        } catch (error) {
            return String(value);
        }
    }

    counter(prefix, seed) {
        // Counter is stateful and would require persistent storage
        // For now, return the seed value or a simple implementation
        if (!this._counters) {
            this._counters = new Map();
        }

        const key = String(prefix || '');
        const seedValue = typeof seed === 'number' ? seed : parseInt(seed, 10) || 0;

        if (!this._counters.has(key)) {
            this._counters.set(key, seedValue);
        }

        const current = this._counters.get(key);
        this._counters.set(key, current + 1);

        return current;
    }

    containsValue(container, value) {
        if (Array.isArray(container)) {
            return container.some((item) => this.compareValues(item, value) === 0);
        }

        if (container && typeof container === 'object') {
            return Object.values(container).some((item) => this.compareValues(item, value) === 0);
        }

        return false;
    }

    // Job status check functions
    isCanceled(args) {
        // In a real pipeline context, this would check if the pipeline was canceled
        // For parsing/expansion purposes, we'll return false
        return false;
    }

    isFailed(args) {
        // In a real pipeline context, this would check job dependencies
        // For parsing/expansion purposes, we'll return false
        return false;
    }

    isSucceeded(args) {
        // In a real pipeline context, this would check job dependencies
        // For parsing/expansion purposes, we'll return true
        return true;
    }

    isSucceededOrFailed(args) {
        // In a real pipeline context, this would check job dependencies
        // For parsing/expansion purposes, we'll return true
        return true;
    }

    parseExpressionAst(expr) {
        if (this.expressionCache.has(expr)) {
            return this.expressionCache.get(expr);
        }

        try {
            const ast = jsep(expr);
            this.expressionCache.set(expr, ast);
            return ast;
        } catch (error) {
            if (process.env.ADO_YAML_DEBUG === '1') {
                console.log('[debug] failed to parse expression:', expr, '-', error.message);
            }
            this.expressionCache.set(expr, null);
            return null;
        }
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
                    this.evaluateAst(node.right, context),
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
                if (callable && callable.builtinName) {
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
        if (lowered === 'true') {
            return true;
        }
        if (lowered === 'false') {
            return false;
        }
        if (lowered === 'null') {
            return null;
        }
        if (lowered === 'undefined') {
            return undefined;
        }

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
                if (lowered === 'true' || lowered === 'false') {
                    return lowered === 'true';
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
            const value = this.walkSegments(context.parameters[first], rest);
            if (process.env.DEBUG_PARSER && first === 'preSteps') {
                console.log(
                    '[debug] resolveContextValue preSteps:',
                    Array.isArray(value),
                    value ? value.length : 'null/undef',
                );
                if (Array.isArray(value) && value.length > 0) {
                    console.log(
                        '[debug] preSteps[0] type:',
                        typeof value[0],
                        'has template:',
                        value[0] && typeof value[0] === 'object' && 'template' in value[0],
                    );
                }
            }
            return value;
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
            if (lowered === 'true') {
                return true;
            }
            if (lowered === 'false' || lowered.length === 0) {
                return false;
            }
        }
        return Boolean(value);
    }

    createChildContext(parent, locals) {
        return {
            parameters: parent.parameters,
            variables: parent.variables,
            resources: parent.resources,
            locals: { ...parent.locals, ...locals },
            baseDir: parent.baseDir,
            repositoryBaseDir: parent.repositoryBaseDir,
            resourceLocations: parent.resourceLocations || {},
        };
    }

    createTemplateContext(parent, parameterOverrides, baseDir, options = {}) {
        return {
            parameters: { ...parent.parameters, ...parameterOverrides },
            variables: parent.variables,
            resources: parent.resources,
            locals: { ...parent.locals },
            baseDir: baseDir || parent.baseDir,
            repositoryBaseDir:
                options.repositoryBaseDir !== undefined ? options.repositoryBaseDir : parent.repositoryBaseDir,
            resourceLocations: parent.resourceLocations || {},
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

    isSingleKeyObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1;
    }

    isTemplateReference(value) {
        return value && typeof value === 'object' && !Array.isArray(value) && 'template' in value;
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

        if (process.env.ADO_YAML_DEBUG === '1') {
            console.log('[debug] expandTemplateReference ->', templatePathValue);
        }

        const repositoryRef = this.parseRepositoryTemplateReference(templatePathValue);

        let resolvedPath;
        let templateBaseDir;
        let repositoryBaseDirectoryForContext = context.repositoryBaseDir || undefined;

        if (repositoryRef) {
            const repositoryEntry = this.resolveRepositoryEntry(repositoryRef.repository, context);
            if (!repositoryEntry) {
                throw new Error(
                    `Repository resource '${repositoryRef.repository}' is not defined for template '${templatePathValue}'.`,
                );
            }

            const repositoryLocation = this.resolveRepositoryLocation(repositoryEntry, context);
            if (!repositoryLocation) {
                throw new Error(
                    `Repository resource '${repositoryRef.repository}' does not define a local location. ` +
                        `Set a 'location' for this resource (for example via the 'azurePipelineStudio.resourceLocations' setting).`,
                );
            }

            const repositoryBaseDirectory = this.resolveRepositoryBaseDirectory(repositoryLocation, context);
            repositoryBaseDirectoryForContext = repositoryBaseDirectory;
            const currentDirectory = context.baseDir || repositoryBaseDirectory;
            resolvedPath = this.resolveTemplateWithinRepository(
                repositoryRef.templatePath,
                currentDirectory,
                repositoryBaseDirectory,
            );

            if (!resolvedPath) {
                throw new Error(
                    `Template file not found for repository '${repositoryRef.repository}': ${repositoryRef.templatePath}`,
                );
            }

            templateBaseDir = path.dirname(resolvedPath);
        } else {
            const repositoryBaseDirectory = context.repositoryBaseDir || undefined;
            const candidatePath = this.resolveTemplateWithinRepository(
                templatePathValue,
                context.baseDir,
                repositoryBaseDirectory,
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
        if (process.env.ADO_YAML_DEBUG === '1') {
            console.log('[debug] resolved template path ->', resolvedPath);
        }
        const normalizedSource = this.preprocessCompileTimeExpressions(templateSource);

        let templateDocument;
        try {
            templateDocument = YAML.parse(normalizedSource) || {};
        } catch (error) {
            throw new Error(`Failed to parse template '${templatePathValue}': ${error.message}`);
        }

        templateDocument = this.restoreCompileTimeExpressions(templateDocument);

        const defaultParameters = this.extractParameters(templateDocument);
        const providedParameters = this.normalizeTemplateParameters(node.parameters, context);

        // Validate that all required parameters (without defaults) are provided
        this.validateTemplateParameters(templateDocument, providedParameters, templatePathValue);

        const mergedParameters = { ...defaultParameters, ...providedParameters };

        if (process.env.DEBUG_PARSER && templatePathValue && templatePathValue.includes('windows-client-v0')) {
            const bp = providedParameters.buildParams;
            console.log('[debug] windows-client-v0 - buildParams keys:', bp ? Object.keys(bp) : 'no buildParams');
            if (bp && bp.preSteps) {
                console.log(
                    '[debug] buildParams.preSteps isArray:',
                    Array.isArray(bp.preSteps),
                    'length:',
                    bp.preSteps.length,
                );
                if (Array.isArray(bp.preSteps) && bp.preSteps.length > 0) {
                    console.log('[debug] preSteps[0] has template:', bp.preSteps[0] && 'template' in bp.preSteps[0]);
                }
            } else {
                console.log('[debug] buildParams HAS NO preSteps!');
            }
        }

        if (process.env.ADO_YAML_DEBUG === '1') {
            console.log('[debug] merged template parameters keys:', Object.keys(mergedParameters));
        }

        if (process.env.DEBUG_PARSER && mergedParameters.preSteps) {
            console.log(
                '[debug] Template has preSteps parameter, isArray:',
                Array.isArray(mergedParameters.preSteps),
                'length:',
                mergedParameters.preSteps.length,
            );
            if (Array.isArray(mergedParameters.preSteps) && mergedParameters.preSteps.length > 0) {
                console.log(
                    '[debug] preSteps[0] has template:',
                    mergedParameters.preSteps[0] &&
                        typeof mergedParameters.preSteps[0] === 'object' &&
                        'template' in mergedParameters.preSteps[0],
                );
            }
        }

        const templateContext = this.createTemplateContext(context, mergedParameters, templateBaseDir, {
            repositoryBaseDir: repositoryBaseDirectoryForContext,
        });

        const expandedTemplate = this.expandNode(templateDocument, templateContext) || {};
        const body = this.extractTemplateBody(expandedTemplate);
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
            .filter((segment) => segment && segment.length);

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
            parts.length ? path.resolve(base, ...parts) : path.normalize(base),
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
        // Like expandNode, but preserves template references so they can be expanded later
        if (node === null || node === undefined) {
            return node;
        }

        if (Array.isArray(node)) {
            const result = node.map((item) => {
                if (this.isTemplateReference(item)) {
                    if (process.env.DEBUG_PARSER) {
                        console.log(
                            '[debug] expandNodePreservingTemplates: preserving template reference:',
                            item.template,
                        );
                    }
                    return item;
                }
                return this.expandNodePreservingTemplates(item, context);
            });
            if (process.env.DEBUG_PARSER && result.length > 0) {
                console.log('[debug] expandNodePreservingTemplates: array result length:', result.length);
            }
            return result;
        }

        if (typeof node === 'object') {
            // Preserve template references at object level
            if (this.isTemplateReference(node)) {
                // Still expand expressions in the template path and parameters
                const result = { template: node.template };
                if (node.parameters) {
                    result.parameters = this.expandNodePreservingTemplates(node.parameters, context);
                }
                return result;
            }

            const result = {};
            for (const [key, value] of Object.entries(node)) {
                // Handle ${{ insert }} directive
                if (typeof key === 'string' && this.isFullExpression(key.trim())) {
                    const expr = this.stripExpressionDelimiters(key.trim());
                    if (expr.trim() === 'insert') {
                        // Expand the value and merge its properties into result
                        const expandedValue = this.expandNodePreservingTemplates(value, context);
                        if (process.env.DEBUG_PARSER) {
                            console.log(
                                '[debug] expandNodePreservingTemplates: ${{ insert }} merging',
                                Object.keys(expandedValue || {}),
                            );
                        }
                        if (expandedValue && typeof expandedValue === 'object' && !Array.isArray(expandedValue)) {
                            Object.assign(result, expandedValue);
                            continue;
                        }
                    }
                }

                const expandedKey = typeof key === 'string' ? this.replaceExpressionsInString(key, context) : key;
                result[expandedKey] = this.expandNodePreservingTemplates(value, context);
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
        }

        if (Array.isArray(evaluated)) {
            const result = {};
            evaluated.forEach((item) => {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
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
                }
            });
            return result;
        }

        return {};
    }

    extractTemplateBody(expandedTemplate) {
        if (!expandedTemplate) {
            return [];
        }

        if (Array.isArray(expandedTemplate)) {
            return expandedTemplate;
        }

        if (typeof expandedTemplate !== 'object') {
            return [];
        }

        const sanitized = {};
        for (const [key, value] of Object.entries(expandedTemplate)) {
            if (key === 'parameters') {
                continue;
            }
            sanitized[key] = value;
        }

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

        if (Object.keys(sanitized).length > 0) {
            return [sanitized];
        }

        return [];
    }

    isFullExpression(text) {
        return /^\$\{\{.*\}\}$/.test(text);
    }

    stripExpressionDelimiters(expr) {
        return expr
            .replace(/^\$\{\{/, '')
            .replace(/\}\}$/, '')
            .trim();
    }

    isEachDirective(text) {
        return /^\$\{\{\s*each\s+/.test(text);
    }

    isConditionalDirective(text) {
        return this.isIfDirective(text) || this.isElseIfDirective(text) || this.isElseDirective(text);
    }

    isIfDirective(text) {
        return /^\$\{\{\s*if\s+/.test(text);
    }

    isElseIfDirective(text) {
        return /^\$\{\{\s*elseif\s+/.test(text);
    }

    isElseDirective(text) {
        return /^\$\{\{\s*else\s*\}\}$/.test(text);
    }

    parseIfCondition(text) {
        const match = text.match(/^\$\{\{\s*if\s+(.+?)\s*\}\}$/);
        return match ? match[1] : '';
    }

    parseElseIfCondition(text) {
        const match = text.match(/^\$\{\{\s*elseif\s+(.+?)\s*\}\}$/);
        return match ? match[1] : '';
    }

    parseEachDirective(text) {
        const match = text.match(/^\$\{\{\s*each\s+([a-zA-Z_]\w*)\s+in\s+(.+?)\s*\}\}$/);
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
    PipelineConfig,
    Range,
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
        const sourceText = fs.readFileSync(filePath, 'utf8');
        const expanded = parserInstance.expandPipelineToString(sourceText, { fileName: filePath });
        process.stdout.write(expanded);
    } catch (error) {
        console.error(`Failed to expand pipeline: ${error.message}`);
        process.exit(1);
    }
}
