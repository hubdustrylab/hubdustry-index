import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateIndexSources, validateUpdates } from './validate.mjs';
import { buildUpdates } from './worker-feed.mjs';

export async function check(root = new URL('../', import.meta.url)) {
  const readJson = async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'));
  const [sources, index, updates] = await Promise.all(['sources.json', 'index.json', 'updates.json'].map(readJson));
  validateIndexSources(index, sources);
  validateUpdates(updates);
  assert.deepEqual(updates, buildUpdates(index, sources), 'updates.json must match index.json and sources.json; run npm run update');
  console.log(`Sources, index, and worker feed are valid (${index.mods.length} mods).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  check().catch(error => { console.error(error.message); process.exitCode = 1; });
}
