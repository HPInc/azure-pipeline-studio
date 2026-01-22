# Edge Cases Coverage - full-test.yaml

## Overview
The `full-test.yaml` file now includes comprehensive edge case coverage for both formatting and template expansion testing.

## Edge Cases Covered

### 1. Expression Spacing Variations
✅ **No spaces**: `${{parameters.buildConfiguration}}`
✅ **Already spaced**: `${{ parameters.pool }}`
✅ **Extra spaces**: `${{  parameters.enabled  }}`
✅ **Tabs in expression**: `${{	parameters.enabled	}}`
✅ **Multiple expressions in one line**: `'${{ parameters.buildConfiguration }}-${{ parameters.message }}'`

### 2. Parameter Types
✅ **String parameters**: buildConfiguration, message, pool
✅ **Boolean parameters**: enabled
✅ **Number parameters**: timeout
✅ **Object parameters**: environments (with nested values)
✅ **Array parameters**: values list in buildConfiguration

### 3. Complex Conditions
✅ **Simple condition**: `${{ parameters.enabled }}`
✅ **AND condition**: `and(succeeded(), ${{ parameters.enabled }})`
✅ **Nested conditions**: `and(eq('${{ parameters.buildConfiguration }}', 'Release'))`
✅ **Multi-line conditions** with or/and operators
✅ **Complex dependencies**: `in(dependencies.Build.result, 'Succeeded', 'SucceededWithIssues')`

### 4. Script Content Preservation
✅ **Bash scripts** with heredocs
✅ **Nested heredocs** (heredoc within heredoc)
✅ **Python scripts** with:
   - Multiple functions
   - Proper indentation
   - String formatting with expressions
   - JSON output
✅ **Long command lines** (>80 characters) that should not wrap
✅ **Mixed quotes**: single quotes, double quotes, backticks

### 5. Template Expression Insertions
✅ **${{ if }} blocks**: Conditional step insertion
✅ **Nested ${{ if }}**: Multiple conditional insertions
✅ **Expression in dash list**: `- ${{ insert }}`
✅ **Multiple insert expressions** in sequence

### 6. Comment Preservation
✅ **Top-level comments**: Main pipeline description
✅ **Inline comments**: `# No spaces - should be normalized`
✅ **Step comments**: Comments before steps
✅ **Multi-line comment blocks**
✅ **Comments in various sections**: trigger, parameters, variables, stages, jobs, steps

### 7. Long Lines
✅ **Command lines >80 chars**: Test commands with multiple flags
✅ **Long displayName**: Multiple expressions in display names
✅ **Long artifact names**: Combined expressions
✅ **Long conditions**: Complex condition expressions

### 8. Expression in Different Contexts
✅ **In displayName**: `Deploy ${{ parameters.message }} App`
✅ **In inputs**: `arguments: '--configuration ${{ parameters.buildConfiguration }}'`
✅ **In condition**: `condition: ${{ parameters.enabled }}`
✅ **In env variables**: `CONFIG: '${{parameters.buildConfiguration}}'`
✅ **In pool.vmImage**: `vmImage: ${{ parameters.pool }}`
✅ **In artifact names**: `ArtifactName: 'drop-${{ parameters.buildConfiguration }}'`
✅ **In task names**: `name: Task_${{ replace(parameters.buildConfiguration, 'Release', 'Rel') }}`
✅ **In timeoutInMinutes**: `timeoutInMinutes: ${{parameters.timeout}}`

### 9. Complex Pipeline Structure
✅ **Trigger configuration**: Multiple branches with wildcards
✅ **6 parameter definitions**: Various types
✅ **Variables with expressions**
✅ **3 stages**: Build, Deploy, EdgeCases
✅ **Multiple jobs per stage**: Including deployment job
✅ **Deployment strategies**: runOnce with deploy
✅ **Job dependencies**: dependsOn between stages
✅ **12+ steps** per job with various task types

### 10. Formatting Edge Cases
✅ **Empty lines preservation**: Blank lines in scripts
✅ **Indentation preservation**: Python and Bash code blocks
✅ **Step spacing**: Automatic spacing between steps (can be disabled)
✅ **Property preservation**: displayName, inputs, condition, continueOnError
✅ **Idempotence**: Formatting output should be stable

### 11. Expansion Edge Cases
✅ **String replacement**: Parameters expanded in strings
✅ **Boolean expansion**: True/False values expanded
✅ **Number expansion**: Numeric parameter values
✅ **Nested object access**: `parameters.environments.prod` (commented out due to YAML limitations)
✅ **Conditional compilation**: ${{ if }} blocks evaluated and inserted/removed
✅ **Expression functions**: replace(), eq(), ne(), and(), or(), startsWith(), endsWith()

