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
 * Check if we've exited the jobs block
 */
function hasExitedJobsBlock(isTemplateExpr, indent, jobsIndent, trimmed) {
    return (
        !isTemplateExpr &&
        indent <= jobsIndent &&
        trimmed.includes(':') &&
        !trimmed.startsWith('-') &&
        !trimmed.startsWith('${{') &&
        !trimmed.startsWith('jobs:')
    );
}

/**
 * Check if we're starting a new job
 */
function isStartingNewJob(inJobObject, trimmed, jobPropertiesIndent, indent) {
    return (
        inJobObject &&
        (trimmed.match(/^-\s+job:/) ||
            (trimmed.startsWith('job:') && jobPropertiesIndent !== -1 && indent <= jobPropertiesIndent))
    );
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
                if (hasExitedJobsBlock(isTemplateExpr, indent, jobsIndent, trimmed)) {
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
                    if (isStartingNewJob(inJobObject, trimmed, jobPropertiesIndent, indent)) {
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
    if (isDuplicateKeyForTemplateExpression(error)) {
        return undefined;
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

function isDuplicateKeyForTemplateExpression(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const message = typeof error.message === 'string' ? error.message : '';
    if (!message.includes('duplicated mapping key')) {
        return false;
    }

    const snippet = typeof error.snippet === 'string' ? error.snippet : '';
    if (snippet.includes('${{')) {
        return true;
    }

    const markSnippet = error.mark && typeof error.mark.snippet === 'string' ? error.mark.snippet : '';
    return markSnippet.includes('${{');
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
    const { lineNum, inMultiLineBlock, pass1, currentSection, spacedSections, lines, foundFirstMainSection } = state;
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

    if (!isTrailingComment) {
        // Add blank before a comment in steps/jobs/stages, OR if we're at root level after finding a main section
        // (this catches comments at root level between items, even if currentSection tracking lost the context)
        // ALSO check if we're in a nested steps section by looking backward for a steps: header
        let inNestedSteps = false;
        const commentIndent = getIndent(line);
        for (let j = lineNum - 1; j >= 0; j--) {
            const checkLine = lines[j];
            if (isBlank(checkLine) || isComment(checkLine)) continue;
            const checkIndent = getIndent(checkLine);
            const checkTrimmed = checkLine.trim();
            // If we find a steps: header at lower or equal indent, we're inside it
            if (checkTrimmed === 'steps:' && checkIndent <= commentIndent) {
                inNestedSteps = true;
                break;
            }
            // Stop if we hit content at lower indent AND it's not a list item (we've gone up a level)
            if (checkIndent < commentIndent && !checkLine.trim().startsWith('-')) {
                break;
            }
        }

        if (needsBlankBeforeComment(inNestedSteps, currentSection, spacedSections, foundFirstMainSection, line)) {
            const lastLine = pass1.length > 0 ? pass1[pass1.length - 1] : null;
            const lastTrimmed = lastLine ? lastLine.trim() : '';
            const lastIsHeader = lastTrimmed === 'steps:' || lastTrimmed === 'jobs:' || lastTrimmed === 'stages:';

            if (lastLine && !isBlank(lastLine) && !lastIsHeader) {
                pass1.push('');
            }
        }
    }

    pass1.push(line);
    return true;
}

/**
 * Check if should add blank line before comment
 */
function needsBlankBeforeComment(inNestedSteps, currentSection, spacedSections, foundFirstMainSection, line) {
    return (
        inNestedSteps ||
        currentSection === 'steps' ||
        spacedSections.includes(currentSection) ||
        (foundFirstMainSection && getIndent(line) === 0)
    );
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
        spacedSections,
        listItemSections,
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
        } else if (currentSection === 'steps' || spacedSections.includes(currentSection)) {
            const isPrevComment = isComment(prevLine);
            const isNextList = isListItem(lines[nextNonBlank]);
            keepBlank = !(isPrevComment && isNextList);
        } else if (listItemSections.includes(currentSection)) {
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
    const { pass1, lineIndent, lineNum, lines } = state;
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

    // Add blank line before pipeline items OR root-level conditionals if appropriate
    if (shouldAddBlankBeforePipelineItem(state, line, isListEntry, isPipelineItem, isConditional)) {
        if (pass1.length > 0 && !isBlank(pass1[pass1.length - 1])) {
            pass1.push('');
        }
    }

    return { isPipelineItem };
}

/**
 * Check if should add blank line before pipeline item
 */
function shouldAddBlankBeforePipelineItem(state, line, isListEntry, isPipelineItem, isConditional) {
    const { pass1, lastStepInStepsSection, inMultiLineBlock, variablesIndent, startsMultiLineBlock, lineIndent } =
        state;

    // Calculate derived values
    const isRootLevelConditional = isConditional && lastStepInStepsSection >= 0;
    const inVariablesSection = variablesIndent >= 0 && lineIndent === variablesIndent && isListEntry;
    const prevLine = pass1.length > 0 ? pass1[pass1.length - 1].trim() : '';
    const prevIsConditional = isConditionalListItem(prevLine);
    const prevIsSectionHeader = isMainSectionKey(prevLine);
    const wasAlreadyInMultiLineBlock = inMultiLineBlock && !startsMultiLineBlock;

    return (
        (isPipelineItem || isRootLevelConditional) &&
        lastStepInStepsSection >= 0 &&
        !prevIsSectionHeader &&
        !prevIsConditional &&
        !wasAlreadyInMultiLineBlock &&
        !inVariablesSection
    );
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
    // Root section = mapping key at indent 0 (with or without value on same line)
    const isRootSection =
        !isComment(line) &&
        !isListItem(line) &&
        getIndent(line) === 0 &&
        (isMappingKey(line) || trimmed.includes(': '));

    let section2HandledThisLine = false;
    let newParametersEnded = parametersEnded;
    let newFoundFirstSection = foundFirstSection;
    let newFoundFirstMainSection = foundFirstMainSection;

    // 2. First Block Blank Lines (skip for expanded output to preserve original spacing)
    if (hasParametersAtStart && !options.wasExpanded) {
        if (!parametersEnded && lineNum > firstNonEmptyLine) {
            if (isRootSection) {
                newParametersEnded = true;
            }
        }

        if (newParametersEnded && !newFoundFirstSection && topLevelSections.some((s) => trimmed === s)) {
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
    let newLastRootSectionIndex = lastRootSectionIndex;
    if (isRootSection && !section2HandledThisLine && !options.wasExpanded) {
        const keyOnly = trimmed.includes(':') ? trimmed.substring(0, trimmed.indexOf(':') + 1).trim() : trimmed;
        const isMainSection = isMainSectionKey(keyOnly);
        const isFirstMainSection =
            isMainSection &&
            !newFoundFirstMainSection &&
            (hasParametersAtStart ? newParametersEnded : lastRootSectionIndex >= 0);

        if (isFirstMainSection) {
            newFoundFirstMainSection = true;
            newFoundFirstSection = true;
        }

        // Check if there's any actual content after this line
        let hasContentAfter = false;
        for (let j = lineNum + 1; j < lines.length; j++) {
            if (hasActualContent(lines[j])) {
                hasContentAfter = true;
                break;
            }
        }

        // Determine blank lines to add (only if there's already content before AND after)
        let blankLinesToAdd = 0;
        const shouldAddBlanks =
            (lastRootSectionIndex >= 0 || (hasParametersAtStart && newParametersEnded)) && hasContentAfter;

        if (shouldAddBlanks) {
            // Remove existing blanks before this section
            while (pass1.length > 0 && isBlank(pass1[pass1.length - 1])) {
                pass1.pop();
            }

            if (keyOnly === 'name:') {
                blankLinesToAdd = 1;
            } else if (isFirstMainSection) {
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
                // NOTE: Comments don't affect spacing - they are treated as part of the next item
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
 * Update multi-line block tracking state (detects scalar blocks like | and >)
 */
function updateMultiLineBlockStateForSpacing(state) {
    const { line, indent, inMultiLineBlock, multiLineBlockIndent } = state;
    if (startsMultiLineScalarBlock(line)) {
        state.inMultiLineBlock = true;
        state.multiLineBlockIndent = indent;
    } else if (inMultiLineBlock && !isBlank(line) && indent <= multiLineBlockIndent) {
        state.inMultiLineBlock = false;
        state.multiLineBlockIndent = -1;
    }
}

/**
 * Check if should exit variables or parameters section
 */
function shouldExitVariablesOrParametersSection(sectionName, indent, entryIndent) {
    return sectionName !== 'variables' && sectionName !== 'parameters' && indent === entryIndent;
}

/**
 * Update section context tracking (nested mappings, variables, parameters)
 */
function updateSectionContextForSpacing(state) {
    const { line, indent, trimmed } = state;

    // Enter variables/parameters section when we see the keyword
    if (!isBlank(line) && !isListItem(line) && isMappingKey(trimmed)) {
        const sectionName = trimmed.slice(0, -1);
        if (sectionName === 'variables' || sectionName === 'parameters') {
            state.insideVariablesOrParameters = true;
            state.variablesOrParametersIndent = indent;
        } else {
            // Non-variables/parameters mapping key encountered
            state.currentSection = sectionName;
        }
    }

    // Exit variables/parameters section when indent drops below the entry indent
    if (state.insideVariablesOrParameters && indent < state.variablesOrParametersIndent) {
        state.insideVariablesOrParameters = false;
        state.variablesOrParametersIndent = -1;
    }

    // Also exit when we encounter a sibling mapping key at same indent as entry point
    if (state.insideVariablesOrParameters && !isBlank(line) && !isListItem(line) && isMappingKey(trimmed)) {
        const sectionName = trimmed.slice(0, -1);
        if (shouldExitVariablesOrParametersSection(sectionName, indent, state.variablesOrParametersIndent)) {
            state.insideVariablesOrParameters = false;
            state.variablesOrParametersIndent = -1;
        }
    }
}

/**
 * Check if we should enter a nested mapping context
 */
function shouldEnterNestedMappingForSpacing(state) {
    const { line, effectivelyInMultiLineBlock, sectionStack, insideNestedMapping } = state;
    return (
        !effectivelyInMultiLineBlock &&
        !isListItem(line) &&
        !isComment(line) &&
        isMappingKey(line) &&
        sectionStack.length > 0 &&
        !containsTemplateExpression(line) &&
        !insideNestedMapping
    );
}

/**
 * Update nested mapping context (mappings with child lists like dependsOn:, parameters:)
 */
function updateNestedMappingContextForSpacing(state) {
    const { line, indent, trimmed, insideNestedMapping, nestedMappingIndent } = state;

    // Exit nested mapping context if at lower indent or at same indent but not a list item
    if (insideNestedMapping && !isBlank(line)) {
        if (indent < nestedMappingIndent || (indent === nestedMappingIndent && !isListItem(line))) {
            state.insideNestedMapping = false;
            state.nestedMappingIndent = -1;
        }
    }

    // Enter nested mapping context for regular mapping keys inside main sections
    if (shouldEnterNestedMappingForSpacing(state)) {
        const sectionName = trimmed.slice(0, -1);
        const mainListSections = new Set(['steps', 'jobs', 'stages']);
        if (!mainListSections.has(sectionName)) {
            state.insideNestedMapping = true;
            state.nestedMappingIndent = indent;
        }
    }
}

/**
 * Update section stack for context tracking
 */
function updateSectionStackForSpacing(state) {
    const { line, indent, trimmed, sectionStack, effectivelyInMultiLineBlock } = state;
    if (effectivelyInMultiLineBlock || isBlank(line)) return;

    const mainListSections = new Set(['steps', 'jobs', 'stages']);

    // Pop sections at same or higher indent (unless implicit)
    if (!isListItem(line) && !isComment(line)) {
        while (sectionStack.length && sectionStack[sectionStack.length - 1].indent >= indent) {
            if (sectionStack[sectionStack.length - 1].implicit) break;
            sectionStack.pop();
        }
    }

    // Push new section if this is a mapping key (only main list sections)
    if (!isListItem(line) && !isComment(line) && isMappingKey(line)) {
        const sectionName = trimmed.slice(0, -1);
        if (mainListSections.has(sectionName)) {
            sectionStack.push({ name: sectionName, indent });
        }
        // Note: Nested mapping context is handled separately in updateNestedMappingContextForSpacing
    }
}

/**
 * Handle blank removal between parent list item and child content
 */
function handleBlanksBetweenParentAndChildForSpacing(state) {
    const { lines, currentLineIdx, listItemIndent, removePositions } = state;
    let nextNonBlankIdx = -1;
    let blankIndices = [];

    for (let j = currentLineIdx + 1; j < lines.length; j++) {
        if (isBlank(lines[j])) {
            blankIndices.push(j);
        } else {
            nextNonBlankIdx = j;
            break;
        }
    }

    // Remove blanks between parent and child (indented more than parent)
    if (blankIndices.length > 0 && nextNonBlankIdx > 0) {
        const nextNonBlankLine = lines[nextNonBlankIdx];
        const nextLineIndent = getIndent(nextNonBlankLine);

        if (nextLineIndent > listItemIndent && !isComment(nextNonBlankLine)) {
            for (const blankIdx of blankIndices) {
                removePositions.push(blankIdx);
            }
        }
    }
}

/**
 * Check if this list item is inside a main list section (steps, jobs, stages)
 */
function isInsideMainListSectionForSpacing(state) {
    const { sectionStack } = state;
    const mainListSections = new Set(['steps', 'jobs', 'stages']);
    for (let s = sectionStack.length - 1; s >= 0; s--) {
        if (mainListSections.has(sectionStack[s].name)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if at root level and not in variables or parameters section
 */
function isRootLevelAndNotInVariablesOrParameters(state, indent, currentSection) {
    return (
        !isInsideMainListSectionForSpacing(state) &&
        indent === 0 &&
        currentSection !== 'variables' &&
        currentSection !== 'parameters'
    );
}

/**
 * Check if this list item should have an implicit main section and add it if needed
 */
function checkAndAddImplicitSectionForSpacing(state) {
    const { sectionStack, currentLineIdx, lines, trimmed, indent, currentSection } = state;

    if (isRootLevelAndNotInVariablesOrParameters(state, indent, currentSection)) {
        let shouldAddImplicitSection = false;

        if (containsTemplateExpression(trimmed)) {
            shouldAddImplicitSection = true;
        } else {
            // Check first non-blank child
            for (let j = currentLineIdx + 1; j < Math.min(currentLineIdx + 10, lines.length); j++) {
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
            const hasImplicitSection = sectionStack.some((s) => s.implicit);
            if (!hasImplicitSection) {
                sectionStack.push({ name: 'stages', indent: -1, implicit: true });
                return true;
            }
        }
    }
    return false;
}

/**
 * Process and remove blanks between comments and current task
 */
function processCommentsBeforeItemForSpacing(state) {
    const { lines, currentLineIdx, removePositions } = state;

    for (let k = currentLineIdx - 1; k >= 0; k--) {
        const checkLine = lines[k];

        if (isBlank(checkLine)) continue;
        if (!isComment(checkLine)) break;

        // Found comment before task - check if there's a previous list item before comment
        let hasPreviousListItem = false;
        let firstBlankIdx = -1;

        for (let m = k - 1; m >= 0; m--) {
            if (isBlank(lines[m])) {
                if (firstBlankIdx === -1) firstBlankIdx = m;
                continue;
            }
            if (isListItem(lines[m])) {
                hasPreviousListItem = true;
                break;
            }
            break;
        }

        // Remove blanks between comment and task (preserve first blank if previous list item exists)
        for (let b = k + 1; b < currentLineIdx; b++) {
            if (isBlank(lines[b])) {
                const shouldPreserve = hasPreviousListItem && b === firstBlankIdx;
                if (!shouldPreserve) {
                    removePositions.push(b);
                }
            }
        }
        break;
    }
}

/**
 * Find the next sibling list item at the same indent level
 */
function findNextSiblingListItemForSpacing(state) {
    const { lines, currentLineIdx, listItemIndent } = state;

    for (let j = currentLineIdx + 1; j < lines.length; j++) {
        if (isBlank(lines[j])) continue;
        if (isComment(lines[j])) continue;

        const nextIndent = getIndent(lines[j]);
        const isNextList = isListItem(lines[j]);

        if (isNextList && nextIndent === listItemIndent) {
            return j;
        }

        // Stop if we encounter a list item at LOWER indent
        if (isNextList && nextIndent < listItemIndent) {
            break;
        }

        // Stop if we encounter a line at same or lower indent that's not a list item
        if (nextIndent <= listItemIndent && !isNextList) {
            break;
        }
    }
    return null;
}

/**
 * Process spacing between sibling list items with multi-line condition handling
 */
function processSiblingSpacingForSpacing(state, nextItemIdx) {
    const { lines, currentLineIdx, listItemIndent, removePositions, insertPositions } = state;

    const nextItemIndent = getIndent(lines[nextItemIdx]);
    if (nextItemIndent !== listItemIndent) return;

    let hasBlankBefore = false;
    let hasCommentBetween = false;

    // Look backwards from nextItemIdx to find what's between siblings
    for (let k = nextItemIdx - 1; k >= 0; k--) {
        const checkLine = lines[k];

        if (isBlank(checkLine)) {
            hasBlankBefore = true;
            continue;
        }

        if (isComment(checkLine)) {
            hasCommentBetween = true;
            // Check if there's a previous list item before this comment
            let hasPrevTask = false;
            let firstBlank = -1;

            for (let m = k - 1; m >= currentLineIdx; m--) {
                if (isBlank(lines[m])) {
                    if (firstBlank === -1) firstBlank = m;
                    continue;
                }
                if (isListItem(lines[m])) {
                    hasPrevTask = true;
                    break;
                }
                break;
            }

            // Remove blanks between comment and next task (preserve first blank if previous task exists)
            for (let b = k + 1; b < nextItemIdx; b++) {
                if (isBlank(lines[b])) {
                    const shouldKeep = hasPrevTask && b === firstBlank;
                    if (!shouldKeep) {
                        removePositions.push(b);
                    }
                }
            }
            break;
        }

        // If we hit content (not blank, not comment), we've reached the previous item
        break;
    }

    // Only add blank if there's no blank AND no comment between siblings
    if (!hasBlankBefore && !hasCommentBetween) {
        insertPositions.push(nextItemIdx);
    }
}

/**
 * Process list item for spacing (handles blank removal and insertion)
 */
function processListItemSpacingForSpacing(state) {
    const { insideNestedMapping, insideVariablesOrParameters } = state;

    // Always handle blanks between parent and child, regardless of context
    handleBlanksBetweenParentAndChildForSpacing(state);

    // Only process sibling spacing when NOT in nested mapping AND NOT in variables/parameters
    if (insideNestedMapping || insideVariablesOrParameters) return;

    let insideMainSection = isInsideMainListSectionForSpacing(state);

    // Check if we should add implicit section
    if (!insideMainSection) {
        const added = checkAndAddImplicitSectionForSpacing(state);
        insideMainSection = added || isInsideMainListSectionForSpacing(state);
    }

    // Process spacing for items in main sections
    if (!insideMainSection) return;

    processCommentsBeforeItemForSpacing(state);

    const nextItemIdx = findNextSiblingListItemForSpacing(state);
    if (nextItemIdx !== null) {
        processSiblingSpacingForSpacing(state, nextItemIdx);
    }
}

/**
 * Insert blank lines between step items if stepSpacing is enabled
 */
function insertStepSpacing(lines) {
    const state = {
        lines,
        insertPositions: [],
        removePositions: [],
        sectionStack: [],
        inMultiLineBlock: false,
        multiLineBlockIndent: -1,
        insideNestedMapping: false,
        nestedMappingIndent: -1,
        currentSection: null,
        insideVariablesOrParameters: false,
        variablesOrParametersIndent: -1,
        currentLineIdx: 0,
        listItemIndent: 0,
        line: '',
        indent: 0,
        trimmed: '',
        effectivelyInMultiLineBlock: false,
    };

    for (let i = 0; i < lines.length; i++) {
        state.currentLineIdx = i;
        state.line = lines[i];
        state.indent = getIndent(state.line);
        state.trimmed = state.line.trim();

        // Save multi-line block state BEFORE processing (line starting a block should still be processed for spacing)
        const wasInMultiLineBlock = state.inMultiLineBlock;

        // Update block state
        updateMultiLineBlockStateForSpacing(state);
        state.effectivelyInMultiLineBlock = wasInMultiLineBlock && state.inMultiLineBlock;

        // Update section context
        updateSectionContextForSpacing(state);

        // Update nested mapping context
        updateNestedMappingContextForSpacing(state);

        // Update section stack
        updateSectionStackForSpacing(state);

        // Process list item spacing
        if (!state.effectivelyInMultiLineBlock && isListItem(state.line)) {
            state.listItemIndent = state.indent;
            processListItemSpacingForSpacing(state);
        }
    }

    return applyBlankLineAdjustmentsForSpacing(lines, state.removePositions, state.insertPositions);
}

/**
 * Apply blank line insertions and removals to the lines array
 */
function applyBlankLineAdjustmentsForSpacing(lines, removePositions, insertPositions) {
    let result = [...lines];

    // Remove blanks in reverse order to maintain indices
    for (const idx of Array.from(new Set(removePositions)).sort((a, b) => b - a)) {
        result.splice(idx, 1);
    }

    // Insert blanks between siblings (adjust indices after removals)
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
    const topLevelSections = [
        'stages:',
        'jobs:',
        'steps:',
        'trigger:',
        'pr:',
        'resources:',
        'pool:',
        'variables:',
        'name:',
    ];
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
        spacedSections: ['steps'],
        listItemSections: ['stages', 'jobs'],
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
        // IMPORTANT: Only mapping keys at root level are sections, NOT list items (even if they have colons)
        if (lineIndent === 0 && isNonCommentContent(trimmed) && isMappingKey(trimmed) && !isListItem(line)) {
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
    const finalLines = options?.stepSpacing && !options?.wasExpanded ? insertStepSpacing(compacted) : compacted;

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

        const doc = YAML.parseDocument(protectedContent, { strict: false, uniqueKeys: true });

        if (doc.errors && doc.errors.length > 0) {
            const genuineErrors = doc.errors.filter(
                (e) => !e.message || !e.message.includes('Invalid escape sequence')
            );
            const filteredErrors = genuineErrors.filter((e) => !isDuplicateKeyForTemplateExpression(e));

            if (filteredErrors.length > 0) {
                const errorMessages = filteredErrors.map((e) => e.message).join(', ');
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
