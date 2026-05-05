# Test Suite Documentation

## Overview

Comprehensive test coverage for the Azure Pipeline YAML Formatter, with specific focus on the refactored Azure Pipeline expression handling module.

## Test Files

### 1. `tests/run-tests.js`
**Type**: YAML Parsing Tests  
**Purpose**: Validates that all YAML test files parse correctly  
**Files Tested**: 26 YAML files in tests/ directory  
**Usage**: `npm test` or `node tests/run-tests.js`

### 2. `tests/` JavaScript test files
**Type**: Node-based test scripts  
**Purpose**: Validate expansion, formatting, diagram, scoping, and Azure-compat behavior through standalone test runners.  
**Usage**:
- Main suite: `npm test` or `node tests/run-tests.js`
- Individual tests: `node tests/<file>.js`

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
npm test
```

### Run Individual Test Files
```bash
node tests/run-tests.js
node tests/test-expressions.js
node tests/test-formatting.js
node tests/test-pipeline-diagram.js
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

## Coverage Notes

The current repository test surface is driven by the scripts present under `tests/` and aggregated by `tests/run-tests.js`. If new standalone tests are added, include them in that runner to keep `npm test` authoritative.

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


### Using npm scripts:
- `npm test` - Run the main JavaScript test suite

### Running individual test files:
```bash
node tests/test-expressions.js
node tests/test-heredoc.js
node tests/test-formatting.js
node tests/test-pipeline-diagram.js
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
