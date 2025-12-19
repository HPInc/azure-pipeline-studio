# Microsoft Compatibility Mode

## Overview

The `azureCompatible` option enables formatting that matches Microsoft's Azure DevOps template expansion behavior. When enabled, the formatter applies three key transformations to make the output match Microsoft's style.

## Usage

```javascript
const { formatYaml } = require('./formatter.js');

const yaml = `
steps:
  - bash: |
      echo "Command 1"
      echo "Command 2"
`;

const result = formatYaml(yaml, { 
    azureCompatible: true 
});
```

## Transformations

### 1. Block Scalar Conversion (Only When `${{}}` Present)

**Before:**
```yaml
parameters:
  - name: message
    default: "Hello"

steps:
  - bash: |
      echo "${{ parameters.message }}"
      echo "Line 2"
```

**After:**
```yaml
parameters:
  - name: message
    default: "Hello"

steps:
  - script: >-
      echo "${{ parameters.message }}"
      
      echo "Line 2"
```

**Important:** Microsoft converts `bash: |` (literal block scalar) to `script: >-` (folded block scalar) **only when template parameters with `${{}}` expressions are present** in the YAML file. If there are no `${{}}` expressions, `bash: |` remains unchanged.

### 2. Blank Lines Between Commands

**Before:**
```yaml
- script: >-
    echo "Command 1" echo "Command 2" echo "Command 3"
```

**After:**
```yaml
- script: >-
    echo "Command 1"
    
    echo "Command 2"
    
    echo "Command 3"
```

Microsoft adds blank lines between commands in folded scalars for better readability in the Azure DevOps UI.

### 3. Task Input Single-Line Format

**Before:**
```yaml
- task: CmdLine@2
  inputs:
    script: |
      echo "Task line 1"
      echo "Task line 2"
      set VAR=value
```

**After:**
```yaml
- task: CmdLine@2
  inputs:
    script: "echo \"Task line 1\"\\necho \"Task line 2\"\\nset VAR=value"
```

When using task syntax (e.g., `task: CmdLine@2`, `task: Bash@3`), Microsoft converts multi-line scripts in `inputs.script` to single-line strings with `\n` separators.

## When to Use

Use `azureCompatible: true` when:

- You need output that matches Microsoft's template expansion exactly
- You're comparing expanded templates from Azure DevOps
- You want blank lines between script commands for UI readability
- You're working with task inputs that should be single-line

## Limitations

- This is a best-effort approximation of Microsoft's behavior
- The formatter may not catch all edge cases
- Some complex template expansions may differ slightly

## File Directive

You can also enable Microsoft compatibility using a file directive at the top of your YAML:

```yaml
# azure-pipeline-formatter: azureCompatible=true

stages:
  - stage: Build
    jobs:
      - job: Test
        steps:
          - bash: |
              echo "Test"
```

## Implementation Details

The transformation happens in three places:

1. **Input transformation** (before YAML parsing): Converts `bash: |` → `script: >-`
2. **Post-processing** (after YAML serialization): 
   - Expands folded scalars and adds blank lines between commands
   - Converts task `inputs.script` to single-line format

See [EXPANSION_COMPARISON.md](../templates/EXPANSION_COMPARISON.md) and [SINGLE_LINE_SCRIPTS.md](../templates/SINGLE_LINE_SCRIPTS.md) for detailed analysis of Microsoft's behavior.
