const YAML = require('yaml');

/**
 * Escape special regex characters in a string
 * @param {string} string - The string to escape
 * @returns {string} The escaped string
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Checks if trimmed line is a conditional directive (if/elseif/else without leading dash)
function isConditionalDirective(line, conditionalDirectives = null) {
    const trimmed = line.trim();
    // Remove leading dash for list items to check the actual directive
    const contentAfterDash = trimmed.replace(/^-\s+/, '');

    // Match ${{ if ..., ${{ elseif ..., ${{ else }}, ${{ each ..., ${{ insert }}
    // These are template directives that don't need a leading dash
    const isRealDirective = /^\$\{\{\s*(if|elseif|else|each|insert)(\s|\})/i.test(contentAfterDash);

    if (isRealDirective) {
        return true;
    }

    // Check if this is a placeholder that was originally a conditional directive
    if (conditionalDirectives) {
        // For list items, check the content after the dash
        const placeholderMatch = contentAfterDash.match(/^(__EXPR_PLACEHOLDER_\d+__)/);
        if (placeholderMatch && conditionalDirectives.has(placeholderMatch[1])) {
            return true;
        }
    }

    return false;
}

/**
 * Replace Azure Pipeline template expressions with placeholders
 * @param {string} content - The YAML content
 * @returns {{ content: string, placeholderMap: Map, conditionalDirectives: Set }} The content with placeholders and the mapping
 */
function replaceTemplateExpressionsWithPlaceholders(content) {
    if (!content) {
        return { content, placeholderMap: new Map(), conditionalDirectives: new Set() };
    }

    const templateExpressionPattern = /(\$\{\{[^}]+\}\}|\$\[[^\]]+\])/g;
    const placeholderMap = new Map();
    const conditionalDirectives = new Set();
    let counter = 0;

    const result = content.replace(templateExpressionPattern, (match) => {
        const placeholder = '__EXPR_PLACEHOLDER_' + counter + '__';
        let normalized = match;

        if (match.startsWith('${{') && match.endsWith('}}') && !/[\r\n\t]/.test(match)) {
            // If the expression contains newlines or tabs, preserve inner formatting exactly
            // (e.g. multi-line expressions or expressions with tabs should not be collapsed)
            // Normalize to have exactly one space after '{{' and before '}}' when missing
            normalized = match.replace(/^\$\{\{\s*/, '${{ ').replace(/\s*\}\}$/, ' }}');
        }

        placeholderMap.set(placeholder, normalized);

        // Track if this placeholder represents a conditional directive
        if (isConditionalDirective(normalized)) {
            conditionalDirectives.add(placeholder);
        }

        counter++;
        return placeholder;
    });

    return { content: result, placeholderMap, conditionalDirectives };
}

/**
 * Restore template expressions from placeholders
 * @param {string} content - The content with placeholders
 * @param {Map} placeholderMap - The mapping of placeholders to original expressions
 * @returns {string} The content with restored expressions
 */
function restoreTemplateExpressions(content, placeholderMap) {
    if (!content || !placeholderMap || placeholderMap.size === 0) return content;

    let result = content;
    for (const [placeholder, originalExpression] of placeholderMap) {
        result = result.replace(new RegExp(escapeRegExp(placeholder), 'g'), originalExpression);
    }
    // Remove spaces between closing expression and colon: '}} :' -> '}}:'
    result = result.replace(/\}\}\s+:/g, '}}:');
    return result;
}

/**
 * Protect empty YAML values from being formatted incorrectly
 * @param {string} content - The YAML content
 * @returns {{ content: string, commentMap: Map }} The content with protected values and comment mapping
 */
function protectEmptyValues(content) {
    if (!content) {
        return content;
    }

    const lines = content.split(/\r?\n/);
    const result = [];
    const commentMap = new Map();
    let commentCounter = 0;
    const emptyValuePattern = /^(\s*)([^:]+):\s*$/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (isComment(line) || isListItem(line)) {
            result.push(line);
            continue;
        }

        const keyMatch = line.match(emptyValuePattern);
        if (!keyMatch) {
            result.push(line);
            continue;
        }

        const indent = keyMatch[1];
        const key = keyMatch[2];
        let nextIndex = i + 1;
        let hasChildContent = false;
        while (nextIndex < lines.length) {
            const nextLine = lines[nextIndex];
            const nextIndent = getIndent(nextLine);

            if (isBlankOrCommentLine(nextLine)) {
                nextIndex++;
                continue;
            }

            hasChildContent =
                (isListItem(lines[nextIndex]) && nextIndent >= indent.length) || nextIndent > indent.length;
            break;
        }

        if (!hasChildContent) {
            const allValueComments = [];
            let commentIndex = i + 1;

            while (commentIndex < lines.length) {
                const commentLine = lines[commentIndex];

                if (isBlank(commentLine)) {
                    allValueComments.push(commentLine);
                    commentIndex++;
                    continue;
                }

                if (!isComment(commentLine)) break;

                const commentIndent = getIndent(commentLine);
                if (commentIndent >= indent.length) {
                    allValueComments.push(commentLine);
                    commentIndex++;
                } else {
                    break;
                }
            }

            if (allValueComments.length > 0) {
                const commentId = `__COMMENT_${commentCounter}__`;
                commentMap.set(commentId, allValueComments);
                commentCounter++;
                result.push(`${indent}${key}: __EMPTY_VALUE_PLACEHOLDER__${commentId}`);
                i = commentIndex - 1;
            } else {
                result.push(`${indent}${key}: __EMPTY_VALUE_PLACEHOLDER__`);
            }
            continue;
        }

        result.push(line);
    }

    return { content: result.join('\n'), commentMap };
}

/**
 * Restore empty values that were protected during formatting
 * @param {string} content - The formatted content with placeholders
 * @param {Map} commentMap - The mapping of comment placeholders
 * @returns {string} The content with restored empty values
 */
function restoreEmptyValues(content, commentMap) {
    if (!content) return content;
    if (!commentMap || commentMap.size === 0) {
        return content.replace(/:\s*__EMPTY_VALUE_PLACEHOLDER__\s*$/gm, ':');
    }

    const lines = content.split(/\r?\n/);
    const result = [];

    for (const line of lines) {
        const match = line.match(/^(\s*)([^:]+):\s*__EMPTY_VALUE_PLACEHOLDER__(__COMMENT_\d+__)\s*$/);
        if (match) {
            const [, indent, key, commentId] = match;
            const comments = commentMap.get(commentId);
            result.push(`${indent}${key}:`);
            if (comments?.length) {
                comments.forEach((comment) => result.push(comment));
            }
        } else if (line.match(/:\s*__EMPTY_VALUE_PLACEHOLDER__\s*$/)) {
            // Placeholder without comment ID
            result.push(line.replace(/:\s*__EMPTY_VALUE_PLACEHOLDER__\s*$/, ':'));
        } else {
            result.push(line);
        }
    }

    return result.join('\n');
}

/**
 * Parse file-level formatting directives from YAML comments
 * Supports:
 *   # aps-format=false (disables formatting)
 *   # aps-format newline=\r\n,lineWidth=120,indent=4 (custom options)
 *
 * @param {string} content - The YAML content
 * @returns {{ disabled: boolean, options: object|null }}
 */
