# Compile-Time Variables Feature

Azure Pipeline Studio now supports setting compile-time variables (like `Build.Reason`, `Build.SourceBranch`, etc.) that are available during template expansion. This allows you to test how your pipeline behaves under different Azure DevOps build conditions.

## Why Use This Feature?

Azure Pipelines use compile-time variables to make decisions during template expansion. For example:
- `Build.Reason` - Why the build was triggered (Manual, IndividualCI, Schedule, ResourceTrigger, etc.)
- `Build.SourceBranch` - The branch being built (refs/heads/main, refs/heads/feature/xyz, etc.)
- `Build.BuildNumber` - The build number
- `System.TeamProject` - The project name

By setting these variables, you can:
1. Test conditional logic in templates (`${{ if }}` expressions)
2. Verify variable evaluations (`in()`, `eq()`, `and()`, etc.)
3. Preview how your pipeline expands in different scenarios
4. Debug template expansion issues

## Usage

### Command Line Interface (CLI)

Use the `-v` or `--variables` option to set variables:

```bash
# Single variable
node extension.js pipeline.yaml -x -v "Build.Reason=Manual"

# Multiple variables
node extension.js pipeline.yaml -x \
  -v "Build.Reason=IndividualCI" \
  -v "Build.SourceBranch=refs/heads/main" \
  -v "parameters.trunkBranch=refs/heads/main" \
  -o expanded.yaml

# With repository mapping
node extension.js codeway.yaml -x \
  -r templates=/path/to/templates \
  -v "Build.Reason=Schedule" \
  -v "Build.SourceBranch=refs/heads/develop" \
  -o expanded.yaml
```

### VS Code Extension

1. Open **Settings** (Ctrl+,)
2. Search for "Azure Pipeline Studio"
3. Find **Expansion: Variables**
4. Click "Edit in settings.json"
5. Add your variables:

```json
{
  "azurePipelineStudio.expansion.variables": {
    "Build.Reason": "IndividualCI",
    "Build.SourceBranch": "refs/heads/main",
    "Build.BuildNumber": "20231213.1",
    "System.TeamProject": "MyProject"
  }
}
```

6. Open or save your pipeline file to see the updated expansion

## Examples

### Example 1: Testing Build Triggers

**Pipeline YAML:**
```yaml
variables:
- name: isAutomated
  value: ${{ in(variables['Build.Reason'], 'IndividualCI', 'Schedule', 'ResourceTrigger') }}
- name: isManual
  value: ${{ eq(variables['Build.Reason'], 'Manual') }}
- ${{ if eq(variables['Build.Reason'], 'Schedule') }}:
  - name: scheduledBuild
    value: true

steps:
- ${{ if eq(variables['Build.Reason'], 'Manual') }}:
  - script: echo "Manual build triggered by user"
- ${{ if in(variables['Build.Reason'], 'IndividualCI', 'Schedule') }}:
  - script: echo "Automated build"
```

**Test as Manual Build:**
```bash
node extension.js pipeline.yaml -x -v "Build.Reason=Manual" -o manual.yaml
```

**Result:**
```yaml
variables:
- name: isAutomated
  value: false
- name: isManual
  value: true

steps:
- script: echo "Manual build triggered by user"
```

**Test as Schedule Build:**
```bash
node extension.js pipeline.yaml -x -v "Build.Reason=Schedule" -o schedule.yaml
```

**Result:**
```yaml
variables:
- name: isAutomated
  value: true
- name: isManual
  value: false
- name: scheduledBuild
  value: true

steps:
- script: echo "Automated build"
```

### Example 2: Branch-Based Logic

**Pipeline YAML:**
```yaml
variables:
- name: isMainBranch
  value: ${{ eq(variables['Build.SourceBranch'], 'refs/heads/main') }}
- name: isFeatureBranch
  value: ${{ startsWith(variables['Build.SourceBranch'], 'refs/heads/feature/') }}

stages:
- ${{ if eq(variables['Build.SourceBranch'], 'refs/heads/main') }}:
  - stage: Deploy
    jobs:
    - job: DeployProduction
      steps:
      - script: echo "Deploying to production"

- ${{ if startsWith(variables['Build.SourceBranch'], 'refs/heads/feature/') }}:
  - stage: Test
    jobs:
    - job: RunTests
      steps:
      - script: echo "Running feature tests"
```

**Test with main branch:**
```bash
node extension.js pipeline.yaml -x -v "Build.SourceBranch=refs/heads/main" -o main.yaml
```

