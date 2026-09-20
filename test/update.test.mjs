import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSources, discover, readManifest, normalizeReleases, collect, main } from '../scripts/update.mjs';

const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const config = { schemaVersion: 1, topic: 'hubdustry-index', exclude: [], repositories: [] };
const manifest = text => ({ type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
const release = (id, tag, date, extra = {}) => ({ id, tag_name: tag, name: tag, published_at: date, prerelease: false, assets: [], ...extra });
const releases = [release(1, 'v1', '2026-01-01'), release(2, 'v2', '2026-02-01'), release(3, 'v3-beta', '2026-03-01', { prerelease: true }), release(4, 'draft', '2026-04-01', { draft: true })];

function fakeApi(custom = {}) {
  return async path => {
    if (custom.api) return custom.api(path);
    if (path.startsWith('/search/')) return { total_count: 1, incomplete_results: false, items: [{ full_name: 'owner/mod' }] };
    if (path === '/repos/owner/mod') return { full_name: 'owner/mod', default_branch: 'main', archived: false };
    if (path.includes('/git/ref/')) return { object: { sha: commit } };
    if (path.includes('/contents/mod.json')) return manifest(JSON.stringify({ name: 'demo', version: path.includes('ref=v') ? 'released-version' : 'development-version', minGameVersion: 160 }));
    if (path.includes('/releases?')) return custom.releases ?? releases;
    throw new Error(`Unexpected fixture request: ${path}`);
  };
}

test('watchlist validates repository names, duplicates and refuses unrelated metadata', () => {
  assert.equal(validateSources(config), config);
  assert.throws(() => validateSources({ ...config, repositories: [{ repository: '../private', channel: 'stable' }] }));
  assert.throws(() => validateSources({ ...config, repositories: [{ repository: 'owner/mod', channel: 'stable' }, { repository: 'OWNER/MOD', channel: 'stable' }] }));
  assert.throws(() => validateSources({ ...config, repositories: [{ repository: 'owner/mod', channel: 'stable', internal: true }] }));
});

test('discovery merges topic and explicit watchlist without overwriting channel; exclusions win', async () => {
  const seed = { repository: 'owner/mod', channel: 'prerelease' };
  assert.deepEqual(await discover({ ...config, repositories: [seed] }, fakeApi()), [seed]);
  assert.deepEqual(await discover({ ...config, exclude: ['OWNER/MOD'] }, fakeApi()), []);
});

test('discovery follows pagination and refuses incomplete search snapshots', async () => {
  const pages = [];
  const result = await discover(config, async path => {
    const page = new URL(path, 'https://api.github.com').searchParams.get('page');
    pages.push(page);
    return { total_count: 101, incomplete_results: false, items: [{ full_name: `owner/mod${page}` }] };
  });
  assert.deepEqual(pages, ['1', '2']);
  assert.equal(result.length, 2);
  await assert.rejects(discover(config, async () => ({ total_count: 1, incomplete_results: true, items: [] })), /Incomplete/);
  await assert.rejects(discover(config, async () => ({ total_count: 1001, incomplete_results: false, items: [] })), /Incomplete/);
});

test('HJSON manifests work in assets; a missing or malformed manifest never becomes a mod', async () => {
  const parsed = await readManifest('owner/mod', commit, async path => path.includes('/assets/mod.hjson')
    ? manifest('# comment\nname: sample\nversion: 1.2.3\nminGameVersion: 160\n') : null);
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.path, 'assets/mod.hjson');
  assert.equal(await readManifest('owner/mod', commit, async () => null), null);
  await assert.rejects(readManifest('owner/mod', commit, async () => manifest('{"version":"1"}')), /Missing mod name/);
});

test('release history drops drafts, preserves prereleases and sorts by publication', () => {
  const list = normalizeReleases(releases, 'owner/mod');
  assert.deepEqual(list.map(item => item.tag), ['v3-beta', 'v2', 'v1']);
});

test('stable and prerelease channels select different releases, with distinct branch/release metadata', async () => {
  const stable = await collect({ repository: 'owner/mod', channel: 'stable' }, fakeApi());
  const beta = await collect({ repository: 'owner/mod', channel: 'prerelease' }, fakeApi());
  assert.equal(stable.latest.tag, 'v2');
  assert.equal(beta.latest.tag, 'v3-beta');
  assert.equal(stable.manifest.version, 'development-version');
  assert.equal(stable.latest.manifest.version, 'released-version');
  assert.deepEqual(Object.keys(stable).sort(), ['repository', 'url', 'archived', 'channel', 'manifest', 'source', 'latest', 'releases'].sort());
});

test('source commits are tracked independently of manifest version', async () => {
  const result = await collect({ repository: 'owner/mod', channel: 'stable' }, fakeApi());
  assert.equal(result.source.commit, commit);
});

test('changed release assets remain visible even when the release tag is unchanged', async () => {
  const asset = { id: 9, name: 'mod.jar', size: 10, digest: `sha256:${digest}`, updated_at: '2026-02-01' };
  const api = fakeApi({ releases: [release(2, 'v2', '2026-02-01', { assets: [asset] })] });
  const before = await collect({ repository: 'owner/mod', channel: 'stable' }, api);
  asset.digest = `sha256:${'c'.repeat(64)}`;
  const after = await collect({ repository: 'owner/mod', channel: 'stable' }, api);
  assert.equal(before.latest.tag, after.latest.tag);
  assert.notEqual(before.latest.assets[0].digest, after.latest.assets[0].digest);
});

test('a tagged repository with an invalid manifest is skipped', async () => {
  const api = fakeApi();
  assert.equal(await collect({ repository: 'owner/mod', channel: 'stable' }, async path =>
    path.includes('/contents/') ? manifest('{ invalid') : api(path)), null);
});

test('failed upstream calls preserve the published snapshot; successful identical runs do not rewrite it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hubdustry-index-test-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep + 'hubdustry-index-test-'));
    await rm(target, { recursive: true });
  });
  const root = pathToFileURL(directory + sep);
  await writeFile(new URL('sources.json', root), JSON.stringify(config));
  const before = '# A short introduction\n';
  await writeFile(new URL('README.md', root), before);
  await writeFile(new URL('index.json', root), 'previous snapshot');
  await assert.rejects(main(root, async () => { throw new Error('GitHub HTTP 403'); }), /403/);
  assert.equal(await readFile(new URL('index.json', root), 'utf8'), 'previous snapshot');
  assert.equal(await readFile(new URL('README.md', root), 'utf8'), before);
  await main(root, fakeApi());
  const first = await stat(new URL('index.json', root));
  await main(root, fakeApi());
  assert.equal((await stat(new URL('index.json', root))).mtimeMs, first.mtimeMs);
  assert.equal(await readFile(new URL('README.md', root), 'utf8'), before);
});
