import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSources, validateIndex, validateIndexSources, validateUpdates } from '../scripts/validate.mjs';
import { buildUpdates, hashValue } from '../scripts/worker-feed.mjs';
import { check } from '../scripts/check.mjs';

const commit = 'a'.repeat(40);
const sourceCommit = 'b'.repeat(40);
const sources = () => ({ schemaVersion: 1, topic: 'hubdustry-index', repositories: [], exclude: [] });
const manifest = () => ({ path: 'mod.hjson', name: 'sample', displayName: 'Sample', version: '2', minGameVersion: '160', java: true });

function mod(repository = 'owner/mod') {
  const release = {
    id: 20, tag: 'v2', name: 'Version 2', url: `https://github.com/${repository}/releases/tag/v2`,
    publishedAt: '2026-02-01T00:00:00Z', prerelease: false,
    assets: [{
      id: 30, name: 'sample.jar', sizeBytes: 100, digest: `sha256:${'c'.repeat(64)}`,
      updatedAt: '2026-02-01', url: `https://github.com/${repository}/releases/download/v2/sample.jar`,
    }],
  };
  return {
    repository, url: `https://github.com/${repository}`, archived: false, channel: 'stable', manifest: manifest(),
    source: { branch: 'main', commit: sourceCommit, url: `https://github.com/${repository}/commit/${sourceCommit}` },
    latest: { ...structuredClone(release), manifest: manifest(), commit }, releases: [release],
  };
}

const index = () => ({ schemaVersion: 2, topic: 'hubdustry-index', mods: [mod()] });
const feed = () => buildUpdates(index(), sources());

function invalid(validator, value, pattern) {
  assert.throws(() => validator(value), error => error instanceof Error && !(error instanceof TypeError) && pattern.test(error.message));
}

function resign(value) {
  for (const entry of value.mods) {
    if (entry.update) {
      const { key, ...metadata } = entry.update;
      entry.update.key = hashValue(metadata);
    }
  }
  value.revision = hashValue(value.mods);
  return value;
}

test('validators return the original value and report bad top-level shapes without TypeErrors', () => {
  const config = sources();
  const catalog = index();
  const updates = feed();
  assert.equal(validateSources(config), config);
  assert.equal(validateIndex(catalog), catalog);
  assert.equal(validateUpdates(updates), updates);
  for (const validator of [validateSources, validateIndex, validateUpdates]) {
    for (const value of [null, undefined, [], false, 'data', 1]) invalid(validator, value, /expected an object/);
  }
  invalid(validateSources, { ...config, secret: true }, /sources\.secret: unexpected field/);
  invalid(validateIndex, { ...catalog, schemaVersion: 1 }, /schemaVersion/);
  invalid(validateUpdates, { ...updates, mods: null }, /updates\.mods: expected an array/);
});

test('source overrides accept exact installable filenames while exclusions remain authoritative', () => {
  const config = { ...sources(), repositories: [{ repository: 'Owner/Mod', channel: 'prerelease', asset: 'Sample.JAR' }], exclude: ['owner/mod'] };
  assert.equal(validateSources(config), config);
  for (const repository of ['owner/.', 'owner/..', '../mod', 'owner/mod/extra', 'owner/mod?']) {
    invalid(validateSources, { ...sources(), exclude: [repository] }, /invalid owner\/repository/);
  }
  for (const asset of [null, 12, '', '../sample.jar', 'dir\\sample.zip', 'sample.jar\n', 'sample.txt']) {
    invalid(validateSources, { ...sources(), repositories: [{ repository: 'owner/mod', channel: 'stable', asset }] }, /\.asset/);
  }
  invalid(validateSources, { ...sources(), repositories: [null] }, /repositories\[0\]: expected an object/);
  invalid(validateSources, { ...sources(), repositories: [{ repository: 'owner/mod', channel: 'nightly' }] }, /\.channel/);
  invalid(validateSources, { ...sources(), repositories: [{ repository: 'owner/mod', channel: 'stable', main: 'example.Main' }] }, /\.main: unexpected field/);
  invalid(validateSources, { ...sources(), repositories: [{ repository: 'owner/mod', channel: 'stable' }, { repository: 'OWNER/MOD', channel: 'prerelease' }] }, /duplicate tracked repository/);
  invalid(validateSources, { ...sources(), exclude: ['owner/mod', 'OWNER/MOD'] }, /duplicate excluded repository/);
});