function parseFormatDirectives(content) {
    const lines = content.split(/\r?\n/);
    const result = { disabled: false, options: null };

    // Only check first 5 lines for directives
    const headerLines = lines.slice(0, 5);

    for (const line of headerLines) {
        const trimmed = line.trim();

        // Check for disable directive
        if (isComment(line) && (trimmed === '# aps-format=false' || trimmed === '# aps-format: false')) {
            result.disabled = true;
            return result;
        }

        // Check for options directive
        const optionsMatch = trimmed.match(/^#\s*aps-format[:\s]+(.+)$/);
        if (optionsMatch) {
            const optionsStr = optionsMatch[1].trim();
            result.options = parseDirectiveOptions(optionsStr);
        }

        // Stop at first non-comment, non-empty line
        if (hasActualContent(line)) {
            break;
        }
    }

    return result;
}

/**
 * Parse directive options from string like "newline=\r\n,lineWidth=120,indent=4"
 * @param {string} optionsStr - Options string
 * @returns {object} Parsed options
 */
function parseDirectiveOptions(optionsStr) {
    const options = {};
    const pairs = optionsStr.split(',');

    for (const pair of pairs) {
        const [key, value] = pair.split('=').map((s) => s.trim());
        if (!key || value === undefined) continue;

        // Parse specific option types
        switch (key.toLowerCase()) {
            case 'newline':
            case 'newlineformat':
                // Handle escaped sequences
                options.newlineFormat = value
                    .replace(/\\r\\n/g, '\r\n')
                    .replace(/\\n/g, '\n')
                    .replace(/\\r/g, '\r');
                break;

            case 'linewidth':
                const width = parseInt(value, 10);
                if (!isNaN(width)) options.lineWidth = width;
                break;

            case 'indent':
                const indent = parseInt(value, 10);
                if (!isNaN(indent) && indent > 0 && indent <= 8) options.indent = indent;
                break;

            case 'noarrayindent':
                options.noArrayIndent = value.toLowerCase() === 'true';
                break;

            case 'forcequotes':
                options.forceQuotes = value.toLowerCase() === 'true';
                break;

            case 'sortkeys':
                options.sortKeys = value.toLowerCase() === 'true';
                break;

            case 'preservecomments':
                options.preserveComments = value.toLowerCase() === 'true';
                break;

            case 'stepspacing':
                options.stepSpacing = value.toLowerCase() === 'true';
                break;

            case 'sectionspacing':
                options.sectionSpacing = value.toLowerCase() === 'true';
                break;

            case 'normalizepaths':
                options.normalizePaths = value.toLowerCase() === 'true';
                break;

            case 'expandtemplates':
                options.expandTemplates = value.toLowerCase() === 'true';
                break;
        }
    }

    return options;
}

/**
 * Validate template expressions for syntax errors (missing brackets, unbalanced parentheses, unclosed strings)
 * @param {string} line - The line containing expressions to validate
 * @param {number} lineNumber - The line number (1-based) for error reporting
 * @returns {string[]} Array of error messages
 */
function validateTemplateExpressions(line, lineNumber) {
    const hints = [];

    // Check for unmatched template expression brackets (missing }})
    let pos = 0;
    while (pos < line.length) {
        const openIdx = line.indexOf('${{', pos);
        if (openIdx === -1) break;

        const closeIdx = line.indexOf('}}', openIdx + 3);
        if (closeIdx === -1) {
            hints.push(
                `line ${lineNumber}: Missing closing '}}' for template expression starting at column ${openIdx + 1}.`
            );
            break;
        }
        pos = closeIdx + 2;
    }

    // Check for unbalanced brackets within template expressions
    const exprMatches = line.matchAll(/\$\{\{([\s\S]*?)\}\}/g);
    for (const match of exprMatches) {
        const expr = match[1];
        let parenCount = 0;
        let bracketCount = 0;
        let braceCount = 0;
        let inString = false;
        let stringChar = null;

        for (let j = 0; j < expr.length; j++) {
            const char = expr[j];

            // Handle string literals
            if (char === '"' || char === "'") {
                // In Azure Pipeline expressions, single-quoted strings are literal strings
                // where backslashes don't act as escape characters. Only check for escaped
                // quotes in double-quoted strings.
                let isEscaped = false;
                if (char === '"') {
                    // Count preceding backslashes to determine if quote is escaped
                    let backslashCount = 0;
                    let k = j - 1;
                    while (k >= 0 && expr[k] === '\\') {
                        backslashCount++;
                        k--;
                    }
                    // If odd number of backslashes, quote is escaped
                    isEscaped = backslashCount % 2 === 1;
                }

                if (!isEscaped) {
                    if (!inString) {
                        inString = true;
                        stringChar = char;
                    } else if (char === stringChar) {
                        inString = false;
                        stringChar = null;
                    }
                }
            }

            // Only count brackets outside of strings
            if (!inString) {
                if (char === '(') parenCount++;
                else if (char === ')') parenCount--;
                else if (char === '[') bracketCount++;
                else if (char === ']') bracketCount--;
                else if (char === '{') braceCount++;
                else if (char === '}') braceCount--;

                // Check for negative counts (closing before opening)
                if (parenCount < 0) {
                    hints.push(
                        `line ${lineNumber}: Unbalanced parentheses in template expression - extra closing ')' found.`
                    );
                    parenCount = 0;
                }
                if (bracketCount < 0) {
                    hints.push(
                        `line ${lineNumber}: Unbalanced brackets in template expression - extra closing ']' found.`
                    );
                    bracketCount = 0;
                }
                if (braceCount < 0) {
                    hints.push(
                        `line ${lineNumber}: Unbalanced braces in template expression - extra closing '}}' found.`
                    );
                    braceCount = 0;
                }
            }
        }

        // Check if string was never closed
        if (inString) {
            hints.push(
                `line ${lineNumber}: Unclosed string in template expression - missing closing ${stringChar} quote.`
            );
            // Skip bracket error reporting for this expression as they're misleading
            continue;
        }

        // Check for unclosed brackets
        if (parenCount > 0) {
            hints.push(
                `line ${lineNumber}: Unbalanced parentheses in template expression - missing ${parenCount} closing ')'.`
            );
        }
        if (bracketCount > 0) {
            hints.push(
                `line ${lineNumber}: Unbalanced brackets in template expression - missing ${bracketCount} closing ']'.`
            );
        }
        if (braceCount > 0) {
            hints.push(
                `line ${lineNumber}: Unbalanced braces in template expression - missing ${braceCount} closing '}'.`
            );
        }
    }

    return hints;
}

/**
 * Describe YAML syntax errors in a user-friendly way
 * @param {Error} error - The error object
 * @returns {string|undefined} A formatted error message or undefined
 */
function analyzeTemplateHints(content, conditionalDirectives = new Set()) {
    if (typeof content !== 'string' || !content.length) {
        return [];
    }

    const hints = [];
    const lines = content.split(/\r?\n/);

    // Track state for steps indentation validation
    let inJobsArray = false;
    let inJobObject = false;
    let jobPropertiesIndent = -1;
    let jobLineNumber = -1;
    let jobsIndent = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip empty lines and comments for structure validation
        if (trimmed && !trimmed.startsWith('#')) {
            const indent = line.match(/^(\s*)/)[1].length;

            // Detect jobs: block
            if (trimmed.startsWith('jobs:')) {
                inJobsArray = true;
                jobsIndent = indent;
                inJobObject = false;
                jobPropertiesIndent = -1;
            }

            // If we're in a jobs array, check for job items
            if (inJobsArray) {
                // Detect start of a job object (- job: or job: indented under each/if)
                if (trimmed.match(/^-\s+job:/) || trimmed.startsWith('job:')) {
                    inJobObject = true;
                    jobLineNumber = i + 1;
                    jobPropertiesIndent = -1;
                }

                // Detect template expressions that might contain jobs - don't track indent strictly
                const isTemplateExpr = trimmed.match(/^\$\{\{/) || trimmed.match(/^\$\[/);

                // Check if we've exited the jobs block (but exclude "jobs:" itself)
                if (
                    !isTemplateExpr &&
                    indent <= jobsIndent &&
                    trimmed.includes(':') &&
                    !trimmed.startsWith('-') &&
                    !trimmed.startsWith('${{') &&
                    !trimmed.startsWith('jobs:')
                ) {
                    inJobsArray = false;
                    inJobObject = false;
                }

                // If we're in a job, track the indentation of job properties
                if (inJobObject && !isTemplateExpr) {
                    // Common job properties to establish baseline indent
                    const jobPropertyPattern =
                        /^(displayName|dependsOn|condition|workspace|pool|strategy|timeoutInMinutes|cancelTimeoutInMinutes|variables|container|services):/;

                    if (trimmed.match(jobPropertyPattern)) {
                        if (jobPropertiesIndent === -1) {
                            jobPropertiesIndent = indent;
                        }
                    }

                    // Check for steps: at wrong indentation
                    if (trimmed.startsWith('steps:')) {
                        // If we have established the job properties indent, steps should match it
                        if (jobPropertiesIndent !== -1 && indent < jobPropertiesIndent) {
                            hints.push(
                                `line ${i + 1}: 'steps:' is not properly indented under the job.\n` +
                                    `    Expected ${jobPropertiesIndent} spaces (same as other job properties like 'displayName' or 'pool'), but found ${indent} spaces.\n` +
                                    `    The 'steps:' property must be at the same indentation level as other job properties (job starts at line ${jobLineNumber}).`
                            );
                        }
                        // Reset job tracking as we've seen steps
                        inJobObject = false;
                    }

                    // Check for implicit step items (without explicit steps: keyword)
                    // Common step types: - script:, - task:, - bash:, - pwsh:, - powershell:, - checkout:, - download:, - publish:, - template:
                    const stepItemPattern =
                        /^-\s+(script|task|bash|pwsh|powershell|checkout|download|publish|template):/;
                    if (trimmed.match(stepItemPattern)) {
                        // If we have established job properties indent, step items should match it
                        if (jobPropertiesIndent !== -1 && indent < jobPropertiesIndent) {
                            const stepType = trimmed.match(stepItemPattern)[1];
                            hints.push(
                                `line ${i + 1}: Step item '- ${stepType}:' is not properly indented under the job.\n` +
                                    `    Expected ${jobPropertiesIndent} spaces (same as other job properties like 'displayName' or 'pool'), but found ${indent} spaces.\n` +
                                    `    Step items must be at the same indentation level as other job properties (job starts at line ${jobLineNumber}).`
                            );
                        }
                        // Reset job tracking as we've seen step items (job is ending)
                        inJobObject = false;
                    }

                    // Detect if we're starting a new job (end of current job tracking)
                    // Only reset if we're currently tracking a job and see another job start
                    if (
                        inJobObject &&
                        (trimmed.match(/^-\s+job:/) ||
                            (trimmed.startsWith('job:') && jobPropertiesIndent !== -1 && indent <= jobPropertiesIndent))
                    ) {
                        // Check if this is a NEW job (not the one we just detected on line 342-346)
                        // by checking if we already have jobPropertiesIndent set
                        if (jobPropertiesIndent !== -1) {
                            inJobObject = false;
                        }
                    }
                }
            }
        }

        // Continue with existing template hint checks

        // Missing colon after an Azure expression used as a conditional/directive
        // Only warn if it looks like a directive (if/else/elseif/each) that needs a colon
        if (isStandaloneExpression(line) && !isMappingKey(line)) {
            // Check if the expression contains a conditional/directive keyword
            if (containsConditionalKeyword(line)) {
                const exprExample = '- ${{ if ... }}:';
                hints.push(`line ${i + 1}: Add ':' after the expression (e.g., '${exprExample}').`);
            }
        }

        // else if vs elseif typo
        if (hasElseIfTypo(line)) {
            hints.push(`line ${i + 1}: Use 'elseif' instead of 'else if' in Azure expressions.`);
        }

        // Missing comma inside common functions (eq/ne/contains/startsWith/endsWith)
        const fnMatch = line.match(/\b(eq|ne|contains|startsWith|endsWith)\s*\(([^)]*)\)/i);
        if (fnMatch) {
            const args = fnMatch[2];
            const hasComma = args.includes(',');
            const spacedArgs = args.trim().split(/\s+/);
            if (!hasComma && spacedArgs.length >= 2) {
                hints.push(`line ${i + 1}: Add a comma between arguments (e.g., ${fnMatch[1]}(a, b)).`);
            }
        }

        // Leading dash missing for list entries with expressions
        // Only warn if this is actually a list item context:
        // Leading dash missing for list entries with expressions
        // Warn if:
        // - Current line is an expression (e.g., ${{ if ... }}:) without a leading dash
        // - Previous non-blank line is a list item OR next non-blank line is a list item at same indent
        // - Current line is NOT more indented than the previous list item (which would make it nested content)
        // - BUT: Exclude conditional directives (if/elseif/else/each/insert) which are object keys (not in list context)
        if (isExpressionWithColon(trimmed) && !trimmed.startsWith('-')) {
            let isListContext = false;
            const currentIndent = getIndent(line);

            // Check previous non-blank line
            for (let j = i - 1; j >= 0; j--) {
                const prevLine = lines[j];
                if (!isBlank(prevLine)) {
                    if (isListItem(prevLine)) {
                        const prevIndent = getIndent(prevLine);
                        // Only warn if at SAME indent (sibling), not less (parent level)
                        if (currentIndent === prevIndent) {
                            isListContext = true;
                        }
                    }
                    break;
                }
            }

            // If not found in previous, check next non-blank line
            if (!isListContext) {
                for (let j = i + 1; j < lines.length; j++) {
                    const nextLine = lines[j];
                    if (!isBlank(nextLine)) {
                        if (isListItem(nextLine)) {
                            const nextIndent = getIndent(nextLine);
                            // Warn if next line is a list item at same indent (sibling)
                            if (currentIndent === nextIndent) {
                                isListContext = true;
                            }
                        }
                        break;
                    }
                }
            }

            // Only warn if in list context, OR if not a conditional directive
            // Conditional directives used as object keys (not in list context) don't need dashes
            if (isListContext || !isConditionalDirective(trimmed, conditionalDirectives)) {
                if (isListContext) {
                    const exprExample = '- ${{ if ... }}:';
                    hints.push(`line ${i + 1}: Prepend '-' for list items using expressions (e.g., '${exprExample}').`);
                }
            }
        }

        // Validate template expressions on this line
        const expressionHints = validateTemplateExpressions(line, i + 1);
        hints.push(...expressionHints);
    }

    return hints;
}

function describeYamlSyntaxError(error, content) {
    if (!error || typeof error !== 'object') {
        return undefined;
    }

    const isYamlError = error.name === 'YAMLException' || error.name === 'YAMLError';
    if (!isYamlError && error.name && typeof error.name === 'string' && !error.name.includes('YAML')) {
        return undefined;
    }

    const reason = typeof error.reason === 'string' && error.reason.trim().length ? error.reason.trim() : undefined;
    const baseMessage = reason || (typeof error.message === 'string' ? error.message.trim() : undefined);

    // Allow "duplicated mapping key" errors for Azure Pipeline expressions
    // like ${{ insert }}, ${{ parameters.x }}, etc. which are valid at runtime
    if (baseMessage && baseMessage.includes('duplicated mapping key')) {
        // Check if this might be an expression key
        const snippet = error.snippet || '';
        if (snippet.includes('${{') || (error.mark && error.mark.snippet && error.mark.snippet.includes('${{'))) {
            // This is likely a valid Azure Pipelines expression with duplicate keys
            return undefined;
        }
    }

    const mark = error.mark && typeof error.mark === 'object' ? error.mark : undefined;
    const hasLine = mark && Number.isInteger(mark.line);
    const hasColumn = mark && Number.isInteger(mark.column);

    const lineText = hasLine ? `line ${mark.line + 1}` : undefined;
    const columnText = hasColumn ? `column ${mark.column + 1}` : undefined;
    const location = lineText && columnText ? `${lineText}, ${columnText}` : lineText || columnText;

    const hints = analyzeTemplateHints(content);

    // Specific friendly rewrites for common Azure expression mistakes
    const lowerReason = (baseMessage || '').toLowerCase();
    if (baseMessage) {
        if (lowerReason.includes('implicit map key') || lowerReason.includes('mapping values are not allowed')) {
            hints.unshift("Likely missing a ':' after an Azure expression used as a key (e.g., '- ${{ if ... }}:').");
        } else if (lowerReason.includes('bad indentation') || lowerReason.includes('incomplete explicit mapping')) {
            hints.unshift("Check indentation for list items and make sure expression lines start with '-'.");
        }
    }

    let message;
    if (location && baseMessage) {
        message = `YAML syntax error at ${location}: ${baseMessage}`;
    } else if (baseMessage) {
        message = `YAML syntax error: ${baseMessage}`;
    } else if (location) {
        message = `YAML syntax error at ${location}.`;
    }

    if (message && hints.length) {
        message += `\n  ${hints.join('\n')}`;
    }

    return message;
}

/**
 * Find the next non-blank line index starting from the given index.
 * @param {string[]} lines - Array of lines
 * @param {number} startIndex - Index to start searching from
 * @returns {number|null} Index of next non-blank line, or null if none found
 */
function findNextNonBlankLine(lines, startIndex) {
    for (let i = startIndex; i < lines.length; i++) {
        if (!isBlank(lines[i])) {
            return i;
        }
    }
    return null;
}

// Detects whether a root-level key represents a main pipeline section
function isMainSectionKey(keyWithColon) {
    return keyWithColon === 'steps:' || keyWithColon === 'stages:' || keyWithColon === 'jobs:';
}

// Checks if a trimmed line ends with a colon (key indicator)
function isMappingKey(line) {
    if (!line || typeof line !== 'string') {
        return false;
    }
    return line.trim().endsWith(':');
}

function isComment(line) {
    if (!line || typeof line !== 'string') {
        return false;
    }
    const trimmed = line.trim();
    return trimmed.startsWith('#');
}

// Checks if a line is a YAML list item (starts with dash and space)
function isListItem(line) {
    if (!line || typeof line !== 'string') {
        return false;
    }
    const trimmed = line.trim();
    return /^\s*-\s/.test(trimmed);
}

// Checks if a line or trimmed line is blank (empty string)
function isBlank(line) {
    if (!line || typeof line !== 'string') {
        return true;
    }
    return line.trim() === '';
}

// Checks if a trimmed line has actual content (not blank and not a comment)
function hasActualContent(line) {
    return !isBlank(line) && !isComment(line);
}

// Checks if a trimmed line is blank or contains only a comment
function isBlankOrCommentLine(line) {
    return isBlank(line) || isComment(line);
}

/**
 * Checks if a trimmed line is non-empty and not a comment (assumes input is already trimmed)
 * @param {string} trimmedLine - The trimmed line to check
 * @returns {boolean} True if the line has content, false otherwise
 */
function isNonCommentContent(trimmedLine) {
    return trimmedLine && !trimmedLine.startsWith('#');
}

// Checks if a line is a list item that starts with an Azure expression (for e.g - ${{ parameters.preSteps }})
function isExpressionListItem(line) {
    return /^\s*-\s+\$\{\{.*\}\}:?/.test(line);
}

// Checks if a line is a conditional list item (if/else/elseif/each)
function isConditionalListItem(line) {
    return /^-\s+\$\{\{\s*(if|else|elseif|each)\s/.test(line);
}

// Checks if a line contains an Azure template expression marker
function containsTemplateExpression(text) {
    return typeof text === 'string' && text.includes('${{');
}

// Checks if text contains conditional keywords (if/else/elseif/each)
function containsConditionalKeyword(text) {
    return /\$\{\{\s*(if|else|elseif|each)\s/.test(text);
}

// Checks if trimmed line has 'else if' typo instead of 'elseif'
function hasElseIfTypo(line) {
    const trimmed = line.trim();
    return /\belse\s+if\b/i.test(trimmed);
}

// Checks if trimmed line is a standalone expression (with optional dash, ending without colon)
function isStandaloneExpression(line) {
    const trimmed = line.trim();
    return /^-?\s*\$\{\{[^}]+\}\}\s*$/.test(trimmed);
}

// Checks if trimmed line is an expression with colon (without leading dash)
function isExpressionWithColon(trimmed) {
    return /^\$\{\{[^}]+\}\}\s*:/.test(trimmed) || /^__EXPR_PLACEHOLDER_\d+__\s*:/.test(trimmed);
}

// Checks if a line starts a multi-line scalar block (| or > indicators)
function startsMultiLineScalarBlock(line) {
    return /:\s*[|>][-+]?\s*$/.test(line);
}

function getIndent(text) {
    return text.length - text.trimStart().length;
}

function getBooleanOption(options, key, defaultValue) {
    return options && typeof options[key] === 'boolean' ? options[key] : defaultValue;
}

function getClampedIntegerOption(options, key, max, defaultValue) {
    if (!options || !Number.isInteger(options[key]) || options[key] < 0) {
        return defaultValue;
    }
    return Math.min(options[key], max);
}

function getBetweenSectionBlankLines(options) {
    const primary = getClampedIntegerOption(options, 'betweenSectionBlankLines', 4, null);
    if (primary !== null) {
        return primary;
    }

    const alias = getClampedIntegerOption(options, 'blankLinesBetweenSections', 4, null);
    return alias !== null ? alias : 1;
}

function getNewlineFormat(options) {
    const value = options && typeof options.newlineFormat === 'string' ? options.newlineFormat : null;
    return value === '\n' || value === '\r\n' ? value : '\n';
}

function getLineWidth(options) {
    if (options && typeof options.lineWidth === 'number' && options.lineWidth >= 0) {
        return options.lineWidth === 0 ? -1 : options.lineWidth;
    }
    return -1;
}

function getIndentOption(options) {
    if (options && Number.isInteger(options.indent) && options.indent > 0 && options.indent <= 8) {
        return options.indent;
    }
    return 2;
}

const stepPattern =
    /^\s*-\s+(task|bash|powershell|pwsh|script|sh|checkout|download|downloadBuild|getPackage|publish|reviewApp|template):/;

function isStepOrExpressionListItem(line) {
    return stepPattern.test(line) || isExpressionListItem(line);
}

/**
 * Handle comment line spacing rules (trailing comments, step comments)
 * @param {object} state - The formatting state object
 */
function handleCommentLine(state) {
    const { lineNum, inMultiLineBlock, pass1, currentSection, stepSpacingSections, lines } = state;
    const line = lines[lineNum];
    const index = lineNum;
    // Keep comments inside multi-line scalars untouched
    if (inMultiLineBlock) {
        pass1.push(line);
        return true;
    }

    // Detect trailing comment blocks (no content after)
    let isTrailingComment = true;
    for (let j = index + 1; j < lines.length; j++) {
        if (hasActualContent(lines[j])) {
            isTrailingComment = false;
            break;
        }
    }

    if (isTrailingComment) {
        // Only add a blank if there was prior content and none already
        let hasContentBefore = false;
        for (let j = pass1.length - 1; j >= 0; j--) {
            if (hasActualContent(pass1[j])) {
                hasContentBefore = true;
                break;
            }
        }

        if (hasContentBefore) {
            const lastLine = pass1.length > 0 ? pass1[pass1.length - 1] : null;
            if (lastLine && !isBlank(lastLine)) {
                pass1.push('');
            }
        }
    } else if (currentSection === 'steps' || stepSpacingSections.includes(currentSection)) {
        // Add blank before a comment in steps only when there is preceding content
        // (avoid inserting a blank right after the section header)
        const lastLine = pass1.length > 0 ? pass1[pass1.length - 1] : null;
        const lastTrimmed = lastLine ? lastLine.trim() : '';
        const lastIsHeader = lastTrimmed === 'steps:' || lastTrimmed === 'jobs:' || lastTrimmed === 'stages:';

        if (lastLine && !isBlank(lastLine) && !lastIsHeader) {
            pass1.push('');
        }
    }

    pass1.push(line);
    return true;
}

// Find previous non-blank line in an array
function findPreviousNonBlankLine(arr, startIndex) {
    for (let idx = startIndex; idx >= 0; idx--) {
        if (!isBlank(arr[idx])) {
            return idx;
        }
    }
    return null;
}

/**
 * Handle blank line processing with context-aware rules
 */
function handleBlankLine(state) {
    const {
        pass1,
        inMultiLineBlock,
        currentSection,
        stepSpacingSections,
        listItemSpacingSections,
        prevWasComment,
        lineNum,
        lines,
    } = state;

    const nextNonBlank = findNextNonBlankLine(lines, lineNum + 1);
    if (nextNonBlank === null) {
        return { continue: true, prevWasComment: false };
    }

    // Drop blanks in parameters/variables outright
    if (!inMultiLineBlock && (currentSection === 'parameters' || currentSection === 'variables')) {
        return { continue: true, prevWasComment: false };
    }

    // Preserve blanks inside multi-line scalars as empty strings
    if (inMultiLineBlock) {
        pass1.push('');
        return { continue: true, prevWasComment: false };
    }

    const nextLineIndent = getIndent(lines[nextNonBlank]);
    let keepBlank = false;

    // Find previous non-blank in already-built output
    const prevIdx = findPreviousNonBlankLine(pass1, pass1.length - 1);
    const prevLine = prevIdx !== null ? pass1[prevIdx] : null;

    if (prevLine) {
        const prevIndent = getIndent(prevLine);
        const prevTrimmed = prevLine.trim();

        if (prevIndent === 0 && isMainSectionKey(prevTrimmed)) {
            keepBlank = true;
        } else if (prevWasComment) {
            keepBlank = true;
        } else if (currentSection === 'variables') {
            keepBlank = false;
        } else if (currentSection === 'steps' || stepSpacingSections.includes(currentSection)) {
            const isPrevComment = isComment(prevLine);
            const isNextList = isListItem(lines[nextNonBlank]);
            keepBlank = !(isPrevComment && isNextList);
        } else if (listItemSpacingSections.includes(currentSection)) {
            if (nextLineIndent === 0 || nextLineIndent === 2) {
                keepBlank = true;
            }
        }
    }

    // Trailing comments: keep exactly one blank before the trailing block
    if (keepBlank && isComment(lines[nextNonBlank])) {
        let hasContentBefore = false;
        let lastContentIndex = -1;
        for (let j = pass1.length - 1; j >= 0; j--) {
            if (hasActualContent(pass1[j])) {
                hasContentBefore = true;
                lastContentIndex = j;
                break;
            }
            if (isBlankOrCommentLine(pass1[j])) break;
        }

        if (hasContentBefore) {
            let hasContentAfter = false;
            for (let j = nextNonBlank; j < lines.length; j++) {
                if (hasActualContent(lines[j])) {
                    hasContentAfter = true;
                    break;
                }
            }

            if (!hasContentAfter) {
                let blankCount = 0;
                for (let j = lastContentIndex + 1; j < pass1.length; j++) {
                    if (isBlank(pass1[j])) {
                        blankCount++;
                    }
                }

                if (blankCount >= 1) {
                    keepBlank = false;
                }
            }
        }
    }

    if (keepBlank) {
        pass1.push(lines[lineNum]);
    }

    return { continue: true, prevWasComment: false };
}

/**
 * Handle step spacing logic for pipeline items
 */
function handleStepSpacing(state) {
    const {
        pass1,
        lastStepInStepsSection,
        inMultiLineBlock,
        variablesIndent,
        startsMultiLineBlock,
        lineIndent,
        lineNum,
        lines,
    } = state;
    const line = lines[lineNum];
    const trimmed = line.trim();

    // Track when we're in steps/jobs/stages sections
    let listSectionIndent = -1;

    if (isMainSectionKey(trimmed)) {
        if (!containsTemplateExpression(line)) {
            listSectionIndent = lineIndent;
        }
    } else if (listSectionIndent >= 0 && lineIndent <= listSectionIndent && isNonCommentContent(trimmed)) {
        // We've outdented past the section
        if (!isMainSectionKey(trimmed)) {
            listSectionIndent = -1;
        }
    }

    // Check if current line is a list item (starts with -)
    const isListEntry = isListItem(line);
    const isConditional = isConditionalListItem(line);
    const isPipelineItem = isListEntry && !isConditional && isStepOrExpressionListItem(line);
    const isRootLevelConditional = isConditional && lastStepInStepsSection >= 0;

    // Items in variables section are list items (starting with -) at the same indent as variables:
    const inVariablesSection = variablesIndent >= 0 && lineIndent === variablesIndent && isListEntry;

    // Check if previous line was a conditional or section header
    const prevLine = pass1.length > 0 ? pass1[pass1.length - 1].trim() : '';
    const prevIsConditional = isConditionalListItem(prevLine);
    const prevIsSectionHeader = isMainSectionKey(prevLine);

    // Add blank line before pipeline items OR root-level conditionals if appropriate
    const wasAlreadyInMultiLineBlock = inMultiLineBlock && !startsMultiLineBlock;

    if (
        (isPipelineItem || isRootLevelConditional) &&
        lastStepInStepsSection >= 0 &&
        !prevIsSectionHeader &&
        !prevIsConditional &&
        !wasAlreadyInMultiLineBlock &&
        !inVariablesSection
    ) {
        if (pass1.length > 0 && !isBlank(pass1[pass1.length - 1])) {
            pass1.push('');
        }
    }

    return { isPipelineItem };
}

/**
 * Handle section spacing for first block and between sections
 */
function handleSectionSpacing(state) {
    const {
        pass1,
        options,
        hasParametersAtStart,
        parametersEnded,
        firstNonEmptyLine,
        foundFirstSection,
        foundFirstMainSection,
        lastRootSectionIndex,
        topLevelSections,
        lineNum,
        lines,
    } = state;
    const line = lines[lineNum];
    const trimmed = line.trim();

    let section2HandledThisLine = false;
    let newParametersEnded = parametersEnded;
    let newFoundFirstSection = foundFirstSection;
    let newFoundFirstMainSection = foundFirstMainSection;

    // 2. First Block Blank Lines (skip for expanded output to preserve original spacing)
    if (hasParametersAtStart && !options.wasExpanded) {
        if (!parametersEnded && lineNum > firstNonEmptyLine) {
            if (!isComment(line) && !isListItem(line) && getIndent(line) === 0 && isMappingKey(line)) {
                newParametersEnded = true;
            }
        }

        if (newParametersEnded && !foundFirstSection && topLevelSections.some((s) => trimmed === s)) {
            newFoundFirstSection = true;
            section2HandledThisLine = true;
            const keyOnly = trimmed.includes(':') ? trimmed.substring(0, trimmed.indexOf(':') + 1).trim() : trimmed;
            if (isMainSectionKey(keyOnly)) {
                newFoundFirstMainSection = true;
            }
            // Remove existing blanks
            while (pass1.length > 0 && isBlank(pass1[pass1.length - 1])) {
                pass1.pop();
            }
            // Add required blanks
            for (let k = 0; k < options.firstBlockBlankLines; k++) {
                pass1.push('');
            }
        }
    }

    // 3. Section Spacing (betweenSectionBlankLines and firstBlockBlankLines)
    const isRootSection = !isComment(line) && !isListItem(line) && getIndent(line) === 0 && isMappingKey(line);

    let newLastRootSectionIndex = lastRootSectionIndex;
    if (isRootSection && lastRootSectionIndex >= 0 && !section2HandledThisLine && !options.wasExpanded) {
        // Remove existing blanks before this section
        while (pass1.length > 0 && isBlank(pass1[pass1.length - 1])) {
            pass1.pop();
        }

        const keyOnly = trimmed.includes(':') ? trimmed.substring(0, trimmed.indexOf(':') + 1).trim() : trimmed;
        const isMainSection = isMainSectionKey(keyOnly);
        const isFirstMainSection =
            isMainSection && !newFoundFirstMainSection && hasParametersAtStart && newParametersEnded;

        if (isFirstMainSection) {
            newFoundFirstMainSection = true;
            newFoundFirstSection = true;
        }

        // Determine blank lines to add
        let blankLinesToAdd;
        if (isFirstMainSection) {
            blankLinesToAdd = options.firstBlockBlankLines;
        } else if (isMainSection) {
            blankLinesToAdd = 1;
        } else {
            blankLinesToAdd = options.betweenSectionBlankLines;
        }

        for (let k = 0; k < blankLinesToAdd; k++) {
            pass1.push('');
        }
    }
    if (isRootSection) {
        newLastRootSectionIndex = pass1.length;
    }

    return {
        section2HandledThisLine,
        parametersEnded: newParametersEnded,
        foundFirstSection: newFoundFirstSection,
        foundFirstMainSection: newFoundFirstMainSection,
        lastRootSectionIndex: newLastRootSectionIndex,
    };
}

/**
 * Compact blank lines between list items (except in steps/jobs/stages)
 */
function compactBlankLines(pass1, newline) {
    const compacted = [];
    const sectionStack = [];
    const mainListSections = new Set(['steps', 'jobs', 'stages']);
    const nestedListSections = new Set(['dependsOn', 'parameters', 'variables']);

    for (let i = 0; i < pass1.length; i++) {
        const line = pass1[i];
        const indent = getIndent(line);

        // Maintain a simple section stack keyed by indent for the nearest mapping header
        // Don't pop the stack when processing list items, blank lines, or comments - they are children/decorators of sections
        if (!isListItem(line) && !isBlank(line) && !isComment(line)) {
            while (sectionStack.length && sectionStack[sectionStack.length - 1].indent >= indent) {
                sectionStack.pop();
            }
        }
        // Only track sections at indent 0 (root level) or nested list-containing sections
        if (!isListItem(line) && isMappingKey(line)) {
            const sectionName = line.trim().slice(0, -1);
            // Only push sections at root level (indent 0) or known nested list sections
            if (indent === 0 || nestedListSections.has(sectionName)) {
                sectionStack.push({ name: sectionName, indent });
            }
        }

        if (isBlank(line)) {
            const prevIdx = findPreviousNonBlankLine(pass1, i - 1);
            const nextIdx = findNextNonBlankLine(pass1, i + 1);

            if (prevIdx !== null && nextIdx !== null) {
                const prevLine = pass1[prevIdx];
                const nextLine = pass1[nextIdx];
                if (isMappingKey(prevLine)) {
                    continue;
                }
                const prevIsList = isListItem(prevLine);
                const nextIsList = isListItem(nextLine);
                const currentSection = sectionStack.length ? sectionStack[sectionStack.length - 1].name : null;
                const insideMainListSection = currentSection && mainListSections.has(currentSection);

                // If the next line is a list item and we're in a nested mapping section (variables/parameters/etc),
                // find the nearest previous list item (skipping over value continuations)
                let effectivePrevIsList = prevIsList;
                if (nextIsList && !insideMainListSection && !prevIsList) {
                    // Look back to find the last list item
                    const nextIndent = getIndent(nextLine);
                    for (let j = prevIdx - 1; j >= 0; j--) {
                        if (!isBlank(pass1[j])) {
                            if (isListItem(pass1[j])) {
                                effectivePrevIsList = true;
                                break;
                            }
                            // If we hit a line at the same indent as the next list item (or less), check if it's structural
                            const jIndent = getIndent(pass1[j]);
                            if (jIndent <= nextIndent && isMappingKey(pass1[j]) && !isListItem(pass1[j])) {
                                // This is a section header, stop looking
                                break;
                            }
                            // Otherwise continue looking back (we might be in nested mapping children)
                        }
                    }
                }

                // Remove blanks between sibling list items in nested sections (dependsOn, variables, parameters, etc)
                // Keep blanks between sibling list items in main sections (steps, jobs, stages)
                if (effectivePrevIsList && nextIsList && !insideMainListSection) {
                    continue;
                }
            }
        }

        compacted.push(line);
    }

    return compacted;
}

/**
 * Insert blank lines between step items if stepSpacing is enabled
 */
function insertStepSpacing(lines, conditionalDirectiveExpressions = new Set()) {
    const insertPositions = [];
    const removePositions = []; // Track blanks to remove (between parent and child)
    const sectionStack = [];
    let inMultiLineBlock = false;
    let multiLineBlockIndent = -1;
    const mainListSections = new Set(['steps', 'jobs', 'stages']);
    // Track mapping keys that have child lists (like dependsOn:, parameters:, etc.)
    // When we're inside such a mapping, we DON'T add blanks between list items
    let insideNestedMapping = false;
    let nestedMappingIndent = -1;
    // Track current section to avoid creating implicit spacing in variables/parameters
    let currentSection = null;
    // Track if we're inside variables/parameters sections where we don't want ANY spacing
    let insideVariablesOrParameters = false;
    let variablesParametersIndent = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const indent = getIndent(line);
        const trimmed = line.trim();

        // Save the multiline block state BEFORE processing this line
        // This is needed because a line that STARTS a multiline block should still be processed for spacing
        const wasInMultiLineBlock = inMultiLineBlock;

        // Track current section at root level
        // IMPORTANT: Don't treat list items as sections, even if they look like mapping keys after trimming
        if (indent === 0 && !isBlank(line) && !isListItem(line) && isMappingKey(trimmed)) {
            currentSection = trimmed.slice(0, -1);
            // Mark if we're entering variables or parameters sections
            if (currentSection === 'variables' || currentSection === 'parameters') {
                insideVariablesOrParameters = true;
                variablesParametersIndent = indent;
            } else {
                insideVariablesOrParameters = false;
                variablesParametersIndent = -1;
            }
        }

        // Exit variables/parameters section when we encounter another root-level section
        // IMPORTANT: Only mapping keys can be sections, not list items
        if (insideVariablesOrParameters && indent === 0 && !isListItem(line) && isMappingKey(trimmed)) {
            const sectionName = trimmed.slice(0, -1);
            if (sectionName !== 'variables' && sectionName !== 'parameters') {
                insideVariablesOrParameters = false;
                variablesParametersIndent = -1;
            }
        }

        // Track multi-line block state
        if (startsMultiLineScalarBlock(line)) {
            inMultiLineBlock = true;
            multiLineBlockIndent = indent;
        } else if (inMultiLineBlock && !isBlank(line) && indent <= multiLineBlockIndent) {
            inMultiLineBlock = false;
            multiLineBlockIndent = -1;
        }

        // If this line ends a multi-line block, treat it as NOT being in the block for spacing purposes
        const effectivelyInMultiLineBlock = wasInMultiLineBlock && inMultiLineBlock;

        // Exit nested mapping context if we're at an indent less than the mapping,
        // or at the same indent but NOT a list item (e.g., another mapping key)
        if (insideNestedMapping && !isBlank(line)) {
            if (indent < nestedMappingIndent || (indent === nestedMappingIndent && !isListItem(line))) {
                insideNestedMapping = false;
                nestedMappingIndent = -1;
            }
        }

        // Maintain section stack (only for content outside multi-line blocks)
        if (!effectivelyInMultiLineBlock && !isBlank(line)) {
            if (!isListItem(line)) {
                while (sectionStack.length && sectionStack[sectionStack.length - 1].indent >= indent) {
                    // Don't pop implicit sections
                    if (sectionStack[sectionStack.length - 1].implicit) {
                        break;
                    }
                    sectionStack.pop();
                }
            }
            if (!isListItem(line) && isMappingKey(line)) {
                const sectionName = trimmed.slice(0, -1);
                if (mainListSections.has(sectionName)) {
                    sectionStack.push({ name: sectionName, indent });
                } else if (sectionStack.length > 0 && !containsTemplateExpression(line) && !insideNestedMapping) {
                    // This is a regular mapping key inside a main section (like dependsOn:, parameters:, etc.)
                    // Mark that we're inside a nested mapping context
                    // Only set this for the FIRST nested mapping level to avoid overwriting with deeper nested keys
                    insideNestedMapping = true;
                    nestedMappingIndent = indent;
                }
            }
        }

        // Check for list items; handle spacing and blank removal
        // This block runs for all list items to handle blank removal even inside nested contexts
        if (!effectivelyInMultiLineBlock && isListItem(line)) {
            const listItemIndent = indent;

            // ALWAYS check if there are blank lines after this list item followed by a child
            // This is important even when insideNestedMapping is true, because we need to
            // remove blanks between parent list items and their children
            let nextNonBlankIdx = -1;
            let blankIndices = [];
            for (let j = i + 1; j < lines.length; j++) {
                if (isBlank(lines[j])) {
                    blankIndices.push(j);
                } else {
                    nextNonBlankIdx = j;
                    break;
                }
            }

            // If we found blanks followed by a non-blank line
            if (blankIndices.length > 0 && nextNonBlankIdx > 0) {
                const nextNonBlankLine = lines[nextNonBlankIdx];
                const nextLineIndent = getIndent(nextNonBlankLine);

                // If the next non-blank line is a child (indented more), remove ALL blanks before it
                if (nextLineIndent > listItemIndent) {
                    for (const blankIdx of blankIndices) {
                        removePositions.push(blankIdx);
                    }
                }
            }

            // Only process spacing logic when NOT in nested mapping mode AND NOT in variables/parameters
            if (!insideNestedMapping && !insideVariablesOrParameters) {
                // Find the NEAREST main list section that could contain this item
                // We want the one with the highest indent that's still a main section
                let insideMainSection = false;
                for (let s = sectionStack.length - 1; s >= 0; s--) {
                    if (mainListSections.has(sectionStack[s].name)) {
                        insideMainSection = true;
                        break;
                    }
                }

                // Also treat top-level list items with template expressions or stage/job children as being in stages section
                // BUT not if we're under variables or parameters sections
                if (
                    !insideMainSection &&
                    indent === 0 &&
                    currentSection !== 'variables' &&
                    currentSection !== 'parameters'
                ) {
                    // Check if this looks like a stage/job item (has template expression or stage/job child)
                    let shouldAddImplicitSection = false;

                    if (containsTemplateExpression(trimmed)) {
                        shouldAddImplicitSection = true;
                    } else {
                        // Check first non-blank child
                        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
                            if (!isBlank(lines[j])) {
                                const childLine = lines[j].trim();
                                const childIndent = getIndent(lines[j]);
                                if (childIndent > indent && childLine.match(/^-\s+(stage|job|task):/)) {
                                    shouldAddImplicitSection = true;
                                }
                                break;
                            }
                        }
                    }

                    if (shouldAddImplicitSection) {
                        // Only add implicit section once
                        const hasImplicitSection = sectionStack.some((s) => s.implicit);
                        if (!hasImplicitSection) {
                            sectionStack.push({ name: 'stages', indent: -1, implicit: true });
                        }
                        insideMainSection = true;
                    }
                }

                if (insideMainSection) {
                    // Find next sibling list item at same indent
                    let nextItemIdx = null;
                    for (let j = i + 1; j < lines.length; j++) {
                        if (isBlank(lines[j])) continue;

                        const nextIndent = getIndent(lines[j]);
                        const isNextList = isListItem(lines[j]);

                        if (isNextList && nextIndent === listItemIndent) {
                            nextItemIdx = j;
                            break;
                        }

                        // Stop if we encounter a list item at LOWER indent - it starts a new hierarchy branch
                        // and any items after it are not siblings of the current item
                        if (isNextList && nextIndent < listItemIndent) {
                            break;
                        }

                        // Stop if we encounter a line at same or lower indent that's not a list item
                        if (nextIndent <= listItemIndent && !isNextList) {
                            break;
                        }
                    }

                    if (nextItemIdx !== null) {
                        // Don't add blank if the next item is a child (indented more than current)
                        // This check is redundant since we only set nextItemIdx for same indent,
                        // but kept for clarity
                        const nextItemIndent = getIndent(lines[nextItemIdx]);
                        if (nextItemIndent === listItemIndent) {
                            // Check if there's a blank line immediately before the next sibling
                            let hasBlankBefore = false;
                            for (let k = nextItemIdx - 1; k >= 0; k--) {
                                if (isBlank(lines[k])) {
                                    hasBlankBefore = true;
                                    break;
                                }
                                if (!isBlank(lines[k])) {
                                    break;
                                }
                            }
                            if (!hasBlankBefore) {
                                insertPositions.push(nextItemIdx);
                            }
                        }
                    }
                }
            }
        }
    }

    // First remove blanks that are between parent and child (in reverse order to maintain indices)
    let result = [...lines];
    for (const idx of Array.from(new Set(removePositions)).sort((a, b) => b - a)) {
        result.splice(idx, 1);
    }

    // Then insert blanks between siblings (adjust indices if we removed any)
    // Note: after removal, we need to recalculate insert positions
    const adjustedInsertPositions = insertPositions.map((pos) => {
        let adjusted = pos;
        for (const removePos of removePositions) {
            if (removePos < pos) {
                adjusted--;
            }
        }
        return adjusted;
    });

    for (const idx of Array.from(new Set(adjustedInsertPositions)).sort((a, b) => b - a)) {
        result.splice(idx, 0, '');
    }
    return result;
}

/**
 * Initialize the formatting state for pipeline processing
 */
function initializeFormattingState(lines, options) {
    const topLevelSections = ['stages:', 'jobs:', 'steps:', 'trigger:', 'pr:', 'resources:', 'pool:', 'variables:'];
    let hasParametersAtStart = false;
    let firstNonEmptyLine = -1;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (isNonCommentContent(trimmed)) {
            firstNonEmptyLine = i;
            hasParametersAtStart = trimmed === 'parameters:';
            break;
        }
    }

    return {
        options: options,
        lines,
        stepSpacingSections: ['steps'],
        listItemSpacingSections: ['stages', 'jobs'],
        topLevelSections,
        hasParametersAtStart,
        firstNonEmptyLine,
        pass1: [],
        currentSection: null,
        prevWasComment: false,
        lastStepInStepsSection: -1,
        variablesIndent: -1,
        inMultiLineBlock: false,
        multiLineBlockIndent: -1,
        foundFirstSection: false,
        foundFirstMainSection: false,
        parametersEnded: false,
        lastRootSectionIndex: -1,
        lineNum: -1,
        lineIndent: 0,
        startsMultiLineBlock: false,
    };
}

/**
 * Update multi-line block tracking state
 */
function updateMultiLineBlockState(state) {
    const { lines, lineNum, lineIndent } = state;
    const line = lines[lineNum];
    const trimmed = line.trim();
    const startsMultiLineBlock = startsMultiLineScalarBlock(line);

    if (startsMultiLineBlock) {
        state.inMultiLineBlock = true;
        state.multiLineBlockIndent = lineIndent;
    } else if (state.inMultiLineBlock && lineIndent <= state.multiLineBlockIndent && trimmed !== '') {
        state.inMultiLineBlock = false;
        state.multiLineBlockIndent = -1;
    }

    return startsMultiLineBlock;
}

/**
 * Update variables section tracking state
 */
function updateVariablesSection(state) {
    const { lines, lineNum, lineIndent } = state;
    const line = lines[lineNum];
    const trimmed = line.trim();
    if (trimmed === 'variables:' && !containsTemplateExpression(line)) {
        state.variablesIndent = lineIndent;
    } else if (state.variablesIndent >= 0 && isNonCommentContent(trimmed)) {
        if (lineIndent < state.variablesIndent) {
            state.variablesIndent = -1;
        } else if (lineIndent === state.variablesIndent) {
            if (isMappingKey(trimmed) && trimmed !== 'variables:') {
                state.variablesIndent = -1;
            }
        }
    }
}

/**
 * Apply pipeline-specific formatting rules to the YAML output.
 * This handles step spacing, section spacing, and blank line management.
 * @param {string} text - The YAML text to format
 * @param {string} newline - The newline character(s) to use
 * @param {object} options - Formatting options
 * @returns {string} The formatted text
 */
function applyPipelineFormatting(text, newline, options) {
    if (!text) return text;

    const lines = text.split(newline);
    const state = initializeFormattingState(lines, options);

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const trimmed = line.trim();
        const lineIndent = getIndent(line);

        // Update state with current iteration values
        state.lineNum = lineNum;
        state.lineIndent = lineIndent;

        // Track the current root section
        if (lineIndent === 0 && isNonCommentContent(trimmed) && isMappingKey(trimmed)) {
            state.currentSection = trimmed.slice(0, -1);
        }

        // Handle blank lines
        if (isBlank(line)) {
            const result = handleBlankLine(state);
            if (result.continue) {
                state.prevWasComment = result.prevWasComment;
                continue;
            }
        }

        // Update multi-line block and variables section tracking
        const startsMultiLineBlock = updateMultiLineBlockState(state);
        state.startsMultiLineBlock = startsMultiLineBlock;
        updateVariablesSection(state);

        // Handle step spacing
        if (options.stepSpacing && !options.wasExpanded) {
            const stepResult = handleStepSpacing(state);

            if (stepResult.isPipelineItem) {
                state.lastStepInStepsSection = state.lineNum;
            } else if (isMainSectionKey(trimmed) && !containsTemplateExpression(line)) {
                state.lastStepInStepsSection = -1;
            }
        }

        // Handle section spacing
        const sectionResult = handleSectionSpacing(state);
        state.parametersEnded = sectionResult.parametersEnded;
        state.foundFirstSection = sectionResult.foundFirstSection;
        state.foundFirstMainSection = sectionResult.foundFirstMainSection;
        state.lastRootSectionIndex = sectionResult.lastRootSectionIndex;

        // Ensure blank before jobs:/steps: at non-root levels
        const isJobsOrSteps = trimmed === 'jobs:' || trimmed === 'steps:';
        if (isJobsOrSteps && lineIndent > 0 && !sectionResult.section2HandledThisLine && !options.wasExpanded) {
            if (state.pass1.length === 0 || !isBlank(state.pass1[state.pass1.length - 1])) {
                state.pass1.push('');
            }
        }

        // Handle comments
        if (isComment(line)) {
            handleCommentLine(state);
            state.prevWasComment = true;
            continue;
        }

        // Add non-blank line
        state.pass1.push(line);
        state.prevWasComment = false;

        // Skip blank lines immediately after mapping keys
        if (isMappingKey(trimmed)) {
            while (lineNum + 1 < lines.length && isBlank(lines[lineNum + 1])) {
                lineNum++;
            }
        }
    }

    // Post-processing: compact and insert spacing
    const compacted = compactBlankLines(state.pass1, newline);
    // When the pipeline was produced by expansion, avoid inserting step spacing
    // here because expansion-formatting follows a different path (handled elsewhere
    // or intentionally preserved). Respect the wasExpanded flag to prevent adding
    // extra blank lines for expanded output.
    const finalLines =
        options?.stepSpacing && !options?.wasExpanded
            ? insertStepSpacing(compacted, options?.conditionalDirectiveExpressions)
            : compacted;

    return finalLines.join(newline);
}

