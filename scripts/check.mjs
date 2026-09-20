import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { validateSources } from './update.mjs';

const root = new URL('../', import.meta.url);
validateSources(JSON.parse(await readFile(new URL('sources.json', root), 'utf8')));
const index = JSON.parse(await readFile(new URL('index.json', root), 'utf8'));
assert.equal(index.schemaVersion, 1);
assert.equal(index.topic, 'hubdustry-index');
assert.ok(Array.isArray(index.mods));
assert.equal(new Set(index.mods.map(mod => mod.repository.toLowerCase())).size, index.mods.length);
const fields = ['repository', 'url', 'archived', 'channel', 'manifest', 'source', 'latest', 'releases'];
for (const mod of index.mods) {
  assert.deepEqual(Object.keys(mod).sort(), [...fields].sort(), 'Only public upstream metadata belongs in the index');
  assert.ok(Array.isArray(mod.releases));
  assert.match(mod.source.commit, /^[a-f0-9]{40}$/);
}
console.log('Sources and index are valid.');