test('catalog validates nested manifest, source, release, and asset metadata', () => {
  const cases = [
    [value => { value.mods[0] = null; }, /mods\[0\]: expected an object/],
    [value => { value.mods[0].manifest = null; }, /\.manifest: expected an object/],
    [value => { value.mods[0].manifest.main = 'example.Main'; }, /\.main: unexpected field/],
    [value => { value.mods[0].manifest.java = 'true'; }, /\.java: expected a boolean/],
    [value => { value.mods[0].manifest.path = '../mod.json'; }, /unsupported mod manifest path/],
    [value => { value.mods[0].source.commit = 'main'; }, /\.source\.commit/],
    [value => { value.mods[0].source.branch = ''; }, /\.source\.branch/],
    [value => { value.mods[0].latest.commit = null; }, /\.latest\.commit/],
    [value => { value.mods[0].releases[0].id = 1.5; }, /\.id: expected a safe integer/],
    [value => { value.mods[0].releases[0].publishedAt = 'yesterday'; }, /\.publishedAt: expected an ISO/],
    [value => { value.mods[0].releases[0].publishedAt = '2026-02-31'; }, /invalid calendar date/],
    [value => { value.mods[0].releases[0].assets = null; }, /\.assets: expected an array/],
    [value => { value.mods[0].releases[0].assets[0].sizeBytes = -1; }, /\.sizeBytes/],
    [value => { value.mods[0].releases[0].assets[0].digest = 'md5:0123'; }, /\.digest/],
    [value => { value.mods[0].releases[0].assets[0].updatedAt = null; }, /\.updatedAt/],
    [value => { value.mods[0].releases[0].assets.push(structuredClone(value.mods[0].releases[0].assets[0])); }, /duplicate asset ID/],
  ];
  for (const [mutate, pattern] of cases) {
    const value = index();
    mutate(value);
    invalid(validateIndex, value, pattern);
  }
});

test('catalog URLs must bind canonical repository, commit, release tag, and asset filename', () => {
  const paths = [
    ['url'], ['source', 'url'], ['latest', 'url'], ['releases', 0, 'url'], ['releases', 0, 'assets', 0, 'url'],
  ];
  for (const path of paths) {
    for (const replace of [url => url.replace('https:', 'http:'), url => url.replace('github.com', 'github.com.evil.test'), url => `${url}?download=1`, url => url.replace('/owner/mod', '/other/mod')]) {
      const value = index();
      let parent = value.mods[0];
      for (const key of path.slice(0, -1)) parent = parent[key];
      const key = path.at(-1);
      parent[key] = replace(parent[key]);
      invalid(validateIndex, value, /expected canonical GitHub URL/);
    }
  }
  const encoded = index();
  for (const release of [encoded.mods[0].latest, ...encoded.mods[0].releases]) {
    release.tag = 'release/v2';
    release.url = 'https://github.com/owner/mod/releases/tag/release%2Fv2';
    release.assets[0].name = 'sample build.jar';
    release.assets[0].url = 'https://github.com/owner/mod/releases/download/release%2Fv2/sample%20build.jar';
  }
  assert.equal(validateIndex(encoded), encoded);
});

test('catalog requires sorted unique repositories and release history with a matching latest', () => {
  invalid(validateIndex, { ...index(), mods: [mod('Zulu/mod'), mod('Alpha/mod')] }, /repositories must be sorted/);
  invalid(validateIndex, { ...index(), mods: [mod('owner/mod'), mod('OWNER/MOD')] }, /duplicate repository/);
  const duplicate = index();
  duplicate.mods[0].releases.push(structuredClone(duplicate.mods[0].releases[0]));
  invalid(validateIndex, duplicate, /duplicate release ID/);
  const history = index();
  const older = { ...structuredClone(history.mods[0].releases[0]), id: 10, tag: 'v1', url: 'https://github.com/owner/mod/releases/tag/v1', publishedAt: '2026-01-01', assets: [] };
  history.mods[0].releases.push(older);
  assert.equal(validateIndex(history), history);
  older.publishedAt = history.mods[0].releases[0].publishedAt;
  assert.equal(validateIndex(history), history);
  older.id = 21;
  invalid(validateIndex, history, /releases must be sorted/);
  older.id = 10;
  history.mods[0].releases.reverse();
  invalid(validateIndex, history, /releases must be sorted/);
  const mismatched = index();
  mismatched.mods[0].latest.assets[0].digest = null;
  invalid(validateIndex, mismatched, /must match the newest eligible release metadata/);
  const missingLatest = index();
  missingLatest.mods[0].latest = null;
  invalid(validateIndex, missingLatest, /missing latest eligible release/);
  const stableBeta = index();
  stableBeta.mods[0].releases[0].prerelease = true;
  stableBeta.mods[0].latest.prerelease = true;
  invalid(validateIndex, stableBeta, /stable channel cannot select a prerelease/);
  stableBeta.mods[0].latest = null;
  assert.equal(validateIndex(stableBeta), stableBeta);
});

