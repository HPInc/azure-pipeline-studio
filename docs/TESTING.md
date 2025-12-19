# Test Suite Documentation

## Overview

Comprehensive test coverage for the Azure Pipeline YAML Formatter, with specific focus on the refactored Azure Pipeline expression handling module.

## Test Files

### 1. `tests/run-tests.js`
**Type**: YAML Parsing Tests  
**Purpose**: Validates that all YAML test files parse correctly  
**Files Tested**: 26 YAML files in tests/ directory  
**Usage**: `npm test` or `node tests/run-tests.js`

### 2. `tests/test-azure-expressions-module.js` ⭐ NEW
**Type**: Unit Tests  
**Purpose**: Tests the `azurePipelineExpressions.js` module in isolation  
**Test Count**: 15 tests  
**Usage**: 
- Quiet: `npm run test:module` or `node tests/test-azure-expressions-module.js`
- Debug: `node tests/test-azure-expressions-module.js -d`

**Test Coverage**:
- `isExpressionKey()` - Validates expression key detection (6 tests)
- `preprocessDuplicateKeys()` - Tests preprocessing logic (3 tests)
- `applyModifications()` - Tests modification application (2 tests)
- `restoreDuplicateKeys()` - Tests key restoration (3 tests)
- `getDuplicateKeyStats()` - Tests statistics generation (2 tests)
- Full workflow integration (1 test)
- Pattern exports validation (1 test)
- Edge cases (2 tests)

### 3. `tests/test-integration-expressions.js` ⭐ NEW
**Type**: Integration Tests  
**Purpose**: Tests expression handling integrated with `formatYaml()`  
**Test Count**: 10 tests  
**Usage**:
- Quiet: `npm run test:integration` or `node tests/test-integration-expressions.js`
- Debug: `node tests/test-integration-expressions.js -d`

**Test Coverage**:
- Duplicate `${{ insert }}` keys
- Duplicate `${{ if }}` conditions
- File-based test (`test-duplicate-expression-keys.yml`)
- Spacing with/without parameters
- Empty list value preservation
- Mixed duplicate and non-duplicate keys
- Complex nested expressions
- Different indent level tracking
- Backward compatibility with regular YAML

### 4. `tests/test-duplicate-keys.js`
**Type**: Validation Tests  
**Purpose**: Validates specific duplicate key scenarios with the formatter  
**Test Count**: 5 tests  
**Usage**: `node tests/test-duplicate-keys.js` (supports `-d` flag)

**Test Coverage**:
- Duplicate `${{ insert }}` preservation
- Parameters spacing (with parameters)
- No parameters spacing (without parameters)
- Empty list values (`- job:`, `- stage:`)
- Complex expression syntax

## Running Tests

### Quick Start with test.sh (Recommended)

Use the convenient `test.sh` script for the best testing experience:

```bash
./test.sh              # Run all tests with progress indicators
./test.sh --quick      # Run only YAML parsing tests (fast)
./test.sh --verbose    # Run with detailed output and errors
./test.sh --help       # Show usage help
```

Features:
- ✓ Color-coded output (green ✓ = pass, red ✗ = fail)
- 📊 Progress indicators for each test suite  
- 📈 Summary report with counts
- ⚡ Quick mode for rapid feedback
- 🔍 Verbose mode for debugging

### Run All Tests
```bash
# Quiet mode (default)
npm run test:all

# Or use the comprehensive test runner
chmod +x tests/run-all-tests.sh
./tests/run-all-tests.sh

# Debug mode
./tests/run-all-tests.sh -d
```

### Run Individual Test Suites
```bash
# YAML parsing tests
npm test

# Module unit tests
npm run test:module
npm run test:module -- -d  # with debug output

# Integration tests
npm run test:integration
npm run test:integration -- -d  # with debug output

# Duplicate keys validation
node tests/test-duplicate-keys.js
node tests/test-duplicate-keys.js -d  # with debug output
```

## Test Results Format

