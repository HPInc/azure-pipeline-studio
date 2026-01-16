# Azure Pipeline Studio - Test Cases Documentation

## Overview
This document provides comprehensive coverage of all test cases, including edge cases, for the Azure Pipeline Studio template expansion and formatting functionality.

## Test Organization

All tests follow a consistent pattern:
- External YAML input files in `inputs/` directory
- Support for `-v`/`--verbose` flag for detailed output
- Proper exit codes (0 = pass, 1 = fail)
- Summary output with ✅/❌ indicators
- Consolidated test runner: `run-template-expansion-tests.js`

## Test Suites (10 Total)

### 1. test-heredoc.js
**Purpose**: Tests heredoc syntax preservation during template expansion

**Test Cases**:
- Heredoc with template expressions (`<<EOF`)
- Multi-line heredoc content
- Expression expansion within heredoc blocks
- Heredoc in bash scripts

**Input File**: `inputs/heredoc.yaml`

**Edge Cases Covered**:
- Heredoc delimiters preserved
- Content inside heredoc expanded correctly
- Newlines and formatting maintained

---

### 2. test-quote-preservation.js
**Purpose**: Tests that quotes around strings are maintained during template expansion, with special handling for template expressions

**Test Cases**:
- Single-quoted strings
- Double-quoted strings
- Unquoted strings
- Mixed quote scenarios
- **Full expression quotes preserved**: `'${{ parameters.x }}'` → `'Release'`
- **Mixed expression quotes removed**: `'text ${{ expr }} text'` → `text Release text`

**Input File**: `inputs/quote-preservation-clean.yaml`

**Edge Cases Covered**:
- Quotes preserved in conditions
- Quotes in parameter values
- **Full template expressions** - quotes preserved when entire value is just `${{ }}`
- **Mixed template expressions** - quotes removed when `${{ }}` is embedded in text
- Expression expansion with proper quote handling

---

### 3. test-microsoft-boolean-compatibility.js
**Purpose**: Tests Microsoft Azure Pipelines boolean value handling

**Test Cases**:
- Boolean parameter type (true/false)
- Boolean in conditions
- Boolean capitalization (True/False)
- Boolean expansion to string values

**Input Files**:
- `inputs/boolean-compat.yaml`
- `inputs/boolean-edge-cases.yaml`

**Edge Cases Covered**:
- `true`/`false` vs `True`/`False` capitalization
- Boolean in `${{ if }}` expressions
- Boolean parameter defaults
- eq() comparisons with boolean values

---

### 4. test-non-azure-compatible.js
**Purpose**: Tests non-Azure compatibility mode for standard YAML processing

**Test Cases**:
- Block scalar chomping indicators (keep `+`, strip `-`)
- Heredoc in non-compatible mode
- Standard YAML processing without Azure-specific transformations

**Input Files**:
- `inputs/non-azure-compat-chomping.yaml`
- `inputs/non-azure-compat-heredoc.yaml`

**Edge Cases Covered**:
- Chomping indicators preserved: `|+`, `|-`, `|`
- YAML block scalars handled correctly
- No Azure-specific transformations applied

---

### 5. expressions-test.js
**Purpose**: Tests Azure Pipeline template expression functions

**Test Cases**:

#### Basic Functions:
- `and()` - Logical AND
- `or()` - Logical OR
- `eq()` - Equality comparison
- `ne()` - Not equal comparison
- `contains()` - String/array contains
- `startsWith()` - String prefix check
- `endsWith()` - String suffix check

#### String Functions:
- `format()` - String formatting
- `replace()` - String replacement
- `upper()` - Uppercase conversion
- `lower()` - Lowercase conversion
- `length()` - String/array length

#### Conditional Expressions:
- `${{ if }}` - Conditional inclusion
- `${{ elseif }}` - Else-if branch
- `${{ else }}` - Else branch
- Nested conditionals

**Input Files**:
- `inputs/expressions-basic.yaml`
- `inputs/expressions-conditional.yaml`
- `inputs/expressions-strings.yaml`

**Edge Cases Covered**:
- Nested function calls
- Multiple parameters in functions
- Expression evaluation order
- Conditional compilation with complex logic

---

### 6. test-block-scalar-chomping.js
**Purpose**: Tests YAML block scalar chomping indicator handling

**Test Cases**:
- Literal block scalar with keep (`|+`) - preserves all trailing newlines
- Literal block scalar with strip (`|-`) - removes all trailing newlines
- Literal block scalar default (`|`) - keeps single trailing newline
- Folded block scalar variations

