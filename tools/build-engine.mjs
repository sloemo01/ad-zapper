/*
 * Bundles the engine brain into a single file the service worker can load with
 * importScripts(). Run: node tools/build-engine.mjs
 */
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const outfile = join(root, 'engine', 'dist', 'engine.bundle.js');

await build({
  entryPoints: [join(root, 'engine', 'src', 'engine-entry.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  outfile,
  legalComments: 'none',
  logLevel: 'warning'
});

const { size } = statSync(outfile);
console.log(`built engine/dist/engine.bundle.js (${(size / 1024).toFixed(0)} KB)`);