**Test with feature branch:**
```bash
node extension.js pipeline.yaml -x -v "Build.SourceBranch=refs/heads/feature/new-api" -o feature.yaml
```

### Example 3: Combined Conditions

**Pipeline YAML:**
```yaml
variables:
- name: autoTrunkBuild
  value: ${{ in(variables['Build.Reason'], 'IndividualCI', 'Schedule', 'ResourceTrigger') }}
- name: manualTrunkBuild
  value: ${{ and(eq(variables['Build.Reason'], 'Manual'), eq(variables['Build.SourceBranch'], parameters.trunkBranch)) }}
- ${{ if and(in(variables['Build.Reason'], 'IndividualCI', 'Schedule'), eq(variables['Build.SourceBranch'], 'refs/heads/main')) }}:
  - name: releaseBuild
    value: true
```

**Test as automated trunk build:**
```bash
node extension.js pipeline.yaml -x \
  -v "Build.Reason=IndividualCI" \
  -v "Build.SourceBranch=refs/heads/main" \
  -v "parameters.trunkBranch=refs/heads/main" \
  -o automated-trunk.yaml
```

**Result:**
```yaml
variables:
- name: autoTrunkBuild
  value: true
- name: manualTrunkBuild
  value: false
- name: releaseBuild
  value: true
```

**Test as manual trunk build:**
```bash
node extension.js pipeline.yaml -x \
  -v "Build.Reason=Manual" \
  -v "Build.SourceBranch=refs/heads/main" \
  -v "parameters.trunkBranch=refs/heads/main" \
  -o manual-trunk.yaml
```

**Result:**
```yaml
variables:
- name: autoTrunkBuild
  value: false
- name: manualTrunkBuild
  value: true
```

## Common Variables

Here are commonly used Azure Pipeline compile-time variables:

| Variable | Example Value | Description |
|----------|---------------|-------------|
| `Build.Reason` | `Manual`, `IndividualCI`, `Schedule`, `ResourceTrigger`, `PullRequest` | Why the build was triggered |
| `Build.SourceBranch` | `refs/heads/main`, `refs/heads/feature/xyz` | Source branch reference |
| `Build.SourceBranchName` | `main`, `feature/xyz` | Source branch name |
| `Build.BuildNumber` | `20231213.1` | Build number |
| `Build.BuildId` | `12345` | Unique build ID |
| `System.TeamProject` | `MyProject` | Project name |
| `System.PullRequest.TargetBranch` | `refs/heads/main` | PR target branch |

## Tips

1. **Debug Mode**: Use `-d` flag with CLI to see which variables are being used:
   ```bash
   node extension.js pipeline.yaml -x -d -v "Build.Reason=Manual"
   ```

2. **Parameters vs Variables**: Parameters use `parameters.name` syntax, variables use `variables['name']` syntax

3. **Testing Multiple Scenarios**: Create shell scripts to test multiple scenarios:
   ```bash
   #!/bin/bash
   # test-all-scenarios.sh
   
   echo "Testing Manual build..."
   node extension.js pipeline.yaml -x -v "Build.Reason=Manual" -o manual.yaml
   
   echo "Testing CI build..."
   node extension.js pipeline.yaml -x -v "Build.Reason=IndividualCI" -o ci.yaml
   
   echo "Testing Scheduled build..."
   node extension.js pipeline.yaml -x -v "Build.Reason=Schedule" -o schedule.yaml
   ```

4. **VS Code Workspace Settings**: You can set different variables per workspace by adding them to `.vscode/settings.json`:
   ```json
   {
     "azurePipelineStudio.expansion.variables": {
       "Build.Reason": "Manual",
       "Build.SourceBranch": "refs/heads/develop"
     }
   }
   ```

## Troubleshooting

**Variables not being used:**
- Make sure you're using the `-x` or `--expand-templates` flag
- Variables must be set before template expansion happens
- Use `-d` debug flag to verify variables are being passed

**Expression not evaluating correctly:**
- Check variable name syntax: `variables['Build.Reason']` not `variables.Build.Reason`
- Verify the variable is being set (use debug mode)
- Test with the expressions test file: `node tests/expressions-test.js`

**VS Code not updating:**
- Save the file to trigger re-render
- Check that "Expansion: Expand Templates" is enabled in settings
- Verify variables are in the correct JSON format in settings

## Related

- [Microsoft Compatibility Mode](MICROSOFT_COMPATIBILITY.md)
- [Template Expansion](EXPANSION_COMPARISON.md)
- [Expression Functions](tests/expressions-test.js)
