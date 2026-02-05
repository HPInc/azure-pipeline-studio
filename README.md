# Azure Pipeline Studio

![Menu](images/menu.png)
![Error](images/error.png)

VS Code extension and CLI tool for formatting and expanding Azure DevOps YAML pipelines with complete expression support.

## Features

- **Template Expansion**: Expand pipelines with shared templates and repository resources
- **Compile-Time Variables**: Set Azure Pipeline variables (Build.Reason, Build.SourceBranch, etc.) to test different build scenarios (see [docs/COMPILE_TIME_VARIABLES.md](docs/COMPILE_TIME_VARIABLES.md))
- **Dependency Visualization**: View stage and job dependencies in a clear, structured format
- **Parameter Validation**: Automatic validation ensures all required template parameters are provided
- **Expression Evaluation**: All 33 Azure DevOps expression functions (`${{ }}`, `$[]`, `$()`)
- **Advanced Formatting**: Customizable indentation, line width, array formatting, native comment preservation
- **Modern YAML Parser**: Uses `yaml` package (v2.x) with full comment support
- **CLI & Pre-commit**: Batch processing, recursive formatting, git hook integration
- **Side-by-Side View**: Inspect rendered YAML while editing source
- **Repository Mapping**: Configure local paths for template resolution

## Installation

**VS Code Extension:**
```bash
code --install-extension azure-pipeline-studio-1.0.0.vsix
```

**CLI (Standalone):**
```bash
# Already bundled - use extension-bundle.js directly
node extension-bundle.js --help
```

**Pre-commit Hook:**
```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/HPInc/azure-pipeline-studio.git
    rev: v1.0.10
    hooks:
      - id: azure-pipeline-formatter
```

## Quick Start

### VS Code
1. Open a `.yml`/`.yaml` pipeline file
2. Right-click → **Azure Pipeline Studio** → **Format YAML** or **Expand Pipeline**
3. Configure repository paths via **Configure Resource Locations**
4. Use **Expand Pipeline (Azure Compatible)** for Azure DevOps-compatible output

### CLI
```bash
# Format file in-place
node extension-bundle.js pipeline.yml

# Format with options
node extension-bundle.js pipeline.yml -f indent=4 -f noArrayIndent=false

# Expand templates with variables
node extension-bundle.js pipeline.yml -x \
  -v "Build.Reason=Manual" \
  -v "Build.SourceBranch=refs/heads/main" \
  -o expanded.yml

# Recursive format
node extension-bundle.js -R ./pipelines -f indent=4

# With output file
node extension-bundle.js pipeline.yml -o formatted.yml

# Map repository templates
node extension-bundle.js pipeline.yml -x -r templates=../shared-templates
```

### Pre-commit
```bash
pip install pre-commit
pre-commit install
pre-commit run azure-pipeline-formatter --all-files
```

## VS Code Configuration

**Format Settings:**
- `azurePipelineStudio.format.indent` (1-8, default: 2)
- `azurePipelineStudio.format.noArrayIndent` (boolean, default: true)
- `azurePipelineStudio.format.lineWidth` (number, default: 0)
- `azurePipelineStudio.format.stepSpacing` (boolean, default: true)
- `azurePipelineStudio.format.firstBlockBlankLines` (0-4, default: 2)
- `azurePipelineStudio.format.blankLinesBetweenSections` (0-4, default: 1)
- `azurePipelineStudio.format.azureCompatible` (boolean, default: false)

**Expansion Settings:**
- `azurePipelineStudio.expansion.expandTemplates` (boolean, default: true)
- `azurePipelineStudio.expansion.variables` (object, default: {})

**Repository Locations:**
```json
{
  "azurePipelineStudio.resourceLocations": [
    {"repository": "templates", "location": "${workspaceFolder}/../shared"}
  ],
  "azurePipelineStudio.expansion.variables": {
    "Build.Reason": "Manual",
    "Build.SourceBranch": "refs/heads/main"
  }
}
```

## Commands

All commands are available via:
- Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
- Right-click context menu → **Azure Pipeline Studio**