test('catalog allows unknown release manifest and metadata without confusing branch and release commits', () => {
  const value = index();
  value.mods[0].latest.manifest = null;
  assert.equal(validateIndex(value), value);
  const unknown = index();
  unknown.mods[0].latest.manifest.version = '';
  unknown.mods[0].latest.manifest.minGameVersion = '';
  assert.equal(validateIndex(unknown), unknown);
  assert.notEqual(unknown.mods[0].source.commit, unknown.mods[0].latest.commit);
  const noRelease = index();
  noRelease.mods[0].latest = null;
  noRelease.mods[0].releases = [];
  assert.equal(validateIndex(noRelease), noRelease);
});

test('catalog must honor explicit tracked channels, repository presence, and exclusions', () => {
  const catalog = index();
  const config = { ...sources(), repositories: [{ repository: 'OWNER/MOD', channel: 'stable' }] };
  assert.equal(validateIndexSources(catalog, config), catalog);
  const excluded = { ...config, exclude: ['owner/mod'] };
  assert.throws(() => validateIndexSources(catalog, excluded), /excluded repository owner\/mod is still indexed/);
  assert.equal(validateIndexSources({ ...catalog, mods: [] }, excluded).mods.length, 0);
  assert.throws(() => validateIndexSources(catalog, { ...config, repositories: [{ repository: 'owner/mod', channel: 'prerelease' }] }), /channel for owner\/mod must match sources\.json \(prerelease\)/);
  assert.throws(() => validateIndexSources(catalog, { ...config, repositories: [{ repository: 'previous/mod', channel: 'stable' }] }), /tracked repository previous\/mod is missing.*canonical GitHub repository/);
  invalid(value => validateIndexSources(value, config), null, /expected an object/);
  invalid(value => validateIndexSources(catalog, value), null, /expected an object/);
});

test('worker feed rejects malformed status, release metadata, and artifact discriminants', () => {
  const cases = [
    [value => { value.mods[0].reason = 'unexpected'; }, /ready entry must have a null reason/],
    [value => { value.mods[0].status = 'pending'; }, /expected ready or blocked/],
    [value => { value.mods[0].update = null; }, /\.update: expected an object/],
    [value => { value.mods[0].update.releaseId = null; }, /\.releaseId/],
    [value => { value.mods[0].update.modName = null; }, /\.modName: expected a string/],
    [value => { value.mods[0].update.modName = ' '; }, /\.modName: expected a nonempty string/],
    [value => { value.mods[0].update.publishedAt = '2026-14-01'; }, /\.publishedAt/],
    [value => { value.mods[0].update.prerelease = true; }, /stable channel cannot select a prerelease/],
    [value => { value.mods[0].update.artifact.assetId = null; }, /\.assetId/],
    [value => { value.mods[0].update.artifact.sizeBytes = Number.MAX_SAFE_INTEGER + 1; }, /\.sizeBytes/],
    [value => { value.mods[0].update.artifact.updatedAt = null; }, /\.updatedAt/],
    [value => { value.mods[0].update.artifact.url = 'https://example.com/sample.jar'; }, /canonical GitHub URL/],
    [value => { value.mods[0].update.artifact.name = 'sample.exe'; }, /expected a \.jar or \.zip filename/],
    [value => { value.mods[0].update.artifact.kind = 'branch'; }, /expected release-asset or source-archive/],
  ];
  for (const [mutate, pattern] of cases) {
    const value = feed();
    mutate(value);
    resign(value);
    invalid(validateUpdates, value, pattern);
  }
  const blocked = { ...feed(), mods: [{ repository: 'owner/mod', channel: 'stable', status: 'blocked', reason: 'no_release', update: null }] };
  resign(blocked);
  assert.equal(validateUpdates(blocked), blocked);
  blocked.mods[0].reason = null;
  invalid(validateUpdates, blocked, /\.reason: expected a string/);
  blocked.mods[0].reason = 'no_release';
  blocked.mods[0].update = feed().mods[0].update;
  invalid(validateUpdates, blocked, /blocked entry must have a null update/);
});

