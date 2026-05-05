# Library Variables Feature

Azure Pipeline Studio supports Azure DevOps library variable groups during simulation. This lets you provide group-backed values that jobs, templates, and expressions can consume without needing a live Azure DevOps project.

## Why Use This Feature?

Many pipelines depend on variable groups for values such as service connection names, feed names, repository settings, and feature flags. During local simulation, those values do not exist unless you provide them.

Use library variables when you want to:

1. Simulate pipelines that reference variable groups.
2. Test conditional logic that depends on group values.
3. Reproduce expansion or simulation issues locally.
4. Provide stable inputs for repeatable CLI test runs.

## CLI Usage

Use `-l` to set a single variable and `-L` to load one or more groups from a JSON file.

### Single library variable

```bash
node extension.js pipeline.yaml --simulate \
  -l "SharedVars.feedName=my-feed"
```

### Multiple library variables

```bash
node extension.js pipeline.yaml --simulate \
  -l "GHE_Credentials.ghe_user=myuser" \
  -l "GHE_Credentials.ghe_auth_token=token-value" \
  -l "win-svc-voice-group.SonarProjectPrefix=my-prefix"
```

### Load variables from JSON

```bash
node extension.js pipeline.yaml --simulate \
  -L library-variables.json
```

Example file:

```json
{
  "GHE_Credentials": {
    "ghe_user": "myuser",
    "ghe_auth_token": "token-value"
  },
  "win-svc-voice-group": {
    "SonarProjectPrefix": "my-prefix"
  }
}
```

## Format

Single variable entries use this format:

```text
group.variable=value
```

Notes:

- The group name is the Azure DevOps variable group name.
- The variable name is the variable inside that group.
- Values are treated as strings.
- Repeated `-l` entries merge into the same in-memory map.
- Values from `-L` are loaded first; later `-l` entries can override them.

## Example Scenario

Pipeline YAML:

```yaml
variables:
- group: GHE_Credentials

steps:
- script: echo "$(ghe_user)"
```

Run locally:

```bash
node extension.js pipeline.yaml --simulate \
  -l "GHE_Credentials.ghe_user=myuser"
```

## Validation Rules

The `-L` file must be a JSON object whose keys are group names and whose values are objects containing variable name/value pairs.

Invalid example:

```json
[
  "not-valid"
]
```

Valid example:

```json
{
  "MyGroup": {
    "MyVariable": "value"
  }
}
```

## Related Options

- `--simulate` enables pipeline simulation mode.
- `--simulate-output-dir <dir>` writes simulation artifacts and working files to a directory.
- `--simulate-checkout-source <git|local>` controls how simulation jobs obtain source.
- `-v` sets compile-time variables such as `Build.Reason` and `Build.SourceBranch`.

## See Also

- [COMPILE_TIME_VARIABLES.md](COMPILE_TIME_VARIABLES.md)
- [README.md](../README.md)
