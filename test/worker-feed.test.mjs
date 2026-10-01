import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdates, hashValue } from '../scripts/worker-feed.mjs';

const commit = 'a'.repeat(40);
const manifest = { name: 'demo', version: '1.2', minGameVersion: '160', java: false };
const asset = (name, extra = {}) => ({
  id: 10, name, sizeBytes: 100, digest: null, updatedAt: '2026-09-01T00:00:00Z',
  url: `https://github.com/owner/mod/releases/download/v1/${name}`, ...extra,
});
const mod = (extra = {}) => ({
  repository: 'owner/mod', channel: 'stable', archived: false,
  latest: {
    id: 1, tag: 'v1', commit, publishedAt: '2026-09-01T00:00:00Z',
    prerelease: false, manifest: { ...manifest }, assets: [],
  }, ...extra,
});
const index = (...mods) => ({ schemaVersion: 2, topic: 'hubdustry-index', mods });
const selected = value => buildUpdates(index(value)).mods[0];

test('feed hashes canonical values and sorts repositories without changing the index', () => {
  assert.equal(hashValue({ a: 1, b: { c: 2, d: 3 } }), hashValue({ b: { d: 3, c: 2 }, a: 1 }));
  const original = index(mod({ repository: 'z/mod' }), mod({ repository: 'A/mod' }));
  const feed = buildUpdates(original);
  assert.deepEqual(feed.mods.map(item => item.repository), ['A/mod', 'z/mod']);
  assert.equal(original.mods[0].repository, 'z/mod');
  assert.equal(feed.revision, hashValue(feed.mods));
  assert.equal(feed.revision, buildUpdates(index(...original.mods.toReversed())).revision);
});

test('source archives are pinned to release commits with explicit unavailable asset metadata', () => {
  const result = selected(mod());
  assert.equal(result.status, 'ready');
  assert.equal(result.reason, null);
  assert.deepEqual(result.update.artifact, {
    kind: 'source-archive', name: `mod-${commit}.zip`,
    url: `https://github.com/owner/mod/archive/${commit}.zip`,
    assetId: null, sizeBytes: null, digest: null, updatedAt: null,
  });
  assert.equal(result.update.version, '1.2');
  assert.equal(result.update.modName, 'demo');
  assert.equal(result.update.minGameVersion, '160');
  assert.equal(result.update.publishedAt, '2026-09-01T00:00:00Z');
  const { key, ...payload } = result.update;
  assert.equal(key, hashValue(payload));
});

test('Java mods need a unique installable JAR and never use source archives', () => {
  const value = mod();
  value.latest.manifest.java = true;
  assert.equal(selected(value).reason, 'no_installable_asset');
  value.latest.assets = [asset('mod.zip'), asset('mod-sources.jar'), asset('mod-javadoc.jar'), asset('mod.jar')];
  assert.equal(selected(value).update.artifact.name, 'mod.jar');
  value.latest.assets.push(asset('another.jar', { id: 11 }));
  assert.equal(selected(value).reason, 'ambiguous_assets');
});

test('content mods prefer a unique ZIP over JAR and block ambiguity', () => {
  const value = mod();
  value.latest.assets = [asset('mod.jar'), asset('mod.zip', { id: 11 })];
  assert.equal(selected(value).update.artifact.name, 'mod.zip');
  value.latest.assets.push(asset('extra.zip', { id: 12 }));
  assert.equal(selected(value).reason, 'ambiguous_assets');
  value.latest.assets = [asset('mod.jar')];
  assert.equal(selected(value).update.artifact.name, 'mod.jar');
  value.latest.assets.push(asset('another.jar', { id: 11 }));
  assert.equal(selected(value).reason, 'ambiguous_assets');
});

test('classifier artifacts are excluded without excluding ordinary name substrings', () => {
  const value = mod();
  value.latest.assets = [
    'mod-source.zip', 'mod-sources.jar', 'mod-javadoc.jar', 'mod-debug.zip',
    'mod-android.jar', 'mod-desktop.jar', 'notes.txt',
  ].map(name => asset(name));
  assert.equal(selected(value).update.artifact.kind, 'source-archive');
  value.latest.manifest.java = true;
  assert.equal(selected(value).reason, 'no_installable_asset');
  value.latest.assets.push(asset('SourceMod.jar'));
  assert.equal(selected(value).update.artifact.name, 'SourceMod.jar');
});