**Input Files**:
- `inputs/block-chomping-keep.yaml`
- `inputs/block-chomping-clip.yaml`
- `inputs/block-chomping-literal.yaml`

**Edge Cases Covered**:
- Multiple trailing newlines
- No trailing newlines
- Mixed content with newlines
- Chomping with indentation

---

### 7. test-trailing-newlines.js
**Purpose**: Tests trailing newline preservation in various contexts

**Test Cases**:
- Trailing newlines in values
- Trailing newlines in multiline strings
- Parameter expansion with trailing newlines
- Newline handling in different YAML styles

**Input Files**:
- `inputs/trailing-newlines.yaml`
- `inputs/trailing-newlines-params.yaml`

**Edge Cases Covered**:
- Single trailing newline
- Multiple trailing newlines
- No trailing newline
- Newlines with parameters

---

### 8. test-formatting-expansion.js (13 Tests)
**Purpose**: Comprehensive formatting and template expansion testing

**Input File**: `inputs/full-test.yaml` (367 lines, 3 stages, 30+ steps)

#### Test 1: Comment Preservation
- Top-level comments maintained
- Inline comments after values
- Comments before sections
- Multi-line comment blocks
- **Validates**: 12+ comments preserved

#### Test 2: Step Spacing in Formatted Output
- Automatic blank lines between steps
- Configurable spacing behavior
- Consistent vertical whitespace
- **Validates**: 7+ blank lines between steps

#### Test 3: Long Line Preservation
- Command lines >80 characters not wrapped
- Long displayName values preserved
- Long artifact names maintained
- **Validates**: 6+ long lines preserved

#### Test 4: Script Content Preservation
- Bash scripts with proper formatting
- Python scripts with indentation
- Heredoc blocks within scripts
- Multi-function Python code
- **Validates**: Python imports, function definitions, bash heredocs

#### Test 5: Template Expression Spacing
- Detection of `${{ }}` expressions
- Proper spacing validation
- Multiple expressions per line
- **Validates**: 18+ template expressions found

#### Test 6: Valid YAML Structure
- Output is valid parseable YAML
- Structure integrity maintained
- No syntax errors introduced
- **Validates**: YAML.parse() succeeds

#### Test 7: Template Expansion with Expressions
- Parameter values expanded correctly
- String parameters (`buildConfiguration`, `message`, `pool`)
- Boolean parameters (`enabled`)
- Number parameters (`timeout`)
- Object parameters (`environments`)
- **Validates**: Expanded values present in output

#### Test 8: Complex Pipeline Structure
- Multi-stage pipeline preserved
- Trigger configuration maintained
- Variables section intact
- Parameters definition preserved
- **Validates**: stages:, jobs:, steps:, trigger:, parameters:, variables:

#### Test 9: Formatting Idempotence
- Format(Format(X)) ≈ Format(X)
- Stable output on repeated formatting
- No accumulating changes
- **Validates**: <10% difference between iterations

#### Test 10: Format then Expand Pipeline
- Integration test: format → expand
- Parameters work after formatting
- Expressions evaluate correctly
- **Validates**: Multi-step pipeline processing

#### Test 11: Step Spacing Can Be Disabled
- `{ stepSpacing: false }` option respected
- No automatic spacing when disabled
- Configurable behavior working
- **Validates**: Minimal blank lines with option disabled

#### Test 12: DisplayName and Property Preservation
- displayName fields maintained
- inputs sections preserved
- condition properties intact
- continueOnError preserved
- **Validates**: All properties present

#### Test 13: Template Expression Spacing Normalization
- `${{foo}}` normalized to proper spacing
- Already-spaced expressions unchanged
- Consistent formatting applied
- **Validates**: Expression formatting handled

---

### 9. test-runtime-variables.js
**Purpose**: Tests runtime variable handling (variables resolved at pipeline execution time)

**Test Cases**:
- Runtime variables are not quoted
- Runtime variables in displayName
- Runtime variables in environment variables
- Mixed compile-time and runtime variables
- Runtime variables in script blocks
- Runtime variables with colons

**Input File**: `inputs/runtime-variables.yaml`

**Edge Cases Covered**:
- `$(Agent.OS)` - no quotes applied
- `$(Build.SourceBranch)` - no quotes in env
- `$(Build.Reason)` - runtime variable preservation
- Mixed `${{ parameters.x }}` (compile-time) and `$(Build.x)` (runtime)
- Runtime variables with colons like `$(System.TeamFoundationCollectionUri)`
- Azure compatible mode preserves runtime variable behavior

