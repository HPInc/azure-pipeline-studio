const YAML = require('yaml');

/**
 * Escape special regex characters in a string
 * @param {string} string - The string to escape
 * @returns {string} The escaped string
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace Azure Pipeline template expressions with placeholders
 * @param {string} content - The YAML content
 * @returns {{ content: string, placeholderMap: Map }} The content with placeholders and the mapping
 */
function replaceTemplateExpressionsWithPlaceholders(content) {
    if (!content) {
        return { content, placeholderMap: new Map() };
    }

    const templateExpressionPattern = /(\$\{\{[^}]+\}\}|\$\[[^\]]+\])/g;
    const placeholderMap = new Map();
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
        counter++;
        return placeholder;
    });

    return { content: result, placeholderMap };
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
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) {
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
            const nextTrimmed = nextLine.trim();
            const nextIndent = nextLine.length - nextLine.trimStart().length;

            if (nextTrimmed === '' || nextTrimmed.startsWith('#')) {
                nextIndex++;
                continue;
            }

            hasChildContent =
                (nextTrimmed.startsWith('-') && nextIndent >= indent.length) || nextIndent > indent.length;
            break;
        }

        if (!hasChildContent) {
            const allValueComments = [];
            let commentIndex = i + 1;

            while (commentIndex < lines.length) {
                const commentLine = lines[commentIndex];
                const commentTrimmed = commentLine.trim();

                if (commentTrimmed === '') {
                    allValueComments.push(commentLine);
                    commentIndex++;
                    continue;
                }

                if (!commentTrimmed.startsWith('#')) break;

                const commentIndent = commentLine.length - commentLine.trimStart().length;
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
        if (trimmed === '# aps-format=false' || trimmed === '# aps-format: false') {
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
        if (trimmed.length > 0 && !trimmed.startsWith('#')) {
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
 * Describe YAML syntax errors in a user-friendly way
 * @param {Error} error - The error object
 * @returns {string|undefined} A formatted error message or undefined
 */
function describeYamlSyntaxError(error) {
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

    if (!baseMessage && !hasLine) {
        return undefined;
    }

    const lineText = hasLine ? `line ${mark.line + 1}` : undefined;
    const columnText = hasColumn ? `column ${mark.column + 1}` : undefined;
    const location = lineText && columnText ? `${lineText}, ${columnText}` : lineText || columnText;

    if (location && baseMessage) {
        return `YAML syntax error at ${location}: ${baseMessage}`;
    }

    if (baseMessage) {
        return `YAML syntax error: ${baseMessage}`;
    }

    return location ? `YAML syntax error at ${location}.` : undefined;
}

/**
 * Find the next non-blank line index starting from the given index.
 * @param {string[]} lines - Array of lines
 * @param {number} startIndex - Index to start searching from
 * @returns {number|null} Index of next non-blank line, or null if none found
 */
function findNextNonBlankLine(lines, startIndex) {
    for (let i = startIndex; i < lines.length; i++) {
        if (lines[i].trim() !== '') {
            return i;
        }
    }
    return null;
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

    let lines = text.split(newline);
    const result = [];

    // Define parent keys that should not have blank lines after them
    const parentKeys = [
        'steps:',
        'jobs:',
        'stages:',
        'pool:',
        'variables:',
        'parameters:',
        'resources:',
        'trigger:',
        'pr:',
    ];

    // Define sections where step spacing should apply (blank lines between items are preserved/added)
    const stepSpacingSections = ['steps'];

    // Define sections where list item spacing should apply (stages, jobs, etc.)
    const listItemSpacingSections = ['stages', 'jobs'];

    // Define step types for step spacing
    const stepPattern =
        /^\s*-\s+(task|bash|powershell|pwsh|script|sh|checkout|download|downloadBuild|getPackage|publish|reviewApp|template):/;

    const topLevelSections = ['stages:', 'jobs:', 'steps:', 'trigger:', 'pr:', 'resources:', 'pool:', 'variables:'];
    let hasParametersAtStart = false;
    let firstNonEmptyLine = -1;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.startsWith('#')) {
            firstNonEmptyLine = i;
            hasParametersAtStart = trimmed === 'parameters:';
            break;
        }
    }

    const pass1 = [];
    let currentSection = null;
    let prevWasComment = false;
    let lastStepInStepsSection = -1;
    let currentVariablesIndent = -1;
    let inMultiLineBlock = false;
    let multiLineBlockIndent = -1;
    let foundFirstSection = false;
    let foundFirstMainSection = false;
    let parametersEnded = false;
    let lastRootSectionIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const lineIndent = line.length - line.trimStart().length;

        // Track the current root section
        if (lineIndent === 0 && trimmed && !trimmed.startsWith('#') && trimmed.endsWith(':')) {
            currentSection = trimmed.slice(0, -1);
        }

        // Check if this is a blank line
        if (trimmed === '') {
            const nextNonBlank = findNextNonBlankLine(lines, i + 1);
            if (nextNonBlank !== null) {
                const nextLineIndent = lines[nextNonBlank].length - lines[nextNonBlank].trimStart().length;
                const nextTrimmed = lines[nextNonBlank].trim();

                let keepBlank = false;

                // Always keep blank lines inside multi-line blocks (but as empty strings)
                if (inMultiLineBlock) {
                    pass1.push(''); // Push empty string for blank lines in multi-line blocks
                    prevWasComment = false;
                    continue; // Skip the rest of blank line processing
                } else {
                    // Only keep blank lines that are directly after stages:, jobs:, or steps: (indent 0 or 2)
                    // Find the previous non-blank line
                    const prevNonBlankIndex = pass1.length - 1;
                    let prevLine = null;
                    for (let j = prevNonBlankIndex; j >= 0; j--) {
                        if (pass1[j].trim() !== '') {
                            prevLine = pass1[j];
                            break;
                        }
                    }

                    if (prevLine) {
                        const prevIndent = prevLine.length - prevLine.trimStart().length;
                        const prevTrimmed = prevLine.trim();

                        // Keep blank if previous line was stages:, jobs:, or steps: at root level
                        if (
                            prevIndent === 0 &&
                            (prevTrimmed === 'stages:' || prevTrimmed === 'jobs:' || prevTrimmed === 'steps:')
                        ) {
                            keepBlank = true;
                        }
                        // NOTE: We DON'T keep blank lines between root-level sections here
                        // because Section 3 (section spacing logic) handles that with betweenSectionBlankLines option
                        // Keep blank if previous line was a comment (preserve blank after comment)
                        // Cases where code is commented out from VSCode where there are spaces in between stages/steps or jobs
                        else if (prevWasComment) {
                            keepBlank = true;
                        }
                        // Keep blank lines in steps section (for step spacing)
                        else if (currentSection === 'steps' || stepSpacingSections.includes(currentSection)) {
                            keepBlank = true;
                        }
                        // Keep blank lines between direct children in stages/jobs sections (indent 0 or 2 only)
                        else if (listItemSpacingSections.includes(currentSection)) {
                            if (nextLineIndent === 0 || nextLineIndent === 2) {
                                keepBlank = true;
                            }
                        }
                    }

                    // Trailing Comments rule
                    // Keep exactly ONE blank line before trailing comments (comments at EOF with no content after)
                    if (keepBlank && nextTrimmed.startsWith('#')) {
                        let hasContentBefore = false;
                        let lastContentIndex = -1;
                        for (let j = pass1.length - 1; j >= 0; j--) {
                            if (pass1[j].trim() !== '' && !pass1[j].trim().startsWith('#')) {
                                hasContentBefore = true;
                                lastContentIndex = j;
                                break;
                            }
                            if (pass1[j].trim().startsWith('#')) break;
                        }

                        if (hasContentBefore) {
                            let hasContentAfter = false;
                            for (let j = nextNonBlank; j < lines.length; j++) {
                                const futureTrimmed = lines[j].trim();
                                if (futureTrimmed !== '' && !futureTrimmed.startsWith('#')) {
                                    hasContentAfter = true;
                                    break;
                                }
                            }

                            // This is a trailing comment block (no content after)
                            if (!hasContentAfter) {
                                // Check how many blank lines exist after last content
                                let blankCount = 0;
                                for (let j = lastContentIndex + 1; j < pass1.length; j++) {
                                    if (pass1[j].trim() === '') {
                                        blankCount++;
                                    }
                                }

                                // Keep exactly one blank line before trailing comments
                                // Remove this blank if we already have one or more
                                if (blankCount >= 1) {
                                    keepBlank = false;
                                }
                            }
                        }
                    }
                } // End of else block for non-multi-line-block logic

                if (keepBlank) {
                    pass1.push(line);
                    prevWasComment = false;
                }
            }

            // Skip this blank line (compact)
            prevWasComment = false;
            continue;
        }

        // --- Handle Non-Blank Lines ---

        // Track if this line starts a multi-line block (before we set inMultiLineBlock)
        const startsMultiLineBlock = /:\s*[|>][-+]?\s*$/.test(line);

        // Detect multi-line block start (bash: |, script: |, etc.)
        if (startsMultiLineBlock) {
            inMultiLineBlock = true;
            multiLineBlockIndent = lineIndent;
        }
        // Exit multi-line block when we outdent
        else if (inMultiLineBlock && lineIndent <= multiLineBlockIndent && trimmed !== '') {
            inMultiLineBlock = false;
            multiLineBlockIndent = -1;
        }

        // 1. Step Spacing - Simplified approach
        // Skip step spacing for expanded output to preserve original spacing
        if (options.stepSpacing && !options.wasExpanded) {
            // Track when we're in steps/jobs/stages sections
            let inListSection = false;
            let listSectionIndent = -1;

            if (trimmed === 'steps:' || trimmed === 'jobs:' || trimmed === 'stages:') {
                if (!line.includes('${{')) {
                    inListSection = true;
                    listSectionIndent = lineIndent;
                }
            } else if (
                listSectionIndent >= 0 &&
                lineIndent <= listSectionIndent &&
                trimmed &&
                !trimmed.startsWith('#')
            ) {
                // We've outdented past the section
                if (trimmed !== 'steps:' && trimmed !== 'jobs:' && trimmed !== 'stages:') {
                    inListSection = false;
                    listSectionIndent = -1;
                }
            }

            // Check if current line is a list item (starts with -)
            const isListItem = /^\s*-\s+/.test(line);
            const isConditional = /^\s*-\s+\$\{\{\s*(if|else|elseif|each)\s/.test(line);

            // Check if this is an actual pipeline item (not a parameter, not immediately after conditional)
            const isPipelineItem =
                isListItem && !isConditional && (stepPattern.test(line) || /^\s*-\s+\$\{\{.*\}\}:?/.test(line));

            // Conditionals at root level should also get blank lines (they're part of the step flow)
            const isRootLevelConditional = isConditional && lastStepInStepsSection >= 0;

            // Track variables section
            if (trimmed === 'variables:' && !line.includes('${{')) {
                currentVariablesIndent = lineIndent;
            } else if (
                currentVariablesIndent >= 0 &&
                lineIndent < currentVariablesIndent &&
                trimmed &&
                !trimmed.startsWith('#')
            ) {
                // Exit variables section when we outdent below the variables: line
                currentVariablesIndent = -1;
            } else if (
                currentVariablesIndent >= 0 &&
                lineIndent === currentVariablesIndent &&
                trimmed &&
                !trimmed.startsWith('#') &&
                !trimmed.startsWith('-')
            ) {
                // Also exit if we see another key at the same level (like pool:, steps:, etc.)
                if (trimmed.endsWith(':') && trimmed !== 'variables:') {
                    currentVariablesIndent = -1;
                }
            }
            // Items in variables section are list items (starting with -) at the same indent as variables:
            const inVariablesSection =
                currentVariablesIndent >= 0 && lineIndent === currentVariablesIndent && isListItem;

            // Check if previous line was a conditional or section header
            const prevLine = pass1.length > 0 ? pass1[pass1.length - 1].trim() : '';
            const prevIsConditional = /^-\s+\$\{\{\s*(if|else|elseif|each)\s/.test(prevLine);
            const prevIsSectionHeader = prevLine === 'steps:' || prevLine === 'jobs:' || prevLine === 'stages:';

            // Check if we're transitioning from nested step back to lower indent
            // This handles cases like a step at indent 6 (inside conditional) followed by step at indent 4 (root level)
            const prevPipelineItemIndent =
                lastStepInStepsSection >= 0
                    ? lines[lastStepInStepsSection].length - lines[lastStepInStepsSection].trimStart().length
                    : -1;
            const isOutdentingToLowerLevel = isPipelineItem && prevPipelineItemIndent > lineIndent;

            // Add blank line before pipeline items OR root-level conditionals if:
            // 1. We had a previous pipeline item
            // 2. We're not right after a section header or conditional
            // 3. We're not already in a multi-line block (but starting one is OK)
            // 4. We're not in a variables section
            const wasAlreadyInMultiLineBlock = inMultiLineBlock && !startsMultiLineBlock;

            if (
                (isPipelineItem || isRootLevelConditional) &&
                lastStepInStepsSection >= 0 &&
                !prevIsSectionHeader &&
                !prevIsConditional &&
                !wasAlreadyInMultiLineBlock &&
                !inVariablesSection
            ) {
                if (pass1.length > 0 && pass1[pass1.length - 1].trim() !== '') {
                    pass1.push('');
                }
            }

            // Update tracker if this is a pipeline item (not conditionals)
            if (isPipelineItem) {
                lastStepInStepsSection = i;
            } else if (
                (trimmed === 'steps:' || trimmed === 'jobs:' || trimmed === 'stages:') &&
                !line.includes('${{')
            ) {
                // Reset when entering a new section
                lastStepInStepsSection = -1;
            }
        }

        // 2. First Block Blank Lines (skip for expanded output to preserve original spacing)
        let section2HandledThisLine = false;
        if (hasParametersAtStart && !options.wasExpanded) {
            if (!parametersEnded && i > firstNonEmptyLine) {
                if (
                    trimmed &&
                    !trimmed.startsWith('#') &&
                    !trimmed.startsWith('-') &&
                    line[0] !== ' ' &&
                    trimmed.endsWith(':')
                ) {
                    parametersEnded = true;
                }
            }

            if (parametersEnded && !foundFirstSection && topLevelSections.some((s) => trimmed === s)) {
                foundFirstSection = true;
                section2HandledThisLine = true;
                // Track if first section was a main section (stages/jobs/steps)
                const keyOnly = trimmed.includes(':') ? trimmed.substring(0, trimmed.indexOf(':') + 1).trim() : trimmed;
                const isMainSec = keyOnly === 'steps:' || keyOnly === 'stages:' || keyOnly === 'jobs:';
                if (isMainSec) {
                    foundFirstMainSection = true;
                }
                // Remove existing blanks
                while (pass1.length > 0 && pass1[pass1.length - 1].trim() === '') {
                    pass1.pop();
                }
                // Add required blanks
                for (let k = 0; k < options.firstBlockBlankLines; k++) {
                    pass1.push('');
                }
            }
        }

        // 3. Section Spacing (betweenSectionBlankLines and firstBlockBlankLines)
        // Skip for expanded output to preserve original spacing
        // Detect root sections: lines at indent 0 that are keys (end with : or have : followed by a value)
        const isRootSection =
            trimmed &&
            !trimmed.startsWith('#') &&
            !trimmed.startsWith('-') &&
            line[0] !== ' ' &&
            /^[^:]+:/.test(trimmed); // Matches keys at root level (with or without inline values)

        // Only skip if Section 2 just handled this specific line
        if (isRootSection && lastRootSectionIndex >= 0 && !section2HandledThisLine && !options.wasExpanded) {
            // Remove existing blanks before this section
            while (pass1.length > 0 && pass1[pass1.length - 1].trim() === '') {
                pass1.pop();
            }

            // Use firstBlockBlankLines for steps:, stages:, jobs: (but ONLY for the first occurrence AND only if there were parameters)
            // Use betweenSectionBlankLines for other sections (NOT for main sections after the first IF there were parameters)
            const keyOnly = trimmed.includes(':') ? trimmed.substring(0, trimmed.indexOf(':') + 1).trim() : trimmed;
            const isMainSection = keyOnly === 'steps:' || keyOnly === 'stages:' || keyOnly === 'jobs:';

            // Only apply firstBlockBlankLines to the FIRST main section encountered when there are parameters
            const isFirstMainSection =
                isMainSection && !foundFirstMainSection && hasParametersAtStart && parametersEnded;

            if (isFirstMainSection) {
                foundFirstMainSection = true;
            }

            // Determine blank lines to add:
            // - First main section with parameters: firstBlockBlankLines
            // - Main sections (steps/jobs/stages): always at least 1 blank line
            // - All other cases: betweenSectionBlankLines
            let blankLinesToAdd;
            if (isFirstMainSection) {
                blankLinesToAdd = options.firstBlockBlankLines;
            } else if (isMainSection) {
                // Always add at least 1 blank line before steps/jobs/stages
                blankLinesToAdd = 1;
            } else {
                blankLinesToAdd = options.betweenSectionBlankLines;
            }

            if (isFirstMainSection) {
                foundFirstSection = true;
            }

            for (let k = 0; k < blankLinesToAdd; k++) {
                pass1.push('');
            }
        }
        if (isRootSection) {
            lastRootSectionIndex = pass1.length;
        }

        // Ensure at least 1 blank line before jobs: and steps: (at any indent level, not just root)
        // Skip for expanded output to preserve original spacing
        const isJobsOrSteps = trimmed === 'jobs:' || trimmed === 'steps:';
        if (isJobsOrSteps && lineIndent > 0 && !section2HandledThisLine && !options.wasExpanded) {
            // Check if there's already a blank line before this
            let hasBlankBefore = false;
            if (pass1.length > 0 && pass1[pass1.length - 1].trim() === '') {
                hasBlankBefore = true;
            }

            // If no blank line exists, add one
            if (!hasBlankBefore) {
                pass1.push('');
            }
        }

        // Before adding the line, check if we need to add a blank before trailing comments
        if (trimmed.startsWith('#')) {
            // Check if this is the start of a trailing comment block
            let isTrailingComment = true;

            // Look ahead to see if there's any non-comment content after this
            for (let j = i + 1; j < lines.length; j++) {
                const futureLine = lines[j].trim();
                if (futureLine !== '' && !futureLine.startsWith('#')) {
                    isTrailingComment = false;
                    break;
                }
            }

            if (isTrailingComment) {
                // Check if there's content before (not just other comments)
                let hasContentBefore = false;
                for (let j = pass1.length - 1; j >= 0; j--) {
                    const prevLine = pass1[j].trim();
                    if (prevLine !== '' && !prevLine.startsWith('#')) {
                        hasContentBefore = true;
                        break;
                    }
                }

                if (hasContentBefore) {
                    // Check if we already have a blank line before this comment
                    const lastLine = pass1.length > 0 ? pass1[pass1.length - 1] : null;
                    const needsBlank = lastLine && lastLine.trim() !== '';

                    if (needsBlank) {
                        pass1.push('');
                    }
                }
            }
        }

        // Add non-blank line
        pass1.push(line);
        prevWasComment = trimmed.startsWith('#');

        // Remove blank lines immediately after parent keys
        if (parentKeys.some((pk) => trimmed === pk || trimmed.startsWith(pk + ' '))) {
            // Skip subsequent blank lines
            while (i + 1 < lines.length && lines[i + 1].trim() === '') {
                i++;
            }
        }
    }

    // Compact blank lines between list items that share the same indent when the parent section is
    // not steps/jobs/stages. This prevents the formatter from inserting extra spacing inside lists
    // like dependsOn while leaving deliberate step/job spacing intact.
    const compacted = [];
    const sectionStack = [];
    const mainListSections = new Set(['steps', 'jobs', 'stages']);

    const findPreviousNonBlankLine = (arr, startIndex) => {
        for (let idx = startIndex; idx >= 0; idx--) {
            if (arr[idx].trim() !== '') {
                return idx;
            }
        }
        return null;
    };

    for (let i = 0; i < pass1.length; i++) {
        const line = pass1[i];
        const trimmed = line.trim();
        const indent = line.length - line.trimStart().length;

        // Maintain a simple section stack keyed by indent for the nearest mapping header
        while (sectionStack.length && sectionStack[sectionStack.length - 1].indent >= indent) {
            sectionStack.pop();
        }
        if (trimmed && !trimmed.startsWith('-') && trimmed.endsWith(':')) {
            sectionStack.push({ name: trimmed.slice(0, -1), indent });
        }

        if (trimmed === '') {
            const prevIdx = findPreviousNonBlankLine(pass1, i - 1);
            const nextIdx = findNextNonBlankLine(pass1, i + 1);

            if (prevIdx !== null && nextIdx !== null) {
                const prevLine = pass1[prevIdx];
                const nextLine = pass1[nextIdx];
                const prevIsList = /^-\s+/.test(prevLine.trimStart());
                const nextIsList = /^-\s+/.test(nextLine.trimStart());
                const currentSection = sectionStack.length ? sectionStack[sectionStack.length - 1].name : null;
                const insideMainListSection = currentSection && mainListSections.has(currentSection);

                // Drop blank lines between list items unless we're in steps/jobs/stages
                // (indent may differ when transitioning between nested lists, which we still want compacted)
                if (prevIsList && nextIsList && !insideMainListSection) {
                    continue;
                }
            }
        }

        compacted.push(line);
    }

    let finalResult = compacted.join(newline);

    return finalResult;
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

    // Check for file-level formatting directives
    const directives = parseFormatDirectives(content);

    // If formatting is disabled via file directive, return original content
    // unless the caller explicitly passed options (caller intent should override file directive).
    if (directives.disabled && (!options || Object.keys(options).length === 0)) {
        return baseResult;
    }

    // Merge directive options with provided options (directives take precedence)
    if (directives.options) {
        options = { ...options, ...directives.options };
    }

    const effective = {
        noArrayIndent: options && typeof options.noArrayIndent === 'boolean' ? options.noArrayIndent : true,
        indent: options && Number.isInteger(options.indent) && options.indent > 0 ? options.indent : 2,
        lineWidth:
            options && typeof options.lineWidth === 'number' && options.lineWidth >= 0
                ? options.lineWidth === 0
                    ? -1
                    : options.lineWidth
                : -1,
        forceQuotes: options && typeof options.forceQuotes === 'boolean' ? options.forceQuotes : false,
        sortKeys: options && typeof options.sortKeys === 'boolean' ? options.sortKeys : false,
        expandTemplates: options && typeof options.expandTemplates === 'boolean' ? options.expandTemplates : false,
        newlineFormat:
            options &&
            typeof options.newlineFormat === 'string' &&
            (options.newlineFormat === '\n' || options.newlineFormat === '\r\n')
                ? options.newlineFormat
                : '\n',
        fileName: options && options.fileName ? options.fileName : undefined,
        // Pipeline-specific formatting options
        stepSpacing: options && typeof options.stepSpacing === 'boolean' ? options.stepSpacing : true,
        firstBlockBlankLines:
            options && Number.isInteger(options.firstBlockBlankLines) && options.firstBlockBlankLines >= 0
                ? Math.min(options.firstBlockBlankLines, 4)
                : 2,
        betweenSectionBlankLines:
            options && Number.isInteger(options.betweenSectionBlankLines) && options.betweenSectionBlankLines >= 0
                ? Math.min(options.betweenSectionBlankLines, 4)
                : options &&
                    Number.isInteger(options.blankLinesBetweenSections) &&
                    options.blankLinesBetweenSections >= 0
                  ? Math.min(options.blankLinesBetweenSections, 4)
                  : 1,
        sectionSpacing: options && typeof options.sectionSpacing === 'boolean' ? options.sectionSpacing : false,
        wasExpanded: options && typeof options.wasExpanded === 'boolean' ? options.wasExpanded : false,
        azureCompatible: options && typeof options.azureCompatible === 'boolean' ? options.azureCompatible : false,
    };

    try {
        let inputContent = content;

        const { content: preprocessedContent, placeholderMap } = effective.expandTemplates
            ? { content: inputContent, placeholderMap: new Map() }
            : replaceTemplateExpressionsWithPlaceholders(inputContent);

        const { content: protectedContent, commentMap } = protectEmptyValues(preprocessedContent);

        const doc = YAML.parseDocument(protectedContent, { strict: false, uniqueKeys: false });

        if (doc.errors && doc.errors.length > 0) {
            const genuineErrors = doc.errors.filter(
                (e) => !e.message || !e.message.includes('Invalid escape sequence')
            );

            if (genuineErrors.length > 0) {
                const errorMessages = genuineErrors.map((e) => e.message).join(', ');
                const filePrefix = effective.fileName ? `[${effective.fileName}] ` : '';
                console.error(`${filePrefix}YAML parsing error:`, errorMessages);
                return {
                    text: content,
                    warning: undefined,
                    error: errorMessages.length > 100 ? errorMessages.substring(0, 100) + '...' : errorMessages,
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
            warning: undefined,
            error: undefined,
        };
    } catch (error) {
        const syntaxMessage = describeYamlSyntaxError(error);
        const filePrefix = effective.fileName ? `[${effective.fileName}] ` : '';

        if (syntaxMessage) {
            console.error(`${filePrefix}${syntaxMessage}`);
            return {
                text: content,
                warning: undefined,
                error: syntaxMessage,
            };
        }

        console.error(`${filePrefix}YAML formatting failed:`, error.message);
        return {
            text: content,
            warning: undefined,
            error: `YAML formatting failed: ${error.message}`,
        };
    }
}

module.exports = {
    formatYaml,
    escapeRegExp,
    replaceTemplateExpressionsWithPlaceholders,
    restoreTemplateExpressions,
};
