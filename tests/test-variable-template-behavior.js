#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { AzurePipelineParser } = require('../parser.js');

const parser = new AzurePipelineParser();

console.log('Testing Variable Template Behavior\n');

const filePath = path.join(__dirname, 'inputs', 'variable-template-main.yaml');
const data = fs.readFileSync(filePath, 'utf8');

const output = parser.expandPipelineFromString(data, {
    azureCompatible: true,
    baseDir: path.join(__dirname, 'inputs'),
});

console.log('Output:');
console.log(output);
