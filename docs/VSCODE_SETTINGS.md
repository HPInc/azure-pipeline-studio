# VS Code Extension Configuration

## Format Settings

Access these settings via **File > Preferences > Settings** (or **Code > Preferences > Settings** on macOS), then search for "Azure Pipeline Studio".

### Microsoft Compatibility Mode

**Setting:** `azurePipelineStudio.format.azureCompatible`  
**Type:** Boolean  
**Default:** `false`

Enables Microsoft-compatible formatting to match Azure DevOps template expansion behavior:
- Converts `bash: |` to `script: >-` (only when `${{}}` expressions are present)
- Adds blank lines between commands in folded scalars
- Converts task `inputs.script` to single-line format with `\n` separators

**When to enable:**
- Comparing your output with Microsoft's template expansion
- Need UI-readable scripts with blank lines between commands
- Working with templates that use `${{}}` parameters

**Example:**

```json
{
  "azurePipelineStudio.format.azureCompatible": true
}
```

### Other Format Settings

- **`format.indent`** (default: `2`) - Number of spaces for indentation
- **`format.noArrayIndent`** (default: `true`) - Control sequence indentation
- **`format.stepSpacing`** (default: `true`) - Add blank lines after each step
- **`format.forceQuotes`** (default: `false`) - Wrap all strings in quotes
- **`format.sortKeys`** (default: `false`) - Sort mapping keys alphabetically
- **`format.lineWidth`** (default: `0`) - Preferred line width (0 = no wrapping)
- **`format.firstBlockBlankLines`** (default: `2`) - Blank lines before first section
- **`format.blankLinesBetweenSections`** (default: `1`) - Blank lines between root sections

## Expansion Settings

### Template Expansion

**Setting:** `azurePipelineStudio.expansion.expandTemplates`  
**Type:** Boolean  
**Default:** `true`

Controls whether template references and parameters are expanded when showing rendered YAML.

**When to disable:**
- You want to see the YAML structure without template expansion
- Debugging template references
- Faster rendering for large templates

**Example:**

```json
{
  "azurePipelineStudio.expansion.expandTemplates": false
}
```

## Usage in File Directives

You can also control formatting per-file using directives at the top of your YAML:

```yaml
# azure-pipeline-formatter: azureCompatible=true, indent=2

parameters:
  - name: environment
    default: dev

steps:
  - bash: |
      echo "${{ parameters.environment }}"
```

## Command Palette

Access formatting commands via **Ctrl+Shift+P** (or **Cmd+Shift+P** on macOS):

- **Azure Pipeline Studio: Format YAML** - Format the current YAML file
- **Azure Pipeline Studio: Show Rendered YAML** - Expand and show rendered YAML with template expansion
- **Azure Pipeline Studio: Configure Resource Locations** - Map repository resources to local directories

## Keyboard Shortcuts

- **Format Document:** `Shift+Alt+F` (Windows/Linux) or `Shift+Option+F` (macOS)
- **Show Rendered YAML:** No default shortcut (can be configured via keyboard shortcuts)

## Settings JSON Example

Complete example of common settings:

```json
{
  "azurePipelineStudio.format.azureCompatible": true,
  "azurePipelineStudio.format.indent": 2,
  "azurePipelineStudio.format.stepSpacing": true,
  "azurePipelineStudio.format.blankLinesBetweenSections": 1,
  "azurePipelineStudio.expansion.expandTemplates": true,
  "azurePipelineStudio.refreshOnSave": true
}
```
