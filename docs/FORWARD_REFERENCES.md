# Forward References in Variables Section

## Overview

Azure Pipeline Studio now supports forward references within the `variables:` section, matching Microsoft Azure Pipelines behavior. Variables defined earlier in the same variables section can be referenced in compile-time expressions (`${{}}`) of later variables.

## How It Works

When expanding a variables array, the parser processes variables sequentially and makes each variable available to subsequent variable definitions in the same section. This enables patterns like:

```yaml
variables:
- name: pool
  ${{ if eq(parameters.os, 'linux') }}:
    value: 'codeway-aws-linux2023'
  ${{ else }}:
    value: 'other-pool'

- name: ephemeralAgent
  ${{ if eq(variables.pool, 'codeway-aws-linux2023') }}:
    value: true
  ${{ else }}:
    value: false
```

In this example, the `ephemeralAgent` variable references `variables.pool`, which was defined earlier in the same `variables:` section.

## Example Output

When expanding with `parameters.os=linux`:

```yaml
variables:
- name: pool
  value: codeway-aws-linux2023
- name: ephemeralAgent
  value: true
```

The `ephemeralAgent` correctly evaluates to `true` because `variables.pool` equals `'codeway-aws-linux2023'`.

## Implementation Details

### Parser Changes

The `expandArray` method in `parser.js` was enhanced to:

1. Detect when it's processing a `variables` array (via the `parentKey` parameter)
2. After expanding each variable definition, extract the `name` and `value`
3. Immediately add the variable to `context.variables`
4. Make it available for subsequent `${{}}` expressions in the same array

Key code changes:

```javascript
// In expandNode()
expandNode(node, context, parentKey = null) {
    if (Array.isArray(node)) {
        return this.expandArray(node, context, parentKey);
    }
    // ...
}

// In expandArray()
expandArray(array, context, parentKey = null) {
    const isVariablesArray = parentKey === 'variables';
    
    // ... process each element ...
    
    // After expanding each element, if we're in a variables array:
    if (isVariablesArray && expandedElement && typeof expandedElement === 'object') {
        const varName = expandedElement.name;
        const varValue = this.pickFirstDefined(expandedElement.value, expandedElement.default);
        if (varName && varValue !== undefined) {
            // Make variable available to subsequent elements
            context.variables[varName] = varValue;
        }
    }
}

// In expandObject() - pass key as parentKey
const expandedValue = this.expandNode(value, context, key);
```

### Why This Matters

This feature enables:

1. **Conditional Logic Chains**: Variables can build upon each other
2. **Microsoft Compatibility**: Matches Azure Pipelines behavior exactly
3. **Template Reusability**: Common patterns like pool selection with derived properties

### Testing

Test with:

```bash
node extension.js your-pipeline.yml -x -v "parameters.os=linux" -o output.yml
```

Or programmatically:

```javascript
const parser = require('./parser.js');
const parserInstance = new parser.AzurePipelineParser();
const result = parserInstance.expandPipelineToString(sourceText, {});
```

## Limitations

- Forward references only work within the same `variables:` section
- Variables from parent scopes (templates, stages, jobs) are available through normal variable propagation
- References must be forward-only (variables can only reference earlier definitions in the same array)

## Related Features

- [Compile-Time Variables](COMPILE_TIME_VARIABLES.md) - Setting variables for expansion
- [Template Expansion](TESTING.md) - How to expand templates with variables
- [Azure Compatibility](AZURE_COMPATIBILITY.md) - Azure DevOps-specific formatting
- [VS Code Settings](VSCODE_SETTINGS.md) - Extension configuration options