/**
 * Format YAML content with Azure Pipeline-specific rules
 * @param {string} content - The YAML content to format
 * @param {object} options - Formatting options
 * @returns {{ text: string, warning: string|undefined, error: string|undefined }}
 */
function formatYaml(content, options = {}) {
    const baseResult = {
        text: content,
        warning: undefined,
        error: undefined,
    };

    if (!content) {
        return baseResult;
    }

    // Check for file-level formatting directives BEFORE splitting multi-doc files
    // This ensures directives in the first document apply to all documents
    const directives = parseFormatDirectives(content);

    // If formatting is disabled via file directive, return original content
    const metadataKeys = new Set(['fileName', 'baseDir']);
    const formattingOptionKeys = options ? Object.keys(options).filter((k) => !metadataKeys.has(k)) : [];
    if (directives.disabled && formattingOptionKeys.length === 0) {
        return baseResult;
    }

    // Handle multi-document YAML files (documents separated by ---)
    const isMultiDocument = /\n---\n/.test(content);
    if (isMultiDocument) {
        const documents = content.split(/\n---\n/);
        const formattedDocs = [];
        const warnings = [];
        const errors = [];

        for (let docIndex = 0; docIndex < documents.length; docIndex++) {
            const doc = documents[docIndex];
            if (!doc.trim()) continue;

            const result = formatYaml(doc, options);
            if (result.error) {
                errors.push(`Document ${docIndex + 1}: ${result.error}`);
                continue;
            }
            if (result.warning) {
                warnings.push(`Document ${docIndex + 1}: ${result.warning}`);
            }
            formattedDocs.push(result.text.trim());
        }

        if (formattedDocs.length === 0) {
            return {
                text: content,
                warning: warnings.length > 0 ? warnings.join('\n') : undefined,
                error: errors.length > 0 ? errors.join('\n') : 'All documents failed to format',
            };
        }

        return {
            text: formattedDocs.join('\n\n---\n'),
            warning: warnings.length > 0 ? warnings.join('\n') : undefined,
            error: errors.length > 0 ? errors.join('\n') : undefined,
        };
    }

    const preflightHints = analyzeTemplateHints(content);
    const hintsBlock = preflightHints.length ? `\n  ${preflightHints.join('\n  ')}` : '';

    // Throw error if there are critical syntax issues (but skip during template expansion)
    if (preflightHints.length > 0 && !options.expandTemplates) {
        const hasCriticalError = preflightHints.some(
            (hint) =>
                hint.includes('Missing closing') ||
                hint.includes('Unbalanced parentheses') ||
                hint.includes('Unbalanced brackets') ||
                hint.includes('Unbalanced braces') ||
                hint.includes('Unclosed string')
        );
        if (hasCriticalError) {
            throw new Error(`Template validation failed:${hintsBlock}`);
        }
    }

    // Check for file-level formatting directives (for options, not disabled flag)
    // Note: disabled flag is already checked at the top of formatYaml
    const contentDirectives = parseFormatDirectives(content);

    // Merge directive options with provided options (directives take precedence)
    if (contentDirectives.options) {
        options = { ...options, ...contentDirectives.options };
    }

    const effective = {
        noArrayIndent: getBooleanOption(options, 'noArrayIndent', true),
        indent: getIndentOption(options),
        lineWidth: getLineWidth(options),
        forceQuotes: getBooleanOption(options, 'forceQuotes', false),
        sortKeys: getBooleanOption(options, 'sortKeys', false),
        expandTemplates: getBooleanOption(options, 'expandTemplates', false),
        newlineFormat: getNewlineFormat(options),
        fileName: options && options.fileName ? options.fileName : undefined,
        // Pipeline-specific formatting options
        stepSpacing: getBooleanOption(options, 'stepSpacing', true),
        firstBlockBlankLines: getClampedIntegerOption(options, 'firstBlockBlankLines', 4, 2),
        betweenSectionBlankLines: getBetweenSectionBlankLines(options),
        sectionSpacing: getBooleanOption(options, 'sectionSpacing', false),
        wasExpanded: getBooleanOption(options, 'wasExpanded', false),
        azureCompatible: getBooleanOption(options, 'azureCompatible', false),
    };

    try {
        let inputContent = content;

        const {
            content: preprocessedContent,
            placeholderMap,
            conditionalDirectives,
        } = effective.expandTemplates
            ? { content: inputContent, placeholderMap: new Map(), conditionalDirectives: new Set() }
            : replaceTemplateExpressionsWithPlaceholders(inputContent);

        const { content: protectedContent, commentMap } = protectEmptyValues(preprocessedContent);

        const preprocessedHints = analyzeTemplateHints(protectedContent, conditionalDirectives);
        if (preprocessedHints.length > 0) {
            const hintsBlock = `\n  ${preprocessedHints.join('\n  ')}`;
            const filePrefix = effective.fileName ? `[${effective.fileName}] ` : '';
            const lines = `YAML validation warnings:${hintsBlock}`.split('\n');
            const indented = lines.map((line, idx) => (idx === 0 ? line : '  ' + line)).join('\n');
            console.error(`${filePrefix}${indented}`);
            return {
                text: content,
                warning: hintsBlock,
                error: undefined,
            };
        }

        const doc = YAML.parseDocument(protectedContent, { strict: false, uniqueKeys: false });

        if (doc.errors && doc.errors.length > 0) {
            const genuineErrors = doc.errors.filter(
                (e) => !e.message || !e.message.includes('Invalid escape sequence')
            );

            if (genuineErrors.length > 0) {
                const errorMessages = genuineErrors.map((e) => e.message).join(', ');
                const filePrefix = effective.fileName ? `[${effective.fileName}] ` : '';
                const lines = `YAML parsing error: ${errorMessages}`.split('\n');
                const indented = lines.map((line, idx) => (idx === 0 ? line : '  ' + line)).join('\n');
                console.error(`${filePrefix}${indented}`);
                const hintSuffix = hintsBlock;
                return {
                    text: content,
                    warning: hintsBlock || undefined,
                    error:
                        errorMessages.length > 100
                            ? errorMessages.substring(0, 100) + '...' + hintSuffix
                            : `${errorMessages}${hintSuffix}`,
                };
            }
        }

        doc.errors = [];
        doc.warnings = [];

        let result = doc.toString({
            indent: effective.indent,
            indentSeq: !effective.noArrayIndent,
            lineWidth: -1,
            doubleQuotedAsJSON: true,
            doubleQuotedMinMultiLineLength: Infinity,
            singleQuote: null,
            blockQuote: true,
            defaultStringType: 'PLAIN',
            aliasDuplicateObjects: false,
        });

        result = restoreTemplateExpressions(result, placeholderMap);
        result = restoreEmptyValues(result, commentMap);

        const newline = effective.newlineFormat;
        let normalized = result.replace(/\r?\n/g, newline);

        // Build a set of actual conditional directive expressions for use in formatting
        const conditionalDirectiveExpressions = new Set();
        for (const [placeholder, expression] of placeholderMap) {
            if (conditionalDirectives.has(placeholder)) {
                conditionalDirectiveExpressions.add(expression);
            }
        }
        effective.conditionalDirectiveExpressions = conditionalDirectiveExpressions;

        normalized = applyPipelineFormatting(normalized, newline, effective);
        normalized = normalized
            .split(newline)
            .map((line) => line.replace(/[ \t]+$/, ''))
            .join(newline);

        // Ensure newline(s) at end of file
        // If template was expanded, preserve 2 blank lines (Microsoft format: content + 3 newlines total)
        // Otherwise, ensure single newline at end
        if (effective.wasExpanded && effective.azureCompatible) {
            normalized = normalized.replace(
                new RegExp(`(?:${escapeRegExp(newline)})*$`),
                `${newline}${newline}${newline}`
            );
        } else {
            normalized = normalized.replace(new RegExp(`(?:${escapeRegExp(newline)})*$`), newline);
        }

        return {
            text: normalized,
            warning: hintsBlock || undefined,
            error: undefined,
        };
    } catch (error) {
        const syntaxMessage = describeYamlSyntaxError(error, content);
        const filePrefix = effective.fileName ? `[${effective.fileName}] ` : '';

        if (syntaxMessage) {
            const lines = syntaxMessage.split('\n');
            const indented = lines.map((line, idx) => (idx === 0 ? line : '  ' + line)).join('\n');
            console.error(`${filePrefix}${indented}`);
            return {
                text: content,
                warning: hintsBlock || undefined,
                error: syntaxMessage,
            };
        }

        const formattingError = `YAML formatting failed: ${error.message}`;
        const lines = formattingError.split('\n');
        const indented = lines.map((line, idx) => (idx === 0 ? line : '  ' + line)).join('\n');
        console.error(`${filePrefix}${indented}`);
        return {
            text: content,
            warning: hintsBlock || undefined,
            error: `YAML formatting failed: ${error.message}`,
        };
    }
}

module.exports = {
    formatYaml,
    escapeRegExp,
    replaceTemplateExpressionsWithPlaceholders,
    restoreTemplateExpressions,
    analyzeTemplateHints,
    parseFormatDirectives,
};
