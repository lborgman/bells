#!/usr/bin/env node
/**
 * extract-engine.js
 *
 * Extracts the bell engine source (Script Tag 1) from bell-synth.html
 * and writes it to bell-engine.js, ready to use as an ESM module.
 *
 * Usage:
 *   node extract-engine.js [input] [output]
 *
 * Defaults:
 *   input  → bell-synth.html
 *   output → bell-engine.js
 *
 * The script also uncomments the export line at the bottom of the extracted
 * block, so the resulting file is a valid ESM module immediately.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve }                     from 'path';

const inputFile  = resolve(process.argv[2] ?? 'bell-synth.html');
const outputFile = resolve(process.argv[3] ?? 'bell-engine.js');

const html = readFileSync(inputFile, 'utf8');

// Script Tag 1 is the first plain <script> (no type attribute).
// Script Tag 2 is <script type="module"> and must not be extracted.
// We match at the start of a line to avoid hitting mentions of <script>
// inside HTML comments (e.g. "...move this block to bell-engine.js...").
const openTag  = '<script>';
const closeTag = '</script>';

const start = html.search(/^<script>$/m);
if (start === -1) throw new Error('No <script> tag found at start of line in input file.');

const end = html.indexOf(closeTag, start);
if (end === -1) throw new Error('No closing </script> tag found after opening <script>.');

// Extract the content between the tags (strip the tags themselves)
let source = html.slice(start + openTag.length, end);

// Uncomment the export line:  // export { ... };  →  export { ... };
source = source.replace(/^\/\/ (export \{[^}]+\};)/m, '$1');

// Trim leading newline left by the opening tag
source = source.replace(/^\n/, '');

writeFileSync(outputFile, source, 'utf8');
console.log(`Extracted : ${inputFile}`);
console.log(`Written   : ${outputFile}`);
console.log(`Lines     : ${source.split('\n').length}`);