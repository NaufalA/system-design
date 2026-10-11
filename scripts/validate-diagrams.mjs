#!/usr/bin/env node
// Validates every ```mermaid block in the repo's markdown files using mermaid's
// own parser, so broken diagrams are caught before they're committed/reviewed.
//
// Usage:
//   node scripts/validate-diagrams.mjs               # scans designs/ and templates/
//   node scripts/validate-diagrams.mjs <file.md>...  # checks specific files
//   npm run validate:diagrams
//
// Requires dev dependencies: npm install

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const die = (msg) => {
  console.error(msg);
  process.exit(2);
};

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  die('Missing dev dependencies — run `npm install` first (installs mermaid + jsdom).');
}

// --- minimal DOM for the mermaid parser (must exist BEFORE mermaid loads:
// its bundled DOMPurify captures the global window at import time) ----------
const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost/' });
const expose = (key, value) => {
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch {
    /* node already provides it (e.g. navigator) — parser works without overriding */
  }
};
expose('window', dom.window);
expose('document', dom.window.document);
expose('HTMLElement', dom.window.HTMLElement);
expose('SVGElement', dom.window.SVGElement);
expose('Element', dom.window.Element);
expose('Node', dom.window.Node);
expose('DOMParser', dom.window.DOMParser);
expose('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
expose('navigator', dom.window.navigator);

let mermaid;
try {
  mermaid = (await import('mermaid')).default;
} catch (e) {
  die(`Could not load mermaid: ${e?.message ?? e}`);
}

mermaid.initialize({ startOnLoad: false });

// --- file discovery ---------------------------------------------------------
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
};

const args = process.argv.slice(2);
const files = args.length
  ? args.map((f) => path.resolve(f))
  : [...walk(path.join(root, 'designs')), ...walk(path.join(root, 'templates'))];

// --- validate ---------------------------------------------------------------
let checked = 0;
let failures = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    failures++;
    console.log(`FAIL  ${path.relative(root, file)} — file not found`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  const blocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  let index = 0;
  for (const [, code] of blocks) {
    index++;
    checked++;
    const kind = code.split('\n')[0].trim();
    try {
      await mermaid.parse(code);
      console.log(`OK    ${path.relative(root, file)} [${index}] (${kind})`);
    } catch (e) {
      failures++;
      const detail = String(e?.message ?? e)
        .split('\n')
        .slice(0, 6)
        .join('\n      ');
      console.log(`FAIL  ${path.relative(root, file)} [${index}] (${kind})\n      ${detail}`);
    }
  }
}

console.log(`\n${checked} diagram(s) checked, ${failures} failed`);
process.exit(failures ? 1 : 0);