**Bug Fixed**: Runtime variables were being quoted, which breaks Azure Pipelines execution. Now they remain unquoted regardless of context (even when colons are present).

---

### 10. test-multilevel-templates.js
**Purpose**: Tests multi-level template expansion and quote style preservation through template boundaries

**Test Cases**:
- Stage template references
- Step template references
- Variable template references
- Multi-level template expansion (template includes template)
- Quote style preservation across template levels
- Stage/job/step index tracking through templates

**Input Files**:
- `inputs/include-stage-template.yaml`
- `inputs/include-step-template.yaml`
- `inputs/include-variable-template.yaml`
- `inputs/stage-multilevel.yaml`
- `inputs/stage-toplevel.yaml`
- `inputs/stage-secondlevel.yaml`
- `inputs/stage-template.yaml`
- `inputs/step-template.yaml`
- `inputs/variable-template.yaml`

**Edge Cases Covered**:
- Templates that include other templates (3+ levels deep)
- Conditional stages in top-level templates
- Parameter passing through template levels
- Quote style remapping for template-expanded items
- Stage/job/step index tracking for accurate quote restoration

**Bug Fixed**: Quote styles were not being correctly remapped when templates expanded to multiple items. Now uses value-based matching and proper index tracking.

---

## Edge Cases Comprehensive Coverage

### Expression Spacing Variations
✅ **No spaces**: `${{parameters.buildConfiguration}}`
✅ **Proper spacing**: `${{ parameters.pool }}`
✅ **Extra spaces**: `${{  parameters.enabled  }}`
✅ **Tabs in expression**: `${{	parameters.enabled	}}`
✅ **Multiple expressions**: `'${{ parameters.buildConfiguration }}-${{ parameters.message }}'`

### Parameter Types (6 Types)
✅ **String**: buildConfiguration, message, pool
✅ **Boolean**: enabled (true/false)
✅ **Number**: timeout (60)
✅ **Object**: environments (nested values)
✅ **Array**: values list
✅ **Default values**: All parameters have defaults

### Complex Conditions
✅ **Simple**: `${{ parameters.enabled }}`
✅ **AND**: `and(succeeded(), ${{ parameters.enabled }})`
✅ **Nested**: `and(eq('${{ parameters.buildConfiguration }}', 'Release'))`
✅ **Multi-line**: Complex condition blocks with or/and
✅ **Dependencies**: `in(dependencies.Build.result, 'Succeeded')`

### Script Content
✅ **Bash scripts** (5+ scripts):
  - `set -euo pipefail`
  - Heredoc (`cat <<EOF`)
  - Nested heredoc (`cat <<'SCRIPT'`)
  - Conditional logic
  - File creation and manipulation

✅ **Python scripts** (2+ scripts):
  - Multiple functions
  - Proper indentation (4 spaces)
  - String formatting with f-strings
  - JSON output
  - Template expressions in code

✅ **Long command lines**:
  - dotnet test with 8+ flags (>120 chars)
  - Azure CLI commands with multiple parameters

### Template Expression Contexts (12+ Contexts)
✅ In `displayName`: `Deploy ${{ parameters.message }} App`
✅ In `inputs.arguments`: `'--configuration ${{ parameters.buildConfiguration }}'`
✅ In `condition`: `${{ parameters.enabled }}`
✅ In `env` variables: `CONFIG: '${{parameters.buildConfiguration}}'`
✅ In `pool.vmImage`: `${{ parameters.pool }}`
✅ In artifact names: `'drop-${{ parameters.buildConfiguration }}'`
✅ In task names: `Task_${{ replace(...) }}`
✅ In `timeoutInMinutes`: `${{parameters.timeout}}`
✅ In stage conditions: Complex multi-line conditions
✅ In deployment strategy: Within runOnce block
✅ In variables: Multiple variable definitions
✅ In trigger branches: With wildcards

### Expression Insertion (Template Compilation)
✅ **`${{ if }}`**: Conditional step insertion
✅ **Nested `${{ if }}`**: Multiple levels
✅ **`${{ if }}...else`**: Alternative branches
✅ **Expression in dash list**: `- ${{ insert }}`
✅ **Multiple consecutive insertions**: Sequential if blocks

### Pipeline Structure (3 Stages, 4 Jobs, 30+ Steps)

**Stage 1: Build**
- 12 steps with diverse tasks
- Expression variations testing
- Script preservation testing
- Long line testing
- Complex conditions

