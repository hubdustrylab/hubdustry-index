import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Hjson from 'hjson';

const API = 'https://api.github.com';
const ROOT = new URL('../', import.meta.url);
const MANIFESTS = ['mod.json', 'mod.hjson', 'assets/mod.json', 'assets/mod.hjson'];
const MAX_BODY = 4 * 1024 * 1024;
const REPOSITORY = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/;

export function validateSources(config) {
  if (config.schemaVersion !== 1 || config.topic !== 'hubdustry-index'
      || !Array.isArray(config.repositories) || !Array.isArray(config.exclude)) {
    throw new Error('Invalid sources.json');
  }
  const seen = new Set();
  for (const entry of config.repositories) {
    if (!REPOSITORY.test(entry.repository) || seen.has(entry.repository.toLowerCase())
        || !['stable', 'prerelease'].includes(entry.channel)
        || Object.keys(entry).some(key => !['repository', 'channel'].includes(key))) throw new Error('Invalid tracked repository');
    seen.add(entry.repository.toLowerCase());
  }
  if (config.exclude.some(repo => !REPOSITORY.test(repo))) throw new Error('Invalid excluded repository');
  return config;
}

export async function github(path, { allowMissing = false } = {}) {
  const url = new URL(path, API);
  if (url.origin !== API) throw new Error('Unexpected API origin');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'hubdustry-index', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${url.pathname}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error(`GitHub response too large: ${url.pathname}`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function discover(config, api = github) {
  const found = new Map(config.repositories.map(entry => [entry.repository.toLowerCase(), entry]));
  for (let page = 1; ; page++) {
    const result = await api(`/search/repositories?q=${encodeURIComponent(`topic:${config.topic} archived:false fork:true`)}&per_page=100&page=${page}`);
    if (result.incomplete_results || result.total_count > 1000 || !Array.isArray(result.items)) {
      throw new Error('Incomplete GitHub discovery; keeping the existing index');
    }
    for (const repo of result.items) {
      if (!REPOSITORY.test(repo.full_name)) throw new Error('Invalid repository returned by GitHub');
      if (!found.has(repo.full_name.toLowerCase())) found.set(repo.full_name.toLowerCase(), { repository: repo.full_name, channel: 'stable' });
    }
    if (page * 100 >= result.total_count) break;
    if (result.items.length === 0) throw new Error('Truncated repository search');
  }
  const excluded = new Set(config.exclude.map(repo => repo.toLowerCase()));
  return [...found.values()].filter(entry => !excluded.has(entry.repository.toLowerCase()))
    .sort((a, b) => a.repository.toLowerCase().localeCompare(b.repository.toLowerCase(), 'en'));
}

export async function readManifest(repository, ref, api = github) {
  for (const path of MANIFESTS) {
    const file = await api(`/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`, { allowMissing: true });
    if (!file) continue;
    if (file.type !== 'file' || file.encoding !== 'base64' || file.size > 256 * 1024) throw new Error(`Invalid manifest: ${repository}/${path}`);
    const text = Buffer.from(file.content, 'base64').toString('utf8');
    let mod;
    try {
      mod = Hjson.parse(text);
    } catch {
      throw new Error(`Invalid mod manifest: ${repository}`, { cause: 'manifest' });
    }
    if (!mod || typeof mod.name !== 'string' || !mod.name.trim()) throw new Error(`Missing mod name: ${repository}`, { cause: 'manifest' });
    return {
      path, name: mod.name, displayName: typeof mod.displayName === 'string' ? mod.displayName : mod.name,
      version: String(mod.version ?? ''), minGameVersion: String(mod.minGameVersion ?? ''), java: mod.java === true,
    };
  }
  return null;
}

export function normalizeReleases(releases, repository) {
  return releases.filter(release => !release.draft).map(release => ({
    id: release.id, tag: release.tag_name, name: release.name || release.tag_name,
    url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    publishedAt: release.published_at, prerelease: release.prerelease === true,
    assets: release.assets.map(asset => ({
      id: asset.id, name: asset.name, sizeBytes: asset.size, digest: asset.digest ?? null,
      updatedAt: asset.updated_at,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`,
    })).sort((a, b) => a.id - b.id),
  })).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt), 'en') || b.id - a.id);
}

export async function collect(entry, api = github) {
  const repo = await api(`/repos/${entry.repository}`);
  if (!REPOSITORY.test(repo.full_name)) throw new Error('Invalid canonical repository');
  const repository = repo.full_name;
  const ref = await api(`/repos/${repository}/git/ref/heads/${repo.default_branch.split('/').map(encodeURIComponent).join('/')}`);
  const commit = ref.object.sha;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit');
  let manifest;
  try {
    manifest = await readManifest(repository, commit, api);
  } catch (error) {
    if (error.cause !== 'manifest') throw error;
    console.log(`Skipping ${repository}: invalid mod manifest`);
    return null;
  }
  if (!manifest) {
    console.log(`Skipping ${repository}: no mod.json/mod.hjson`);
    return null;
  }
  const raw = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/repos/${repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid releases response');
    raw.push(...batch);
    if (batch.length < 100) break;
    if (page === 20) throw new Error(`Release pagination limit: ${repository}`);
  }
  const releases = normalizeReleases(raw, repository);
  const latest = releases.find(release => entry.channel === 'prerelease' || !release.prerelease) ?? null;
  const latestManifest = latest ? await readManifest(repository, latest.tag, api) : null;
  return {
    repository, url: `https://github.com/${repository}`, archived: repo.archived === true,
    channel: entry.channel, manifest,
    source: { branch: repo.default_branch, commit, url: `https://github.com/${repository}/commit/${commit}` },
    latest: latest ? { ...latest, manifest: latestManifest } : null,
    releases,
  };
}

export async function buildIndex(config, api = github) {
  validateSources(config);
  const mods = [];
  for (const entry of await discover(config, api)) {
    const mod = await collect(entry, api);
    if (mod) mods.push(mod);
  }
  return { schemaVersion: 1, topic: config.topic, mods };
}

export async function main(root = ROOT, api = github) {
  const config = JSON.parse(await readFile(new URL('sources.json', root), 'utf8'));
  // Build everything before writing: API/rate-limit/parse failures preserve the last snapshot.
  const index = await buildIndex(config, api);
  const content = `${JSON.stringify(index, null, 2)}\n`;
  const destination = new URL('index.json', root);
  if (await readFile(destination, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) !== content) {
    const temporary = new URL('index.json.tmp', root);
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, destination);
  }
  console.log(`Indexed ${index.mods.length} mods.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