Available commands:
- **Format YAML** - Format the current file in-place
- **Expand Pipeline (Standard)** - Expand templates and expressions with user settings
- **Expand Pipeline (Azure Compatible)** - Expand with Azure DevOps-compatible formatting (literal blocks, capitalized booleans)
- **Show Dependencies** - Analyze and display pipeline dependencies (stages, jobs, templates, resources)
- **Configure Resource Locations** - Set up repository paths for template resolution

## Configuration

### Formatting Options

Configure YAML formatting via VS Code settings (File → Preferences → Settings):

- `azurePipelineStudio.format.indent` - Number of spaces for indentation, 1-8 (default: `2`)
- `azurePipelineStudio.format.lineWidth` - Preferred line width, 0 to disable wrapping (default: `0`)
- `azurePipelineStudio.format.noArrayIndent` - Remove indentation for array items (default: `true`)
- `azurePipelineStudio.format.stepSpacing` - Add blank lines between steps/stages/jobs (default: `true`)
- `azurePipelineStudio.format.firstBlockBlankLines` - Blank lines before main sections (steps/stages/jobs), 0-4 (default: `2`)
- `azurePipelineStudio.format.blankLinesBetweenSections` - Blank lines between root sections (trigger/variables/resources/etc), 0-4 (default: `1`)
- `azurePipelineStudio.format.forceQuotes` - Force double quotes on all strings (default: `false`)
- `azurePipelineStudio.format.sortKeys` - Sort object keys alphabetically (default: `false`)
- `azurePipelineStudio.format.azureCompatible` - Use Azure DevOps-compatible formatting: literal block scalars (|), capitalized booleans, trailing blank lines (default: `false`)
- `azurePipelineStudio.refreshOnSave` - Auto-refresh rendered YAML view when source file is saved (default: `true`)

### Resource Locations

- `azurePipelineStudio.resourceLocations` - Array of repository mappings with `repository`, `location`, and optional match criteria (`name`, `endpoint`, `ref`, `type`)
- Use `@self` to reference templates in the current repository (for example `templates/build.yml@self`), resolving paths relative to the pipeline file's repository.

## Command Line Interface

Format and expand pipelines from the command line:

```bash
## CLI Options

**Help:** `-h, --help`

**Output:** `-o, --output <file>` (single file only)

**Repository:** `-r, --repo <alias=path>`

**Format:** `-f, --format-option <key=value>` (repeatable)
- `indent=<1-8>` (default: 2)
- `noArrayIndent=<true|false>` (default: true)
- `lineWidth=<number>` (default: 0)
- `stepSpacing=<true|false>` (default: true)
- `firstBlockBlankLines=<0-4>` (default: 2)
- `blankLinesBetweenSections=<0-4>` (default: 1)
- `forceQuotes=<true|false>` (default: false)
- `sortKeys=<true|false>` (default: false)

**Recursive:** `-R, --format-recursive <path>`, `-e, --extension <ext>`

### Examples

```bash
# Multiple options
node extension-bundle.js pipeline.yml -f indent=4 -f lineWidth=120

# Recursive with custom extensions
node extension-bundle.js -R ./ci -e .azure -e .ado -f indent=4
```
```

### CLI Options

**Help:**
- `-h, --help` - Show help message

**Output:**
- `-o, --output <file>` - Write to output file (only with single input file)

**Repository mapping:**
- `-r, --repo <alias=path>` - Map repository alias to local directory

**Format options:**
- `-f, --format-option <key=value>` - Set format option (can be repeated)
  - `indent=<1-8>` - Indentation spaces (default: 2)
  - `noArrayIndent=<true|false>` - Remove array indentation (default: true)
  - `lineWidth=<number>` - Line width, 0 to disable (default: 0)
  - `stepSpacing=<true|false>` - Blank lines between steps/stages/jobs (default: true)
  - `firstBlockBlankLines=<0-4>` - Blank lines before main sections (default: 2)
  - `blankLinesBetweenSections=<0-4>` - Blank lines between root sections (default: 1)
  - `forceQuotes=<true|false>` - Force quotes on strings (default: false)
  - `sortKeys=<true|false>` - Sort object keys (default: false)

**Recursive formatting:**
- `-R, --format-recursive <path>` - Format all files in directory tree
- `-e, --extension <ext>` - File extensions to format (default: .yml, .yaml)

### Examples