**Stage 2: Deploy**
- Regular job (not deployment job to avoid environment validation)
- Deploy using AzureCLI task
- Post-deployment verification
- Conditional deployment
- Additional test job

**Stage 3: EdgeCases**
- Dedicated edge case validation
- Expression variations
- Special character handling
- Dynamic naming
- Multi-line expressions
- **Quote handling test cases** (13 new steps):
  - Single/double quotes with full expressions
  - Single/double quotes with mixed expressions
  - Arguments with embedded expressions
  - Environment variables with various quote scenarios
  - Bash/PowerShell scripts with quote preservation rules
  - Complex multi-expression strings

### Formatting Features
✅ **Comment preservation**: 12+ comments throughout
✅ **Step spacing**: Automatic blank lines (configurable)
✅ **Long line preservation**: 6+ lines >80 chars
✅ **Indentation**: Python/Bash code blocks maintained
✅ **Empty lines**: Preserved in scripts
✅ **Property preservation**: All task properties intact
✅ **Idempotence**: Stable formatting output

### Special Characters & Escaping
✅ **Single quotes**: `'${{ parameters.buildConfiguration }}'`
✅ **Double quotes**: `"Config: ${{ parameters.buildConfiguration }}"`
✅ **Backticks**: In mixed quote test
✅ **Colons**: After expressions with proper spacing
✅ **JSON**: In heredoc blocks
✅ **Shell variables**: `$(variable)` vs `${{ expression }}`

### Quote Handling with Template Expressions (NEW)
✅ **Full expression single quotes preserved**: `'${{ parameters.x }}'` → `'Release'`
✅ **Full expression double quotes preserved**: `"${{ parameters.x }}"` → `"ubuntu-latest"`
✅ **Mixed expression single quotes removed**: `'--configuration ${{ x }} --no-restore'` → `--configuration Release --no-restore`
✅ **Mixed expression double quotes removed**: `"text ${{ x }} text"` → `text Release text`
✅ **Multiple expressions in string**: `'/app/${{ x }}/output/${{ y }}'` → `/app/Release/output/Hello World`
✅ **Command arguments with expressions**: CLI flags with template parameters, quotes removed
✅ **Environment variables**: Both full (quotes preserved) and mixed (quotes removed) scenarios
✅ **Bash scripts with quotes**: Variable assignments with proper quote handling
✅ **PowerShell scripts with quotes**: Mixed single/double quote scenarios

### Azure Pipeline Features
✅ **Trigger**: Multiple branches with wildcards (`feature/*`, `release/*`)
✅ **Parameters**: Type definitions, defaults, values lists
✅ **Variables**: With and without expressions
✅ **Stages**: With dependencies and conditions
✅ **Jobs**: Regular jobs (deployment jobs excluded to avoid environment validation errors)
✅ **Tasks**: Multiple task types (@1, @2 versions)
✅ **Artifacts**: Publishing with expressions
✅ **Built-in variables**: `$(Build.SourceBranch)`, `$(Pipeline.Workspace)`

---

## Test Execution

### Run All Tests
```bash
cd tests
node run-tests.js
```

### Run Individual Test
```bash
cd tests
node test-formatting.js
node test-heredoc.js -v  # with verbose output
```

### Expected Output
```
======================================================================
Running Azure Pipeline Tests
======================================================================

[1/10] Running test-heredoc...
  All heredoc checks passed ✅

[2/10] Running test-quote-preservation...
  All quote preservation tests passed ✅

... (all 10 tests)

======================================================================
FINAL SUMMARY
======================================================================

  ✅ PASS - test-heredoc
  ✅ PASS - test-quote-preservation
  ✅ PASS - test-microsoft-boolean-compatibility
  ✅ PASS - test-non-azure-compatible
  ✅ PASS - test-expressions
  ✅ PASS - test-block-scalar-chomping
  ✅ PASS - test-trailing-newlines
  ✅ PASS - test-runtime-variables
  ✅ PASS - test-multilevel-templates
  ✅ PASS - test-formatting

----------------------------------------------------------------------
Total: 10 tests
Passed: 10
Failed: 0
----------------------------------------------------------------------

🎉 All template expansion tests passed! 🎉
```

---

## Test Input Files

All test input YAML files include `# aps-format=false` directive to prevent auto-formatting:

