#!/usr/bin/env node

// - azureCompatible=false => expect literal `|` and 0 empty lines
// - azureCompatible=true  => expect folded `>` with empty lines if original had ${{}}

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const minimist = require('minimist');
const { AzurePipelineParser } = require('../parser.js');
const parser = new AzurePipelineParser();

console.log('Testing heredoc behavior...\n');

const filePath = path.join(__dirname, 'inputs', 'heredoc.yaml');
const data = fs.readFileSync(filePath, 'utf8');

let argv = process.argv.slice(2);
let args = minimist(argv, { boolean: ['v', 'verbose'] });

const verbose = args.v || args.verbose;

// Detect heredocs in original input
const heredocRegex = /cat\s+<<\s*(\w+)[^\n]*\n([\s\S]*?)\n\s*\1\b/g;
const originals = [];
let m;
const tempRegex = new RegExp(heredocRegex.source, heredocRegex.flags);
while ((m = tempRegex.exec(data)) !== null) {
    originals.push({
        delimiter: m[1],
        body: m[2],
        hadExpression: m[0].includes('${{'),
    });
}

console.log(`Found ${originals.length} heredoc(s) in input file\n`);

if (originals.length === 0) {
    console.error('No heredoc blocks found in samples/heredoc.yaml');
    process.exit(1);
}

function analyze(outputYaml) {
    // Find heredoc bodies in output
    const outMatches = [];
    const heredocOutRegex = new RegExp(heredocRegex.source, heredocRegex.flags);
    let om;
    while ((om = heredocOutRegex.exec(outputYaml)) !== null) {
        outMatches.push({ delimiter: om[1], body: om[2] });
    }
    // Also detect block styles (bash/script)
    const styleMatches = [];
    const styleRe = /(?:script|bash):\s+([|>])/g;
    let sm;
    while ((sm = styleRe.exec(outputYaml)) !== null) styleMatches.push(sm[1]);

    return { outMatches, styleMatches };
}

function runAndReport(azureCompatible, params) {
    console.log(`=== Run: azureCompatible=${azureCompatible} ===`);
    const out = parser.expandPipelineFromString(data, Object.assign({ azureCompatible }, params));
    const a = analyze(out);
    console.log(`Found ${a.outMatches.length} heredoc(s) and ${a.styleMatches.length} block style(s) in output`);
    if (verbose) {
        console.log(out);
    }
    let overallPass = true;
    for (let idx = 0; idx < a.outMatches.length; idx++) {
        const outMatch = a.outMatches[idx];
        const style = a.styleMatches[idx] || 'N/A';
        const emptyLines = outMatch ? outMatch.body.split('\n').filter((l) => l.trim() === '').length : 0;
        const hadExpression = outMatch ? outMatch.body.includes('mytoken') || outMatch.body.includes('token') : false;

        const expectedStyle = azureCompatible ? (hadExpression ? '>' : '|') : '|';
        const expectedEmpty = azureCompatible && hadExpression ? 2 : 0;

        console.log(`  Heredoc #${idx + 1}: expected blockStyle=${expectedStyle}, expectedEmpty=${expectedEmpty}`);
        console.log(`              actual   blockStyle=${style}, actualEmptyLines=${emptyLines}`);

        const pass = azureCompatible
            ? hadExpression
                ? style === '>' && emptyLines == expectedEmpty
                : style === '|' && emptyLines === 0
            : style === expectedStyle && emptyLines === expectedEmpty;
        console.log(`  Result: ${pass ? '✅ PASS' : '❌ FAIL'}`);
        if (!pass) overallPass = false;
    }
    console.log();
    return overallPass;
}

const ok1 = runAndReport(false, { parameters: { token: 'mytoken' } });
const ok2 = runAndReport(true, { parameters: { token: 'mytoken' } });

const allOk = ok1 && ok2;
console.log('=== Summary ===');
console.log(allOk ? 'All heredoc checks passed ✅' : 'Some heredoc checks failed ❌');
process.exit(allOk ? 0 : 1);