### Quiet Mode (Default)
Only shows summary:
```
Integration Tests: 10 total, 10 passed, 0 failed
✅ All integration tests passed!
```

### Debug Mode (`-d` or `--debug`)
Shows detailed test execution:
```
=== Test 1: Duplicate ${{ insert }} keys ===
✓ Should format YAML with duplicate ${{ insert }} keys
=== Test 2: Duplicate ${{ if }} conditions ===
✓ Should format YAML with duplicate ${{ if }} conditions
...
Integration Tests: 10 total, 10 passed, 0 failed
✅ All integration tests passed!
```

## Test Coverage Summary

| Module | Unit Tests | Integration Tests | Total |
|--------|-----------|-------------------|-------|
| `azurePipelineExpressions.js` | 15 | 10 | 25 |
| YAML Parsing | - | 26 | 26 |
| Duplicate Keys Validation | - | 5 | 5 |
| **Total** | **15** | **41** | **56** |

## Key Features Tested

### 1. Duplicate Expression Key Handling ✅
- Preprocessing: Adds unique suffixes to duplicate keys
- Formatting: yaml package processes temporarily unique keys
- Postprocessing: Removes suffixes to restore original syntax
- Edge cases: High suffix numbers, different indent levels

### 2. Smart Spacing Detection ✅
- Files starting with `parameters:` get blank lines before sections
- Files without `parameters:` don't get extra blank lines
- Configurable via `firstBlockBlankLines` option

### 3. Empty Value Preservation ✅
- `- job:` stays as `- job:` (not `- job: null`)
- `- stage:` stays as `- stage:` (not `- stage: null`)
- Works for both regular keys and list items

### 4. Module API ✅
- `preprocessDuplicateKeys()` - Returns modifications array
- `applyModifications()` - Applies line-level changes
- `restoreDuplicateKeys()` - Restores original keys
- `isExpressionKey()` - Validates expression keys
- `getDuplicateKeyStats()` - Returns statistics
- Pattern exports for testing/debugging

## CI/CD Integration

Add to your CI pipeline:
```yaml
- script: npm run test:all
  displayName: Run all tests
```

Or for more granular control:
```yaml
- script: npm test
  displayName: YAML parsing tests
- script: npm run test:module
  displayName: Module unit tests
- script: npm run test:integration
  displayName: Integration tests
```

## Debugging Failed Tests

When tests fail, run with debug flag to see detailed output:
```bash
node tests/test-azure-expressions-module.js -d
node tests/test-integration-expressions.js -d
node tests/test-duplicate-keys.js -d
```

This shows:
- Which specific assertion failed
- Expected vs actual values
- Test execution flow

---

## Test Runner Script


The repository includes a convenient `test.sh` script for running tests with better UX:


### Using the test.sh script (recommended):
- `./test.sh` - Full test suite with progress indicators
- `./test.sh --quick` - Quick smoke test (YAML parsing only)
- `./test.sh --verbose` - Full output including error details

### Using npm scripts:
- `npm test` - Run basic YAML parsing tests
- `npm run test:all` - Run comprehensive test suite (bash script)
- `npm run test:module` - Run Azure expressions module tests
- `npm run test:integration` - Run integration tests

### Running individual test files:
```bash
node tests/test-azure-expressions-module.js
node tests/test-blank-line-removal.js
node tests/test-first-block-blank-lines.js
node tests/test-integration-expressions.js
```

## Test Categories

1. **YAML Parsing Tests** (33 tests)
   - Validates YAML parsing and formatting
   - Tests comment preservation, indentation, etc.

2. **Unit Tests**
   - Azure expressions module (34 tests)
   - Blank line removal (9 tests)
   - First block blank lines (7 tests)

3. **Integration Tests** (10 tests)
   - End-to-end formatting scenarios
   - Expression integration

## Exit Codes

- `0` - All tests passed
- `>0` - Number of failed tests

## Output Format

The test runner provides color-coded output:
- ✓ (green) - Test passed
- ✗ (red) - Test failed

Use `--verbose` flag to see detailed error messages.

---