### Core Test Files (26 files)
1. `full-test.yaml` (367 lines) - Comprehensive formatting & expansion
2. `heredoc.yaml` - Heredoc syntax testing
3. `quote-preservation.yaml` - Quote handling
4. `runtime-variables.yaml` - Runtime variable handling
5. `include-stage-template.yaml` - Stage template inclusion
6. `include-step-template.yaml` - Step template inclusion
7. `include-variable-template.yaml` - Variable template inclusion
8. `stage-multilevel.yaml` - Multi-level template expansion
9. `stage-toplevel.yaml` - Top-level stage template
10. `stage-secondlevel.yaml` - Second-level stage template
11. `stage-template.yaml` - Stage template
12. `step-template.yaml` - Step template
13. `variable-template.yaml` - Variable template
14. `non-azure-compat-chomping.yaml` - Block chomping
15. `non-azure-compat-heredoc.yaml` - Non-Azure heredoc
16. `expressions-all-functions.yaml` - All expression functions
17. `block-chomping-keep.yaml` - Keep chomping (+)
18. `block-chomping-clip.yaml` - Clip chomping (default)
19. `block-chomping-literal.yaml` - Literal block scalars
20. `trailing-newlines.yaml` - Newline preservation
21. `trailing-newlines-params.yaml` - Newlines with parameters

---

## Coverage Statistics

### Overall
- **Total Test Suites**: 10
- **Total Test Cases**: 45+
- **Test Input Files**: 21
- **Lines of Test YAML**: 1000+
- **Template Expressions Tested**: 60+
- **Pass Rate**: 100% ✅

### Recent Additions (January 2026)
- **test-runtime-variables.js**: 5 test cases for `$(Variable)` handling
- **test-multilevel-templates.js**: 4 test cases for template expansion across multiple levels
- **Bug fixes**: Runtime variable quoting, colon normalization, block scalar preservation

### full-test.yaml Coverage
- **Stages**: 3
- **Jobs**: 4
- **Steps**: 43 (30+ functional + 13 quote handling tests)
- **Parameters**: 6 (all types)
- **Variables**: 6
- **Comments**: 12+
- **Template Expressions**: 50+
- **Script Blocks**: 5+ (Bash & Python)
- **Conditions**: 10+ (simple to complex)
- **Quote Handling Scenarios**: 13 test steps covering all combinations

---

## Test Pattern Benefits

1. **Single Source of Truth**: One comprehensive YAML per test type
2. **Realistic Pipelines**: Mirror actual Azure DevOps usage
3. **Edge Cases in Context**: Not isolated snippets
4. **Reusable**: For manual testing and debugging
5. **Self-Documenting**: Comments explain each test case
6. **Maintainable**: One file to update vs scattered inline strings
7. **Consistent**: All tests follow same pattern
8. **Extensible**: Easy to add new test cases

---

## Adding New Tests

To add a new test case:

1. **Create input YAML file** in `inputs/` directory
   ```yaml
   # aps-format=false
   # Description of what this tests
   
   # Your pipeline content here
   ```

2. **Create test file** following the pattern:
   ```javascript
   const runTestCase = (name, yamlFile, assertions) => {
     // Read input from inputs/yamlFile
     // Run expansion/formatting
     // Validate with assertions
     // Return pass/fail
   };
   ```

3. **Add to master runner** in `run-template-expansion-tests.js`

4. **Run and verify**: `node run-template-expansion-tests.js`

---

## Troubleshooting

### Test Fails After YAML Edit
- Check for syntax errors with YAML linter
- Verify `# aps-format=false` is present
- Run with `-v` flag for detailed output

### Expression Not Expanding
- Check parameter names match exactly
- Verify parameter type is correct
- Ensure Azure compatibility mode is set correctly

### Formatting Test Fails
- Verify input file has format suppression directive
- Check that expected patterns still exist in file
- Run formatter manually to debug: `formatYaml(content)`

---

## Related Documentation

- `README.md` - General test documentation
- `inputs/full-test.yaml` - Main comprehensive test file
- `run-template-expansion-tests.js` - Master test runner
- Individual test files for detailed implementation

---

## Maintenance

**Last Updated**: January 16, 2026

**Recent Changes**:
- Added test-runtime-variables.js: Tests for `$(Agent.OS)` and other runtime variables
- Added test-multilevel-templates.js: Tests for multi-level template expansion
- Fixed runtime variable quoting bug: Runtime variables are no longer quoted
- Fixed colon normalization: Values with colons now always use single quotes (unless runtime vars)
- Fixed block scalar preservation: Multiline content uses block scalars in both Azure and non-Azure modes
- Cleaned up debug console.log statements from parser.js
- Updated TEST_CASES.md with comprehensive documentation

**Test Status**: All 10 tests passing ✅

**Coverage**: Comprehensive - all known edge cases and recent bug fixes covered