### 12. Special Characters and Escaping
✅ **Single quotes** in expressions: `'${{ parameters.buildConfiguration }}'`
✅ **Double quotes** in bash: `echo "Config: ${{ parameters.buildConfiguration }}"`
✅ **Colons after expressions**: Proper spacing normalization
✅ **JSON in heredocs**: Special characters preserved
✅ **Shell variables vs expressions**: Distinction maintained

### 13. Azure Pipeline Specific Features
✅ **Trigger branches** with wildcards: `feature/*`, `release/*`
✅ **Parameter validation**: values list
✅ **Variable references**: `$(solution)`, `$(Build.ArtifactStagingDirectory)`
✅ **Built-in variables**: `$(Build.SourceBranch)`, `$(Pipeline.Workspace)`
✅ **Task versions**: `@1`, `@2` suffixes
✅ **Environment deployments**: With strategy block
✅ **Artifact publishing**: PathtoPublish, ArtifactName

## Test Coverage Matrix

| Feature | Formatting Test | Expansion Test | Edge Case Test |
|---------|----------------|----------------|----------------|
| Comment Preservation | ✅ Test 1 | - | ✅ Throughout |
| Step Spacing | ✅ Test 2, 11 | - | ✅ All stages |
| Long Lines | ✅ Test 3 | - | ✅ Step 4, 12 |
| Scripts (Bash/Python) | ✅ Test 4 | - | ✅ Steps 5-6 |
| Expression Spacing | ✅ Test 5, 13 | - | ✅ Variables |
| YAML Validity | ✅ Test 6 | - | ✅ Full file |
| Parameter Expansion | - | ✅ Test 7, 10 | ✅ All expressions |
| Complex Structure | ✅ Test 8 | - | ✅ 3 stages |
| Idempotence | ✅ Test 9 | - | - |
| Format + Expand | - | ✅ Test 10 | - |
| Properties | ✅ Test 12 | - | ✅ Throughout |

## File Statistics

**full-test.yaml**:
- **Lines**: ~367
- **Stages**: 3 (Build, Deploy, EdgeCases)
- **Jobs**: 4
- **Steps**: 30+
- **Parameters**: 6
- **Variables**: 6
- **Comments**: 20+
- **Template Expressions**: 50+
- **Script Blocks**: 5+
- **Format Directive**: `# aps-format=false` (prevents auto-formatting of test input)

## Format Suppression

All test input YAML files include the `# aps-format=false` directive at the top to prevent auto-formatting. This ensures:
- Test files maintain their exact formatting for testing purposes
- Edge cases like intentional spacing variations are preserved
- Tests validate the formatter behavior accurately without interference

**Files with format suppression** (15 files):
- full-test.yaml
- heredoc.yaml
- quote-preservation-clean.yaml
- boolean-compat.yaml
- boolean-edge-cases.yaml
- non-azure-compat-chomping.yaml
- non-azure-compat-heredoc.yaml
- expressions-basic.yaml
- expressions-conditional.yaml
- expressions-strings.yaml
- block-chomping-keep.yaml
- block-chomping-clip.yaml
- block-chomping-literal.yaml
- trailing-newlines.yaml
- trailing-newlines-params.yaml

## Validation

All 13 tests pass with this comprehensive coverage:
```
Total: 13 tests
Passed: 13
Failed: 0
```

## Benefits

1. **Single source of truth** for formatting and expansion testing
2. **Realistic pipeline** that mimics actual Azure DevOps usage
3. **Edge cases in context** rather than isolated snippets
4. **Reusable** for manual testing and debugging
5. **Self-documenting** with comments explaining each edge case
6. **Maintainable** - one file to update instead of multiple inline test strings
7. **Extensible** - easy to add new edge cases as discovered

## Future Edge Cases to Consider

- [ ] Resource references (repositories, containers, etc.)
- [ ] Template references to external files
- [ ] Compile-time expressions vs runtime variables
- [ ] Each: loops with template expressions
- [ ] Matrix strategy with expressions
- [ ] Service connections with expressions
- [ ] Lockfile behavior with expressions
- [ ] Stage/job filtering with expressions

## See Also

- [TEST_COVERAGE_MAPPING.md](TEST_COVERAGE_MAPPING.md) - Mapping of old to new tests
- [REFACTORING_COMPLETE.md](REFACTORING_COMPLETE.md) - Overall refactoring summary
- [test-formatting-expansion.js](test-formatting-expansion.js) - Test implementation
