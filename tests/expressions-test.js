const { AzurePipelineParser } = require('../parser');

// Test all expression functions from Azure DevOps documentation
const parser = new AzurePipelineParser();

console.log('Testing Azure DevOps Expression Functions\n');

// Test comparison functions
console.log('=== Comparison Functions ===');
console.log('eq(5, 5):', parser.evaluateFunction('eq', [5, 5])); // true
console.log('ne(5, 3):', parser.evaluateFunction('ne', [5, 3])); // true
console.log('gt(5, 3):', parser.evaluateFunction('gt', [5, 3])); // true
console.log('ge(5, 5):', parser.evaluateFunction('ge', [5, 5])); // true
console.log('lt(3, 5):', parser.evaluateFunction('lt', [3, 5])); // true
console.log('le(5, 5):', parser.evaluateFunction('le', [5, 5])); // true

// Test logical functions
console.log('\n=== Logical Functions ===');
console.log('and(true, true):', parser.evaluateFunction('and', [true, true])); // true
console.log('or(false, true):', parser.evaluateFunction('or', [false, true])); // true
console.log('not(false):', parser.evaluateFunction('not', [false])); // true
console.log('xor(true, false):', parser.evaluateFunction('xor', [true, false])); // true
console.log('xor(true, true):', parser.evaluateFunction('xor', [true, true])); // false

// Test containment functions
console.log('\n=== Containment Functions ===');
console.log('coalesce(null, "", "value"):', parser.evaluateFunction('coalesce', [null, '', 'value'])); // 'value'
console.log('contains("ABCDE", "BCD"):', parser.evaluateFunction('contains', ['ABCDE', 'BCD'])); // true
console.log('containsValue([1,2,3], 2):', parser.evaluateFunction('containsvalue', [[1, 2, 3], 2])); // true
console.log('in("B", "A", "B", "C"):', parser.evaluateFunction('in', ['B', 'A', 'B', 'C'])); // true
console.log('notIn("D", "A", "B", "C"):', parser.evaluateFunction('notin', ['D', 'A', 'B', 'C'])); // true

// Test string functions
console.log('\n=== String Functions ===');
console.log('lower("FOO"):', parser.evaluateFunction('lower', ['FOO'])); // 'foo'
console.log('upper("bar"):', parser.evaluateFunction('upper', ['bar'])); // 'BAR'
console.log('startsWith("ABCDE", "AB"):', parser.evaluateFunction('startswith', ['ABCDE', 'AB'])); // true
console.log('endsWith("ABCDE", "DE"):', parser.evaluateFunction('endswith', ['ABCDE', 'DE'])); // true
console.log('trim("  hello  "):', parser.evaluateFunction('trim', ['  hello  '])); // 'hello'
console.log('replace("test.txt", ".txt", ".md"):', parser.evaluateFunction('replace', ['test.txt', '.txt', '.md'])); // 'test.md'
console.log('split("a,b,c", ","):', parser.evaluateFunction('split', ['a,b,c', ','])); // ['a','b','c']
console.log('join(";", ["a","b","c"]):', parser.evaluateFunction('join', [';', ['a', 'b', 'c']])); // 'a;b;c'
console.log(
    'format("Hello {0} {1}", "John", "Doe"):',
    parser.evaluateFunction('format', ['Hello {0} {1}', 'John', 'Doe']),
); // 'Hello John Doe'

// Test other functions
console.log('\n=== Other Functions ===');
console.log('length("fabrikam"):', parser.evaluateFunction('length', ['fabrikam'])); // 8
console.log('length([1,2,3]):', parser.evaluateFunction('length', [[1, 2, 3]])); // 3
console.log('convertToJson({a: 1, b: 2}):', parser.evaluateFunction('converttojson', [{ a: 1, b: 2 }]));
console.log('iif(true, "yes", "no"):', parser.evaluateFunction('iif', [true, 'yes', 'no'])); // 'yes'
console.log('iif(false, "yes", "no"):', parser.evaluateFunction('iif', [false, 'yes', 'no'])); // 'no'

// Test counter function
console.log('\n=== Counter Function ===');
console.log('counter("test", 100):', parser.evaluateFunction('counter', ['test', 100])); // 100
console.log('counter("test", 100):', parser.evaluateFunction('counter', ['test', 100])); // 101
console.log('counter("test", 100):', parser.evaluateFunction('counter', ['test', 100])); // 102
console.log('counter("other", 50):', parser.evaluateFunction('counter', ['other', 50])); // 50

// Test job status check functions
console.log('\n=== Job Status Check Functions ===');
console.log('always():', parser.evaluateFunction('always', [])); // true
console.log('canceled():', parser.evaluateFunction('canceled', [])); // false (default)
console.log('failed():', parser.evaluateFunction('failed', [])); // false (default)
console.log('succeeded():', parser.evaluateFunction('succeeded', [])); // true (default)
console.log('succeededOrFailed():', parser.evaluateFunction('succeededorfailed', [])); // true (default)

// Test expressions in YAML context
console.log('\n=== Testing Expressions in YAML Context ===');

const yaml1 = `
variables:
  a: 5
  b: 3
  greater: \${{ gt(parameters.a, parameters.b) }}
  combined: \${{ format('Result: {0}', parameters.result) }}
`;

try {
    const result1 = parser.expandPipelineToString(yaml1, {
        parameters: { a: 10, b: 5, result: 'Success' },
    });
    console.log('Expanded YAML with expressions:');
    console.log(result1);
} catch (error) {
    console.error('Error:', error.message);
}

// Test conditional expressions
const yaml2 = `
steps:
  - \${{ if eq(parameters.environment, 'prod') }}:
    - script: echo "Production deployment"
  - \${{ if ne(parameters.environment, 'prod') }}:
    - script: echo "Non-production deployment"
`;

try {
    console.log('\nTest with eq() in conditional:');
    const result2 = parser.expandPipelineToString(yaml2, {
        parameters: { environment: 'prod' },
    });
    console.log(result2);
} catch (error) {
    console.error('Error:', error.message);
}

// Test string manipulation
const yaml3 = `
variables:
  filename: \${{ replace(parameters.file, '.txt', '.md') }}
  uppercase: \${{ upper(parameters.name) }}
  parts: \${{ split(parameters.csv, ',') }}
`;

try {
    console.log('\nTest string manipulation functions:');
    const result3 = parser.expandPipelineToString(yaml3, {
        parameters: { file: 'readme.txt', name: 'azure', csv: 'a,b,c' },
    });
    console.log(result3);
} catch (error) {
    console.error('Error:', error.message);
}

console.log('\n=== All tests completed ===');