test('exact asset overrides resolve ambiguity and refuse missing or ineligible filenames', () => {
  const value = mod();
  value.latest.assets = [asset('mod.zip'), asset('chosen.zip', { id: 11 }), asset('mod-sources.zip'), asset('notes.txt')];
  const configured = name => buildUpdates(index(value), { repositories: [{ repository: 'OWNER/MOD', asset: name }] }).mods[0];
  assert.equal(configured('chosen.zip').update.artifact.assetId, 11);
  assert.equal(configured('Chosen.zip').reason, 'configured_asset_missing');
  assert.equal(configured('missing.jar').reason, 'configured_asset_missing');
  assert.equal(configured('notes.txt').reason, 'configured_asset_ineligible');
  assert.equal(configured('mod-sources.zip').update.artifact.name, 'mod-sources.zip');
  value.latest.manifest.java = true;
  assert.equal(configured('chosen.zip').update.artifact.name, 'chosen.zip');
});

test('archived repositories and releases without a manifest remain blocked', () => {
  for (const [value, reason] of [
    [mod({ archived: true }), 'archived_repository'],
    [mod({ latest: null }), 'no_release'],
    [mod({ latest: { id: 1, manifest: null } }), 'missing_release_manifest'],
  ]) {
    const result = selected(value);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, reason);
    assert.equal(result.update, null);
  }
});

test('the worker preserves selected channel metadata and does not fall back to older releases', () => {
  const value = mod({ channel: 'prerelease' });
  value.latest.prerelease = true;
  const result = selected(value);
  assert.equal(result.channel, 'prerelease');
  assert.equal(result.update.prerelease, true);
  value.latest.manifest.java = true;
  value.releases = [{ id: 0, tag: 'older', assets: [asset('mod.jar')] }];
  assert.equal(selected(value).reason, 'no_installable_asset');
});

test('asset replacements and moved tags change update keys even when tags do not change', () => {
  const value = mod();
  value.latest.assets = [asset('mod.zip')];
  const before = selected(value).update.key;
  for (const change of [
    { digest: `sha256:${'b'.repeat(64)}` },
    { id: 11 },
    { sizeBytes: 101 },
    { updatedAt: '2026-09-02T00:00:00Z' },
  ]) {
    const changed = structuredClone(value);
    Object.assign(changed.latest.assets[0], change);
    assert.notEqual(selected(changed).update.key, before);
  }
  value.latest.commit = 'c'.repeat(40);
  assert.notEqual(selected(value).update.key, before);
});

test('feed revisions only track selected worker metadata', () => {
  const value = mod();
  const before = buildUpdates(index(value));
  value.source = { commit: 'b'.repeat(40) };
  value.manifest = { ...manifest, name: 'development-name', version: 'development' };
  value.releases = [{ id: 0, tag: 'old' }];
  assert.deepEqual(buildUpdates(index(value)), before);
  assert.equal(before.mods[0].update.modName, value.latest.manifest.name);
  value.latest.manifest.name = 'renamed-mod';
  const renamed = buildUpdates(index(value));
  assert.equal(renamed.mods[0].update.modName, 'renamed-mod');
  assert.notEqual(renamed.mods[0].update.key, before.mods[0].update.key);
  value.latest.manifest.name = manifest.name;
  value.latest.manifest.minGameVersion = '161';
  assert.notEqual(buildUpdates(index(value)).revision, before.revision);
});

test('invalid index versions, duplicate repositories and unpinned releases are rejected', () => {
  assert.throws(() => buildUpdates({ schemaVersion: 1, topic: 'hubdustry-index', mods: [] }), /Invalid index/);
  assert.throws(() => buildUpdates(index(mod(), mod({ repository: 'OWNER/MOD' }))), /Duplicate/);
  const value = mod();
  value.latest.commit = 'v1';
  assert.throws(() => selected(value), /Invalid release commit/);
});
