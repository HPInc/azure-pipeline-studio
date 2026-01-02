const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const jsep = require('jsep');

class AzurePipelineParser {
    constructor(options = {}) {
        this.expressionCache = new Map();
    }

    expandPipelineFromFile(filePath, overrides = {}) {
        const input = fs.readFileSync(filePath, 'utf8');
        const baseDir = path.dirname(filePath);
        // Initialize template stack with root file
        const enhancedOverrides = {
            ...overrides,
            fileName: filePath,
            baseDir,
            templateStack: [filePath],
        };
        return this.expandPipelineToString(input, enhancedOverrides);
    }

    expandPipelineToString(sourceText, overrides = {}) {
        const { document } = this.expandPipeline(sourceText, overrides);

        // Extract and remove quote styles metadata
        const quoteStyles = document.__quoteStyles || new Map();
        delete document.__quoteStyles;

        // Extract scripts that had ${{}} expressions before expansion
        const scriptsWithExpressions = document.__scriptsWithExpressions || new Set();
        delete document.__scriptsWithExpressions;
        const scriptsWithLastLineExpressions = document.__scriptsWithLastLineExpressions || new Set();
        delete document.__scriptsWithLastLineExpressions;

        // Create YAML document and restore quote styles
        const yamlDoc = YAML.parseDocument(YAML.stringify(document));
        this.restoreQuoteStyles(yamlDoc.contents, [], quoteStyles);

        // Always apply block scalar styles to control formatting
        // When azureCompatible=false, use literal style to preserve exact formatting
        // When azureCompatible=true, apply Azure-specific transformations
        const azureCompatible = overrides.azureCompatible || false;
        console.log(`Azure Compatibility mode: ${azureCompatible}`);
        this.applyBlockScalarStyles(
            yamlDoc.contents,
            scriptsWithExpressions,
            scriptsWithLastLineExpressions,
            azureCompatible,
        );
        let output = yamlDoc.toString({
            lineWidth: 0,
            indent: 2,
            defaultStringType: 'PLAIN',
            defaultKeyType: 'PLAIN',
            simpleKeys: false,
            aliasDuplicateObjects: false, // Disable YAML anchors/aliases for Azure Pipelines compatibility
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
        output = output.replace(/(['"]?)__(?:TRUE|FALSE)__\1/g, (match, quote) =>
            quote
                ? `${quote}${match.includes('TRUE') ? 'True' : 'False'}${quote}`
                : match.includes('TRUE')
                  ? 'True'
                  : 'False',
        );

        // Handle trailing newlines and blank line removal based on mode
        if (azureCompatible) {
            // Remove extra blank lines between sections
            output = output.replace(/^(\S.+)\n\n(\s*-\s)/gm, '$1\n$2');
            output = output.replace(/^(\S.+)\n\n(\s*\w+:)/gm, '$1\n$2');

            if (!output.endsWith('\n\n\n')) {
                output = output.replace(/\n*$/, '\n\n\n');
            }
        } else {
            output = output.replace(/\n*$/, '\n');
        }
        return output;
    }

    expandPipeline(sourceText, overrides = {}) {
        let document;
        let quoteStyles = new Map();
        try {
            // Parse as document to extract quote information
            const yamlDoc = YAML.parseDocument(sourceText);
            this.extractQuoteStyles(yamlDoc.contents, [], quoteStyles);

            document = yamlDoc.toJSON() || {};
        } catch (error) {
            throw new Error(`Failed to parse YAML: ${error.message}`);
        }

        const context = this.buildExecutionContext(document, overrides);

        // Store quote styles in context so they're available during template expansion
        context.quoteStyles = quoteStyles;

        const expandedDocument = this.expandNode(document, context);

        // Merge quote styles from all templates (context-aware hashes don't conflict)
        const allQuoteStyles = new Map(quoteStyles);
        if (context.templateQuoteStyles) {
            for (const [, templateStyles] of context.templateQuoteStyles.entries()) {
                for (const [key, style] of templateStyles.entries()) {
                    // Context hashes and globs can be safely merged
                    if (!allQuoteStyles.has(key)) {
                        allQuoteStyles.set(key, style);
                    }
                }
            }
        }

        // Store quote styles for later restoration
        expandedDocument.__quoteStyles = allQuoteStyles;

        // Store scripts that had ${{}} expressions for block scalar style determination
        expandedDocument.__scriptsWithExpressions = context.scriptsWithExpressions || new Set();
        expandedDocument.__scriptsWithLastLineExpressions = context.scriptsWithLastLineExpressions || new Set();

        return {
            document: expandedDocument,
            context,
        };
    }

    /**
     * Extract quote styles from YAML AST.
     * Uses path-based matching for exact preservation, with context-aware hash fallback.
     * Context is determined by displayName/task/name in the ancestor chain.
     * @param {object} node - YAML AST node
     * @param {array} path - Current path in the document
     * @param {Map} quoteStyles - Map to store quote styles
     * @param {string} context - Context identifier from ancestor (displayName or task)
     */
    extractQuoteStyles(node, path, quoteStyles, context = '') {
        if (!node) return;

        if (node.items && node.constructor.name === 'YAMLMap') {
            // Extract context identifier from this map (displayName has highest priority)
            let currentContext = context;
            let foundTask = '';
            // TODO: Make this more generic with unique hash or a step index
            for (const pair of node.items) {
                if (pair.key && pair.value && typeof pair.value.value === 'string') {
                    const keyName = pair.key.value;
                    if (keyName === 'displayName') {
                        currentContext = pair.value.value;
                        break; // displayName has highest priority
                    } else if (keyName === 'task' || keyName === 'name') {
                        foundTask = pair.value.value; // store but keep looking for displayName
                    }
                }
            }
            if (currentContext === context && foundTask) {
                currentContext = foundTask; // use task/name only if no displayName found
            }

            for (const pair of node.items) {
                if (pair.key && pair.key.value) {
                    const keyPath = [...path, pair.key.value];
                    if (pair.value && typeof pair.value.value === 'string') {
                        const quoteType = pair.value.type;
                        const keyName = pair.key.value;
                        const valueContent = pair.value.value;

                        if (quoteType === 'QUOTE_SINGLE' || quoteType === 'QUOTE_DOUBLE') {
                            // Store by exact path
                            quoteStyles.set(keyPath.join('.'), quoteType);

                            // Store context-aware hash (context:key:value) - most reliable
                            if (currentContext) {
                                quoteStyles.set(`__ctx:${currentContext}:${keyName}:${valueContent}`, quoteType);
                            }

                            // Track empty strings
                            if (valueContent === '') {
                                if (!quoteStyles.has('__empty_string')) {
                                    quoteStyles.set('__empty_string', quoteType);
                                }
                            }

                            // Track glob patterns (these are unique enough to not conflict)
                            if (valueContent.length > 2 && /\*\*|[*/]\/|\/[*/]/.test(valueContent)) {
                                if (!quoteStyles.has(`__glob:${valueContent}`)) {
                                    quoteStyles.set(`__glob:${valueContent}`, quoteType);
                                }
                            }
                        }
                    }

                    if (pair.value) {
                        this.extractQuoteStyles(pair.value, keyPath, quoteStyles, currentContext);
                    }
                }
            }
        } else if (node.items && node.constructor.name === 'YAMLSeq') {
            node.items.forEach((item, index) => {
                const itemPath = [...path, index];
                this.extractQuoteStyles(item, itemPath, quoteStyles, context);
            });
        }
    }

    /**
     * Restore quote styles using path match, then context-aware hash.
     * @param {object} node - YAML AST node
     * @param {array} path - Current path in the document
     * @param {Map} quoteStyles - Map of stored quote styles
     * @param {string} context - Context identifier from ancestor
     */
    restoreQuoteStyles(node, path, quoteStyles, context = '') {
        if (!node) return;

        if (node.items && node.constructor.name === 'YAMLMap') {
            // Extract context identifier from this map (displayName has highest priority)
            let currentContext = context;
            let foundTask = '';
            for (const pair of node.items) {
                if (pair.key && pair.value && typeof pair.value.value === 'string') {
                    const keyName = pair.key.value;
                    if (keyName === 'displayName') {
                        currentContext = pair.value.value;
                        break;
                    } else if (keyName === 'task' || keyName === 'name') {
                        foundTask = pair.value.value;
                    }
                }
            }
            if (currentContext === context && foundTask) {
                currentContext = foundTask;
            }

            for (const pair of node.items) {
                if (pair.key && pair.key.value && pair.value) {
                    const keyPath = [...path, pair.key.value];
                    const pathKey = keyPath.join('.');

                    // Try exact path first
                    let quoteStyle = quoteStyles.get(pathKey);

                    if (!quoteStyle && typeof pair.value.value === 'string') {
                        const keyName = pair.key.value;
                        const valueContent = pair.value.value;

                        // Try context-aware hash (most reliable for cross-template)
                        if (currentContext) {
                            quoteStyle = quoteStyles.get(`__ctx:${currentContext}:${keyName}:${valueContent}`);
                        }

                        // Glob patterns (unique enough to be safe)
                        if (!quoteStyle && valueContent.length > 2 && /\*\*|[*/]\/|\/[*/]/.test(valueContent)) {
                            quoteStyle = quoteStyles.get(`__glob:${valueContent}`);
                        }

                        // Empty strings
                        if (!quoteStyle && valueContent === '') {
                            quoteStyle = quoteStyles.get('__empty_string');
                        }
                    }

                    if (quoteStyle && pair.value.value !== undefined) {
                        pair.value.type = quoteStyle;
                    }

                    this.restoreQuoteStyles(pair.value, keyPath, quoteStyles, currentContext);
                }
            }
        } else if (node.items && node.constructor.name === 'YAMLSeq') {
            node.items.forEach((item, index) => {
                const itemPath = [...path, index];
                this.restoreQuoteStyles(item, itemPath, quoteStyles, context);
            });
        }
    }

    /**
     * Apply Azure-compatible block scalar styles to script values.
     * Azure Azure DevOps uses heuristics to choose between > (folded) and | (literal).
     * Our heuristic priority:
     * - Keep > (folded) if source already uses it
     * - Use > (folded) if content originally had ${{}} expressions (tracked during expansion)
     * - Use | (literal) otherwise for scripts - preserves newlines
     * @param {object} node - YAML AST node
     * @param {Set} scriptsWithExpressions - Set of script content hashes that had ${{}} before expansion
     * @param {Set} scriptsWithLastLineExpressions - Set of script content where last line had ${{}} before expansion
     * @param {boolean} azureCompatible - Whether to apply Azure-compatible transformations (empty lines, chomping)
     */
    applyBlockScalarStyles(
        node,
        scriptsWithExpressions = new Set(),
        scriptsWithLastLineExpressions = new Set(),
        azureCompatible = false,
    ) {
        if (!node) return;

        if (node.items && node.constructor.name === 'YAMLMap') {
            for (const pair of node.items) {
                if (!pair.key?.value || !pair.value) continue;

                const { value } = pair;
                if (typeof value.value !== 'string' || !value.value.includes('\n')) {
                    this.applyBlockScalarStyles(
                        value,
                        scriptsWithExpressions,
                        scriptsWithLastLineExpressions,
                        azureCompatible,
                    );
                    continue;
                }

                let content = value.value;

                // Handle trailing spaces in Azure mode - force double quotes
                if (azureCompatible && this.hasTrailingSpaces(content)) {
                    value.type = 'QUOTE_DOUBLE';
                    this.applyBlockScalarStyles(
                        value,
                        scriptsWithExpressions,
                        scriptsWithLastLineExpressions,
                        azureCompatible,
                    );
                    continue;
                }

                // Apply block scalar styles
                if (value.type !== 'QUOTE_DOUBLE') {
                    const trimmedKey = content.replace(/\s+$/, '');
                    const hadExpressions = scriptsWithExpressions.has(trimmedKey);
                    const hasHeredoc = /<<[-]?\s*['"]?(\w+)['"]?/.test(content);

                    // Determine block scalar type
                    if (hasHeredoc && azureCompatible && hadExpressions) {
                        content = this.addEmptyLinesInHeredoc(content);
                        value.value = content;
                        value.type = 'BLOCK_FOLDED';
                    } else {
                        value.type = hadExpressions && azureCompatible ? 'BLOCK_FOLDED' : 'BLOCK_LITERAL';
                    }

                    // Normalize trailing newlines
                    value.value = this.normalizeTrailingNewlines(content, azureCompatible);
                }

                this.applyBlockScalarStyles(
                    value,
                    scriptsWithExpressions,
                    scriptsWithLastLineExpressions,
                    azureCompatible,
                );
            }
        } else if (node.items && node.constructor.name === 'YAMLSeq') {
            node.items.forEach((item) =>
                this.applyBlockScalarStyles(
                    item,
                    scriptsWithExpressions,
                    scriptsWithLastLineExpressions,
                    azureCompatible,
                ),
            );
        }
    }

    hasTrailingSpaces(content) {
        const lines = content.split('\n');
        return lines.some((line, idx) => (idx < lines.length - 1 || line !== '' ? /[ \t]$/.test(line) : false));
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
        if (!content) return false;

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

    /**
     * Add empty lines between lines in heredoc content so folded style preserves newlines
     * @param {string} content - Script content with heredoc
     * @returns {string} - Modified content with empty lines in heredoc
     */
    addEmptyLinesInHeredoc(content) {
        // Match heredoc pattern: <<EOF or <<-EOF or <<'EOF' or <<"EOF"
        const heredocRegex = /<<[-]?\s*['"]?(\w+)['"]?/g;
        let result = content;
        let match;

        // Find all heredocs and their delimiters
        const heredocs = [];
        while ((match = heredocRegex.exec(content)) !== null) {
            heredocs.push({
                delimiter: match[1],
                startIndex: match.index,
            });
        }

        // Process each heredoc from last to first (to preserve indices)
        for (let i = heredocs.length - 1; i >= 0; i--) {
            const { delimiter, startIndex } = heredocs[i];

            // Find the start of heredoc content (after the <<DELIM line)
            const startLineEnd = result.indexOf('\n', startIndex);
            if (startLineEnd === -1) continue;

            // Find the end delimiter (must be on its own line or with leading whitespace for <<-)
            const delimiterRegex = new RegExp(`^[ \\t]*${delimiter}[ \\t]*$`, 'm');
            const endMatch = delimiterRegex.exec(result.slice(startLineEnd + 1));
            if (!endMatch) continue;

            const contentStart = startLineEnd + 1;
            const contentEnd = startLineEnd + 1 + endMatch.index;

            // Get heredoc content
            const heredocContent = result.slice(contentStart, contentEnd);

            // Check if heredoc already has blank lines between content lines
            // If so, don't add more (avoids doubling when content was previously formatted with folded style)
            const lines = heredocContent.split('\n');
            let hasExistingBlankLines = false;
            for (let j = 1; j < lines.length; j++) {
                if (lines[j].trim() === '' && j > 0 && lines[j - 1].trim() !== '') {
                    hasExistingBlankLines = true;
                    break;
                }
            }

            // Only add blank lines if none exist
            if (!hasExistingBlankLines) {
                // Build result: add blank line only between consecutive non-empty lines
                const spacedLines = [];
                for (let j = 0; j < lines.length; j++) {
                    const line = lines[j];
                    const isEmptyLine = line.trim() === '';

                    if (j > 0 && !isEmptyLine) {
                        // Check if previous line was non-empty (need to add blank between them)
                        const prevLine = lines[j - 1];
                        const prevWasEmpty = prevLine.trim() === '';

                        if (!prevWasEmpty) {
                            // Two consecutive non-empty lines - add blank line between
                            spacedLines.push('');
                        }
                    }
                    spacedLines.push(line);
                }
                const spacedContent = spacedLines.join('\n');

                // Replace the heredoc content
                result = result.slice(0, contentStart) + spacedContent + result.slice(contentEnd);
            }
        }

        return result;
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
            templateStack: overrides.templateStack || [],
            scriptsWithExpressions: new Set(), // Track scripts that had ${{}} before expansion
            scriptsWithLastLineExpressions: new Set(), // Track scripts that had ${{}} on last line before expansion
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
            normalized[key] = this.deepClone(value);
        }

        return normalized;
    }

    mergeResourcesConfig(baseResources = {}, overrideResources = {}) {
        const merged = {};

        for (const [key, value] of Object.entries(baseResources)) {
            if (key === 'repositories') {
                continue;
            }
            merged[key] = this.deepClone(value);
        }

        merged.repositories = this.mergeRepositoryConfigs(baseResources.repositories, overrideResources.repositories);

        for (const [key, value] of Object.entries(overrideResources)) {
            if (key === 'repositories') {
                continue;
            }
            merged[key] = this.deepClone(value);
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
                    list.push(this.deepClone(entry));
                }
            });
        } else if (typeof value === 'object') {
            for (const [key, entry] of Object.entries(value)) {
                if (!entry || typeof entry !== 'object') {
                    continue;
                }
                const cloned = this.deepClone(entry);
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

            const clone = this.deepClone(entry);
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

    validateTemplateParameters(templateDocument, providedParameters, templatePath, context) {
        if (!templateDocument || typeof templateDocument !== 'object') {
            return;
        }

        const { parameters } = templateDocument;
        if (!parameters) {
            return;
        }

        const missingRequired = [];
        const invalidValues = [];
        const typeErrors = [];
        const unknownParameters = [];

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
            const providedValue = wasProvided ? providedParameters[name] : undefined;

            // If no default and not provided, it's missing
            if (!hasDefault && !wasProvided) {
                missingRequired.push(name);
            }

            // Validate parameter type if provided
            if (wasProvided && param.type !== undefined) {
                const paramType = param.type.toLowerCase();
                const actualValue = providedValue;

                // Skip type validation if value contains runtime variable references
                // Matches: $(var) or patterns like $(var1)-$(var2)-$(var3)
                const isRuntimeVariable = typeof actualValue === 'string' && /\$\([^)]+\)/.test(actualValue);

                // Skip validation for undefined values (e.g., from ${{ variables.X }} expressions)
                // These will be resolved at pipeline runtime
                const isUndefinedRuntime = actualValue === undefined;

                if (!isRuntimeVariable && !isUndefinedRuntime) {
                    let typeValid = true;
                    let expectedType = param.type;

                    switch (paramType) {
                        case 'string':
                            // Accept strings, numbers (will be converted to string), and booleans
                            typeValid =
                                typeof actualValue === 'string' ||
                                typeof actualValue === 'number' ||
                                typeof actualValue === 'boolean';
                            break;
                        case 'number':
                            // Accept numbers and numeric strings
                            if (typeof actualValue === 'number') {
                                typeValid = true;
                            } else if (typeof actualValue === 'string') {
                                typeValid = !isNaN(actualValue) && !isNaN(parseFloat(actualValue));
                            } else {
                                typeValid = false;
                            }
                            break;
                        case 'boolean':
                            // Accept booleans, boolean-like strings, and boolean markers
                            if (typeof actualValue === 'boolean') {
                                typeValid = true;
                            } else if (typeof actualValue === 'string') {
                                const lower = actualValue.toLowerCase();
                                typeValid =
                                    lower === 'true' ||
                                    lower === 'false' ||
                                    lower === '__true__' ||
                                    lower === '__false__';
                            } else {
                                typeValid = false;
                            }
                            break;
                        case 'object':
                            // In Azure DevOps, 'object' type accepts both objects and arrays
                            // Special case: dependsOn can be a string, array, or object
                            if (name === 'dependsOn') {
                                typeValid =
                                    typeof actualValue === 'string' ||
                                    (typeof actualValue === 'object' && actualValue !== null);
                            } else {
                                typeValid = typeof actualValue === 'object' && actualValue !== null;
                            }
                            break;
                        case 'step':
                        case 'steplist':
                            typeValid = Array.isArray(actualValue);
                            expectedType = 'array (stepList)';
                            break;
                        case 'job':
                        case 'joblist':
                            typeValid = Array.isArray(actualValue);
                            expectedType = 'array (jobList)';
                            break;
                        case 'deployment':
                        case 'deploymentlist':
                            typeValid = Array.isArray(actualValue);
                            expectedType = 'array (deploymentList)';
                            break;
                        case 'stage':
                        case 'stagelist':
                            typeValid = Array.isArray(actualValue);
                            expectedType = 'array (stageList)';
                            break;
                        default:
                            // Unknown type, skip validation
                            typeValid = true;
                    }

                    if (!typeValid) {
                        typeErrors.push({
                            name,
                            expected: expectedType,
                            actual: typeof actualValue,
                            value: actualValue,
                        });
                    }
                }
            }

            // Validate allowed values if provided
            if (wasProvided && param.values && Array.isArray(param.values)) {
                const actualValue = providedValue;

                // Skip validation for runtime variables
                const isRuntimeVariable = typeof actualValue === 'string' && /\$\([^)]+\)/.test(actualValue);

                if (!isRuntimeVariable && !param.values.includes(actualValue)) {
                    invalidValues.push({
                        name,
                        value: actualValue,
                        allowed: param.values,
                    });
                }
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

        // Check for unknown parameters (parameters provided but not defined in template)
        if (providedParameters && typeof providedParameters === 'object') {
            const definedParams = new Set();

            if (Array.isArray(parameters)) {
                for (const param of parameters) {
                    if (param?.name) {
                        definedParams.add(param.name);
                    }
                }
            } else if (typeof parameters === 'object') {
                for (const name of Object.keys(parameters)) {
                    definedParams.add(name);
                }
            }

            for (const providedName of Object.keys(providedParameters)) {
                // Skip empty string keys (from ${{ insert }}: syntax)
                if (providedName === '') {
                    continue;
                }
                if (!definedParams.has(providedName)) {
                    unknownParameters.push(providedName);
                }
            }
        }

        // Report errors
        const errors = [];

        if (missingRequired.length > 0) {
            const templateName = templatePath || 'template';
            const paramList = missingRequired.map((p) => `'${p}'`).join(', ');
            errors.push(
                `Missing required parameter(s) for template '${templateName}': ${paramList}. ` +
                    `These parameters do not have default values and must be provided when calling the template.`,
            );
        }

        if (typeErrors.length > 0) {
            const templateName = templatePath || 'template';
            const errorDetails = typeErrors
                .map(
                    (err) =>
                        `Parameter '${err.name}' expects type '${err.expected}' but received '${err.actual}' (value: ${JSON.stringify(err.value)})`,
                )
                .join('\n    ');
            errors.push(`Invalid parameter type(s) for template '${templateName}':\n    ${errorDetails}`);
        }

        if (invalidValues.length > 0) {
            const templateName = templatePath || 'template';
            const errorDetails = invalidValues
                .map(
                    (err) =>
                        `Parameter '${err.name}' has value '${err.value}' which is not in allowed values: [${err.allowed.join(', ')}]`,
                )
                .join('\n    ');
            errors.push(`Invalid parameter value(s) for template '${templateName}':\n    ${errorDetails}`);
        }

        if (unknownParameters.length > 0) {
            const templateName = templatePath || 'template';
            const paramList = unknownParameters.map((p) => `'${p}'`).join(', ');
            errors.push(
                `Unknown parameter(s) for template '${templateName}': ${paramList}. ` +
                    `These parameters are not defined in the template.`,
            );
        }

        if (errors.length > 0) {
            let errorMessage = errors.join('\n\n');

            // Add template call stack if available
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
        if (Array.isArray(node)) {
            return this.expandArray(node, context, parentKey);
        }
        if (node && typeof node === 'object') {
            return this.expandObject(node, context, parentKey);
        }
        return this.expandScalar(node, context);
    }

    expandArray(array, context, parentKey = null) {
        const result = [];
        const isVariablesArray = parentKey === 'variables';

        for (let index = 0; index < array.length; index += 1) {
            const element = array[index];

            if (this.isTemplateReference(element)) {
                const templateItems = this.expandTemplateReference(element, context);
                result.push(...templateItems);

                // If we're in a variables array, add template variables to context
                // This makes them available within the same scope (job/stage/global)
                if (isVariablesArray && Array.isArray(templateItems)) {
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
                continue;
            }

            if (this.isSingleKeyObject(element)) {
                const key = Object.keys(element)[0];

                if (this.isEachDirective(key)) {
                    const applied = this.applyEachDirective(key, element[key], context);
                    result.push(...applied.items);
                    continue;
                }

                if (key && this.isConditionalDirective(key)) {
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
                for (const item of expandedElement) {
                    if (this.isTemplateReference(item)) {
                        const templateItems = this.expandTemplateReference(item, context);
                        result.push(...templateItems);
                    } else {
                        result.push(item);
                    }
                }
            } else {
                result.push(expandedElement);
            }

            // If we're in a variables array, extract the variable and add it to context
            // This allows forward references within the same variables section
            if (
                isVariablesArray &&
                expandedElement &&
                typeof expandedElement === 'object' &&
                !Array.isArray(expandedElement)
            ) {
                const varName = expandedElement.name;
                const varValue = this.pickFirstDefined(expandedElement.value, expandedElement.default);
                if (varName && varValue !== undefined) {
                    // Update the context so subsequent variables can reference this one
                    context.variables[varName] = varValue;
                }
            }
        }
        return result;
    }

    expandObject(object, context, parentKey = null) {
        const entries = Object.entries(object);
        const result = {};

        for (let index = 0; index < entries.length; index += 1) {
            const [rawKey, value] = entries[index];

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
                if (expr.trim() === 'insert') {
                    const expandedValue = this.expandNodePreservingTemplates(value, context);
                    if (expandedValue && typeof expandedValue === 'object' && !Array.isArray(expandedValue)) {
                        Object.assign(result, expandedValue);
                        continue;
                    }
                }
            }

            const key = typeof rawKey === 'string' ? this.replaceExpressionsInString(rawKey, context) : rawKey;

            // Track if any multiline string values have ${{}} before expansion
            const originalHadExpressions = typeof value === 'string' && value.includes('${{') && value.includes('\n');
            // Track if last line has ${{}} - used to determine + chomping
            const originalLastLineHadExpression = originalHadExpressions && this.lastLineHasTemplateExpression(value);

            // Also check if original value is a single-line full expression that might expand to multiline
            // Pattern: value is just "${{ ... }}" (with possible whitespace)
            const isSingleLineFullExpression =
                typeof value === 'string' && !value.includes('\n') && /^\s*\$\{\{.*\}\}\s*$/.test(value.trim());

            const expandedValue = this.expandNode(value, context, key);
            if (expandedValue === undefined) {
                continue;
            }

            // If this value had ${{}} expressions, track it for block scalar style
            // Use trimmed content as key (trailing whitespace may change through YAML round-trip)
            if (originalHadExpressions && typeof expandedValue === 'string') {
                if (!context.scriptsWithExpressions) {
                    context.scriptsWithExpressions = new Set();
                }
                const contentKey = expandedValue.replace(/\s+$/, '');
                context.scriptsWithExpressions.add(contentKey);

                // If last line had ${{}} expression, track for + chomping
                if (originalLastLineHadExpression) {
                    if (!context.scriptsWithLastLineExpressions) {
                        context.scriptsWithLastLineExpressions = new Set();
                    }
                    context.scriptsWithLastLineExpressions.add(contentKey);
                }
            }

            // If original was a single-line full expression that expanded to multiline,
            // also track for + chomping (the whole value was a template expression)
            if (isSingleLineFullExpression && typeof expandedValue === 'string' && expandedValue.includes('\n')) {
                const contentKey = expandedValue.replace(/\s+$/, '');
                context.scriptsWithExpressions.add(contentKey);
                context.scriptsWithLastLineExpressions.add(contentKey);
            }

            result[key] = expandedValue;
        }

        // Convert bash/script/pwsh/powershell/checkout shortcuts to task format (like Azure Pipelines does)
        // Skip if: already converted (has task/inputs/targetType) OR we're inside an inputs object (parentKey === 'inputs')
        if (
            (result.bash || result.script || result.pwsh || result.powershell || result.checkout) &&
            !result.task &&
            !result.inputs &&
            !result.targetType &&
            parentKey !== 'inputs'
        ) {
            const shorthandKey = ['bash', 'script', 'pwsh', 'powershell', 'checkout'].find((k) => result[k]);
            const shorthandValue = result[shorthandKey];
            delete result[shorthandKey];

            // Map shorthand to task type
            const taskTypeMap = {
                script: 'CmdLine@2',
                bash: 'Bash@3',
                pwsh: 'PowerShell@2',
                powershell: 'PowerShell@2',
                checkout: '6d15af64-176c-496d-b583-fd2ae21d4df4@1',
            };

            const taskResult = { task: taskTypeMap[shorthandKey] };

            if (shorthandKey === 'checkout') {
                // Checkout: extract condition and displayName to task level, rest to inputs
                const { condition, displayName, ...inputProps } = result;

                if (displayName) taskResult.displayName = displayName;
                taskResult.condition =
                    condition !== undefined ? condition : shorthandValue === 'none' ? false : undefined;
                if (taskResult.condition === undefined) delete taskResult.condition;

                taskResult.inputs = { repository: shorthandValue, ...inputProps };
            } else {
                // Script tasks: extract workingDirectory to inputs, rest stays at task level
                const { workingDirectory, ...taskProps } = result;

                Object.assign(taskResult, taskProps);

                // Build inputs with targetType first when needed so it serializes in that order
                let inputs;
                if (shorthandKey !== 'script') {
                    inputs = { targetType: 'inline', script: shorthandValue };
                    if (shorthandKey === 'pwsh') inputs.pwsh = true;
                } else {
                    inputs = { script: shorthandValue };
                }

                if (workingDirectory !== undefined) inputs.workingDirectory = workingDirectory;

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
        if (
            result.task === '6d15af64-176c-496d-b583-fd2ae21d4df4@1' &&
            result.inputs?.repository === 'none' &&
            !result.condition
        ) {
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

            // New IF chain starts - break if not the first element
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

            if (!branchTaken && this.evaluateConditional(key, context)) {
                merged = this.expandConditionalMappingBranch(body, context);
                branchTaken = true;
            }

            index += 1;
            if (this.isElseDirective(key)) break;
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
        const fn = name.toLowerCase();
        switch (fn) {
            case 'eq':
                return this.returnBoolean(this.compareValues(args[0], args[1]) === 0);
            case 'ne':
                return this.returnBoolean(this.compareValues(args[0], args[1]) !== 0);
            case 'gt':
                return this.returnBoolean(this.compareValues(args[0], args[1]) > 0);
            case 'ge':
                return this.returnBoolean(this.compareValues(args[0], args[1]) >= 0);
            case 'lt':
                return this.returnBoolean(this.compareValues(args[0], args[1]) < 0);
            case 'le':
                return this.returnBoolean(this.compareValues(args[0], args[1]) <= 0);

            // Logical functions
            case 'and':
                return this.returnBoolean(args.every((arg) => this.toBoolean(arg)));
            case 'or':
                return this.returnBoolean(args.some((arg) => this.toBoolean(arg)));
            case 'not':
                return this.returnBoolean(!this.toBoolean(args[0]));
            case 'xor':
                return this.returnBoolean(this.toBoolean(args[0]) !== this.toBoolean(args[1]));

            // Containment functions
            case 'coalesce':
                return args.find((arg) => arg !== undefined && arg !== null && arg !== '');
            case 'contains':
                return this.returnBoolean(this.contains(args[0], args[1]));
            case 'containsvalue':
                return this.returnBoolean(this.containsValue(args[0], args[1]));
            case 'in':
                return this.returnBoolean(
                    args.slice(1).some((candidate) => this.compareValues(args[0], candidate) === 0),
                );
            case 'notin':
                return this.returnBoolean(
                    !args.slice(1).some((candidate) => this.compareValues(args[0], candidate) === 0),
                );

            // String functions
            case 'lower':
                return typeof args[0] === 'string' ? args[0].toLowerCase() : args[0];
            case 'upper':
                return typeof args[0] === 'string' ? args[0].toUpperCase() : args[0];
            case 'startswith':
                return this.returnBoolean(this.startsWith(args[0], args[1]));
            case 'endswith':
                return this.returnBoolean(this.endsWith(args[0], args[1]));
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
                return this.returnBoolean(true);
            case 'canceled':
                return this.returnBoolean(this.isCanceled(args));
            case 'failed':
                return this.returnBoolean(this.isFailed(args));
            case 'succeeded':
                return this.returnBoolean(this.isSucceeded(args));
            case 'succeededorfailed':
                return this.returnBoolean(this.isSucceededOrFailed(args));

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
            // Convert booleans to "True"/"False" and numeric strings to numbers (Azure format)
            return JSON.stringify(
                value,
                (key, val) => {
                    if (typeof val === 'boolean') return val ? 'True' : 'False';
                    if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val)) return parseFloat(val);
                    return val;
                },
                2,
            );
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
            variables: parent.variables,
            resources: parent.resources,
            locals: { ...parent.locals, ...locals },
            baseDir: parent.baseDir,
            repositoryBaseDir: parent.repositoryBaseDir,
            resourceLocations: parent.resourceLocations || {},
            scriptsWithExpressions: parent.scriptsWithExpressions, // Preserve scripts tracking
            scriptsWithLastLineExpressions: parent.scriptsWithLastLineExpressions, // Preserve last line tracking
        };
    }

    createTemplateContext(parent, parameterOverrides, baseDir, options = {}) {
        return {
            parameters: { ...parent.parameters, ...parameterOverrides },
            variables: { ...parent.variables }, // Preserve variables from parent context (includes overrides)
            resources: parent.resources,
            locals: { ...parent.locals },
            baseDir: baseDir || parent.baseDir,
            repositoryBaseDir:
                options.repositoryBaseDir !== undefined ? options.repositoryBaseDir : parent.repositoryBaseDir,
            resourceLocations: parent.resourceLocations || {},
            templateStack: parent.templateStack || [],
            quoteStyles: parent.quoteStyles, // Preserve quote styles
            templateQuoteStyles: parent.templateQuoteStyles, // Preserve template quote styles map
            scriptsWithExpressions: parent.scriptsWithExpressions, // Preserve scripts tracking
            scriptsWithLastLineExpressions: parent.scriptsWithLastLineExpressions, // Preserve last line tracking
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

        let templateDocument;
        try {
            // Parse as document to extract quote styles
            const yamlDoc = YAML.parseDocument(templateSource);
            const templateQuoteStyles = new Map();
            this.extractQuoteStyles(yamlDoc.contents, [], templateQuoteStyles);

            // Merge template quote styles into context
            if (context.quoteStyles && templateQuoteStyles.size > 0) {
                if (!context.templateQuoteStyles) {
                    context.templateQuoteStyles = new Map();
                }
                context.templateQuoteStyles.set(resolvedPath, templateQuoteStyles);
            }

            templateDocument = yamlDoc.toJSON() || {};
        } catch (error) {
            throw new Error(`Failed to parse template '${templatePathValue}': ${error.message}`);
        }

        const defaultParameters = this.extractParameters(templateDocument);
        const providedParameters = this.normalizeTemplateParameters(node.parameters, context);

        const templateDisplayPath = repositoryRef
            ? `${repositoryRef.templatePath}@${repositoryRef.repository}`
            : templatePathValue;

        const updatedContext = {
            ...context,
            templateStack: [...(context.templateStack || []), templateDisplayPath],
        };

        this.validateTemplateParameters(templateDocument, providedParameters, templatePathValue, updatedContext);

        const mergedParameters = { ...defaultParameters, ...providedParameters };

        const templateContext = this.createTemplateContext(updatedContext, mergedParameters, templateBaseDir, {
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
                    const entries = Object.entries(item);

                    // Handle if/elseif/else conditional chains
                    if (entries.length > 0 && this.isConditionalDirective(entries[0][0])) {
                        let branchTaken = false;
                        let j = i;

                        while (j < node.length) {
                            const chainItem = node[j];
                            if (typeof chainItem !== 'object' || chainItem === null || Array.isArray(chainItem)) break;

                            const chainEntries = Object.entries(chainItem);
                            if (chainEntries.length !== 1) break;

                            const [condKey, condBody] = chainEntries[0];
                            if (!this.isConditionalDirective(condKey)) break;

                            const shouldExecute =
                                !branchTaken &&
                                (this.isElseDirective(condKey) ||
                                    this.toBoolean(
                                        this.evaluateExpression(
                                            this.isIfDirective(condKey)
                                                ? this.parseIfCondition(condKey)
                                                : this.parseElseIfCondition(condKey),
                                            context,
                                        ),
                                    ));

                            if (shouldExecute) {
                                pushExpanded(result, this.expandNodePreservingTemplates(condBody, context));
                                branchTaken = true;
                            }

                            j++;
                            if (this.isElseDirective(condKey)) break;
                        }
                        i = j;
                        continue;
                    }

                    // Handle ${{ insert }} directive
                    if (entries.length === 1) {
                        const [key, value] = entries[0];
                        if (typeof key === 'string' && this.isFullExpression(key.trim())) {
                            const expr = this.stripExpressionDelimiters(key.trim()).trim();
                            if (expr === 'insert') {
                                pushExpanded(result, this.expandNodePreservingTemplates(value, context));
                                i++;
                                continue;
                            }
                        }
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

                if (typeof key === 'string' && this.isConditionalDirective(key)) {
                    let branchTaken = false;
                    let j = i;

                    while (j < entries.length) {
                        const [condKey, condBody] = entries[j];
                        if (typeof condKey !== 'string' || !this.isConditionalDirective(condKey)) {
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
                if (typeof key === 'string' && this.isFullExpression(key.trim())) {
                    const expr = this.stripExpressionDelimiters(key.trim());
                    if (expr.trim() === 'insert') {
                        const expandedValue = this.expandNodePreservingTemplates(value, context);
                        if (expandedValue && typeof expandedValue === 'object' && !Array.isArray(expandedValue)) {
                            Object.assign(result, expandedValue);
                        }
                        i++;
                        continue;
                    }
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
        if (!text || !text.startsWith('${{') || !text.endsWith('}}')) {
            return false;
        }
        const withoutOuter = text.slice(3, -2);
        return !withoutOuter.includes('}}');
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