```bash
# Show help
node extension-bundle.js -h

# Format with 4-space indentation
node extension-bundle.js pipeline.yml -f indent=4

# Multiple format options
node extension-bundle.js pipeline.yml -f indent=4 -f noArrayIndent=false -f lineWidth=120

# Expand with repository mapping
node extension-bundle.js azure-pipelines.yml -r templates=../shared-templates -o expanded.yml

# Format recursively with custom options
node extension-bundle.js -R ./pipelines -f indent=4 -f stepSpacing=false

# Include additional file types
node extension-bundle.js -R ./ci -e .azure -e .ado

# Format multiple files at once
node extension-bundle.js file1.yml file2.yml file3.yml -f indent=4
```

## Pre-commit Hook

Automatically format YAML files before commit. Uses 282KB standalone bundle with auto Node.js installation.

**Setup:**
```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/HPInc/azure-pipeline-studio.git
    rev: v1.0.7
    hooks:
      - id: azure-pipeline-formatter
        args: [-R, ., -f, indent=4]  # Optional: customize format
```

**Install:**
```bash
pip install pre-commit && pre-commit install
pre-commit run azure-pipeline-formatter --all-files
```

## Expression Support

Complete support for all 33 Azure DevOps expression functions across compile-time (`${{ }}`), runtime (`$[]`), and variable (`$()`) expressions.

**Function Categories:**
- **Comparison** (6): `eq`, `ne`, `gt`, `ge`, `lt`, `le`
- **Logical** (4): `and`, `or`, `not`, `xor`
- **Containment** (5): `coalesce`, `contains`, `containsValue`, `in`, `notIn`
- **String** (10): `lower`, `upper`, `startsWith`, `endsWith`, `trim`, `replace`, `split`, `join`, `format`, `length`
- **Conversion** (3): `convertToJson`, `counter`, `iif`
- **Job Status** (5): `always`, `canceled`, `failed`, `succeeded`, `succeededOrFailed`

See [Microsoft's Expression Documentation](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/expressions) for details.

## File Directives

Control formatting per file using special comments in the first 5 lines:

**Disable formatting:**
```yaml
# aps-format=false
```

**Custom options:**
```yaml
# aps-format indent=4,lineWidth=120,newline=\r\n
```

**Supported Options:**
- `indent` - Spaces per level (1-8)
- `lineWidth` - Max line width (0 to disable)
- `newline` - Line ending (`\n`, `\r\n`, or `crlf`)
- `noArrayIndent` - Remove array indentation (`true`/`false`)
- `stepSpacing` - Add blank lines between steps/stages/jobs (`true`/`false`)
- `sectionSpacing` - Enable section spacing (uses blankLinesBetweenSections) (`true`/`false`)
- `forceQuotes` - Force double quotes on all strings (`true`/`false`)
- `sortKeys` - Sort object keys alphabetically (`true`/`false`)
- `preserveComments` - Keep inline comments (`true`/`false`)
- `normalizePaths` - Normalize file paths (`true`/`false`)
- `expandTemplates` - Expand template files (`true`/`false`)

**Rules:**
- Must appear in first 5 lines
- One directive per file (first match wins)
- Options are comma-separated with no spaces around `=`
- Use escape sequences for newlines: `\n`, `\r\n`, `\r`

**Note:** `firstBlockBlankLines` and `blankLinesBetweenSections` are only available in VS Code settings and CLI, not in file directives. Use `sectionSpacing=true` in file directives to enable section spacing with default values.

## Testing

Run the comprehensive test suite:

```bash
npm test              # Run all tests
```

**Test Coverage:** 74 tests covering YAML parsing, formatting, expressions, Azure compatibility, and edge cases.

See [docs/TESTING.md](docs/TESTING.md) for detailed documentation.

## Requirements

- **VS Code**: 1.64 or newer
- **Node.js**: Required for CLI usage (version 14+)

## Known Limitations

- Runtime expressions (`$[]`) are recognized but not evaluated
- Some advanced Azure DevOps features may not be fully supported

## Contributing

Issues and pull requests are welcome! Please report any bugs or feature requests on the GitHub repository.

## License

MIT

## Credits

Built with:
- [yaml](https://github.com/eemeli/yaml) - Modern YAML parser with comment preservation
- [jsep](https://github.com/EricSmekens/jsep) - JavaScript expression parser