test('source archive feed pins the release commit and cannot install Java or invented asset metadata', () => {
  const catalog = index();
  catalog.mods[0].latest.manifest.java = false;
  catalog.mods[0].latest.assets = [];
  catalog.mods[0].releases[0].assets = [];
  const archive = buildUpdates(catalog, sources());
  assert.equal(validateUpdates(archive), archive);
  for (const [mutate, pattern] of [
    [value => { value.mods[0].update.java = true; }, /Java mod requires a compiled release asset/],
    [value => { value.mods[0].update.artifact.url = 'https://github.com/owner/mod/archive/refs/heads/main.zip'; }, /canonical GitHub URL/],
    [value => { value.mods[0].update.artifact.sizeBytes = 100; }, /source archive metadata must be null/],
    [value => { value.mods[0].update.artifact.name = 'sample.jar'; }, /source archive must be a \.zip/],
  ]) {
    const value = structuredClone(archive);
    mutate(value);
    invalid(validateUpdates, resign(value), pattern);
  }
});

test('worker fingerprints reject edits and accept reordered JSON object fields', () => {
  const changed = feed();
  changed.mods[0].update.version = '3';
  invalid(validateUpdates, changed, /update fingerprint does not match/);
  resign(changed);
  assert.equal(validateUpdates(changed), changed);
  changed.mods[0].channel = 'prerelease';
  invalid(validateUpdates, changed, /feed fingerprint does not match/);
  const reordered = feed();
  reordered.mods[0].update.artifact = Object.fromEntries(Object.entries(reordered.mods[0].update.artifact).reverse());
  reordered.mods[0].update = Object.fromEntries(Object.entries(reordered.mods[0].update).reverse());
  reordered.mods[0] = Object.fromEntries(Object.entries(reordered.mods[0]).reverse());
  assert.equal(validateUpdates(reordered), reordered);
});

test('check detects a valid but stale worker feed when source overrides change', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hubdustry-check-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const root = pathToFileURL(directory + sep);
  const config = sources();
  const catalog = index();
  const updates = buildUpdates(catalog, config);
  for (const [filename, value] of [['sources.json', config], ['index.json', catalog], ['updates.json', updates]]) {
    await writeFile(new URL(filename, root), JSON.stringify(value));
  }
  await check(root);
  config.repositories.push({ repository: 'owner/mod', channel: 'stable', asset: 'missing.jar' });
  await writeFile(new URL('sources.json', root), JSON.stringify(config));
  await assert.rejects(check(root), /updates\.json must match index\.json and sources\.json/);
});

test('check rejects config-only channel and exclusion edits until the index is regenerated', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hubdustry-check-config-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const root = pathToFileURL(directory + sep);
  const catalog = index();
  await writeFile(new URL('index.json', root), JSON.stringify(catalog));
  await writeFile(new URL('updates.json', root), JSON.stringify(buildUpdates(catalog, sources())));
  for (const [config, pattern] of [
    [{ ...sources(), repositories: [{ repository: 'owner/mod', channel: 'prerelease' }] }, /channel for owner\/mod must match sources\.json/],
    [{ ...sources(), exclude: ['OWNER/MOD'] }, /excluded repository owner\/mod is still indexed/],
    [{ ...sources(), repositories: [{ repository: 'owner/new-mod', channel: 'stable' }] }, /tracked repository owner\/new-mod is missing/],
  ]) {
    await writeFile(new URL('sources.json', root), JSON.stringify(config));
    await assert.rejects(check(root), pattern);
  }
});
