import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Hjson from 'hjson';
import { validateSources, validateIndex, validateIndexSources, validateUpdates } from './validate.mjs';
import { buildUpdates } from './worker-feed.mjs';

export { validateSources } from './validate.mjs';

const API = 'https://api.github.com';
const ROOT = new URL('../', import.meta.url);
const MANIFESTS = ['mod.json', 'mod.hjson', 'assets/mod.json', 'assets/mod.hjson'];
const MAX_BODY = 4 * 1024 * 1024;
const REPOSITORY = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/(?!\.{1,2}$)[a-zA-Z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;

// Inject transport and time in tests; production uses the inherited GitHub identity.
export function createGithubClient({ fetchImpl = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)),
  now = Date.now, attempts = 3, timeoutMs = 20_000, maxRetryDelayMs = 30_000 } = {}) {
  return async function request(path, { allowMissing = false } = {}) {
    const url = new URL(path, API);
    if (url.origin !== API) throw new Error('Unexpected API origin');
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'hubdustry-index', 'X-GitHub-Api-Version': '2022-11-28' };
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        if (response.status === 404 && allowMissing) {
          await response.body?.cancel();
          return null;
        }
        if (response.ok) {
          if (Number(response.headers.get('content-length')) > MAX_BODY) throw new Error(`GitHub response too large: ${url.pathname}`);
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MAX_BODY) throw new Error(`GitHub response too large: ${url.pathname}`);
            chunks.push(chunk);
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
      } catch (error) {
        await response?.body?.cancel().catch(() => {});
        const transient = error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name);
        if (!transient || attempt === attempts - 1) throw error;
        await sleep(Math.min(1000 * 2 ** attempt, maxRetryDelayMs));
        continue;
      }
      const retryAfter = response.headers.get('retry-after');
      const rateLimited = response.status === 403
        && (retryAfter !== null || response.headers.get('x-ratelimit-remaining') === '0');
      const transient = rateLimited || [429, 500, 502, 503, 504].includes(response.status);
      const failure = new Error(`GitHub HTTP ${response.status}: ${url.pathname}`);
      await response.body?.cancel();
      if (!transient || attempt === attempts - 1) throw failure;
      let delay = 1000 * 2 ** attempt;
      if (retryAfter !== null) {
        delay = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now();
      } else if (rateLimited && response.headers.has('x-ratelimit-reset')) {
        delay = Number(response.headers.get('x-ratelimit-reset')) * 1000 - now();
      }
      if (!Number.isFinite(delay)) delay = 1000 * 2 ** attempt;
      // Never retry earlier than GitHub asks, or wait out a long rate-limit window.
      if (delay > maxRetryDelayMs) throw new Error(`${failure.message}; retry delay exceeds ${maxRetryDelayMs}ms`);
      await sleep(Math.max(0, delay));
    }
    throw new Error('Invalid GitHub retry configuration');
  };
}

export const github = createGithubClient();

export async function discover(config, api = github) {
  const found = new Map(config.repositories.map(entry => [entry.repository.toLowerCase(), entry]));
  const discovered = new Set();
  let total;
  for (let page = 1; ; page++) {
    const result = await api(`/search/repositories?q=${encodeURIComponent(`topic:${config.topic} archived:false fork:true`)}&per_page=100&page=${page}`);
    if (result.incomplete_results || !Number.isInteger(result.total_count) || result.total_count < 0
        || result.total_count > 1000 || !Array.isArray(result.items) || (total !== undefined && total !== result.total_count)) {
      throw new Error('Incomplete GitHub discovery; keeping the existing index');
    }
    total = result.total_count;
    const expected = Math.min(100, total - (page - 1) * 100);
    if (result.items.length !== expected) throw new Error('Truncated repository search');
    for (const repo of result.items) {
      if (!REPOSITORY.test(repo.full_name)) throw new Error('Invalid repository returned by GitHub');
      const key = repo.full_name.toLowerCase();
      if (discovered.has(key)) throw new Error('Duplicate repository in discovery; retry with a consistent snapshot');
      discovered.add(key);
      if (!found.has(key)) found.set(key, { repository: repo.full_name, channel: 'stable' });
    }
    if (page * 100 >= total) break;
  }
  const excluded = new Set(config.exclude.map(repo => repo.toLowerCase()));
  return [...found.values()].filter(entry => !excluded.has(entry.repository.toLowerCase()))
    .sort((a, b) => a.repository.toLowerCase().localeCompare(b.repository.toLowerCase(), 'en'));
}

export async function readManifest(repository, ref, api = github) {
  for (const path of MANIFESTS) {
    const file = await api(`/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`, { allowMissing: true });
    if (!file) continue;
    if (file.type !== 'file' || file.encoding !== 'base64' || file.size > 256 * 1024 || typeof file.content !== 'string') {
      throw new Error(`Invalid manifest: ${repository}/${path}`);
    }
    const text = Buffer.from(file.content, 'base64').toString('utf8');
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error(`Manifest too large: ${repository}/${path}`);
    let mod;
    try {
      mod = Hjson.parse(text);
    } catch {
      throw new Error(`Invalid mod manifest: ${repository}`, { cause: 'manifest' });
    }
    if (!mod || typeof mod.name !== 'string' || !mod.name.trim()) throw new Error(`Missing mod name: ${repository}`, { cause: 'manifest' });
    if (![mod.version, mod.minGameVersion].every(value => value == null || ['string', 'number'].includes(typeof value))) {
      throw new Error(`Invalid mod version: ${repository}`, { cause: 'manifest' });
    }
    return {
      path, name: mod.name, displayName: typeof mod.displayName === 'string' ? mod.displayName : mod.name,
      version: String(mod.version ?? ''), minGameVersion: String(mod.minGameVersion ?? ''),
      java: mod.java === true || (typeof mod.main === 'string' && mod.main.trim().length > 0),
    };
  }
  return null;
}

export function normalizeReleases(releases, repository) {
  return releases.filter(release => !release.draft).map(release => ({
    id: release.id, tag: release.tag_name, name: release.name || release.tag_name,
    url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    publishedAt: release.published_at, prerelease: release.prerelease === true,
    assets: release.assets.filter(asset => asset.state === undefined || asset.state === 'uploaded').map(asset => ({
      id: asset.id, name: asset.name, sizeBytes: asset.size, digest: asset.digest ?? null,
      updatedAt: asset.updated_at,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`,
    })).sort((a, b) => a.id - b.id),
  })).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt), 'en') || b.id - a.id);
}

export async function resolveReleaseCommit(repository, tag, api = github) {
  const ref = await api(`/repos/${repository}/git/ref/tags/${tag.split('/').map(encodeURIComponent).join('/')}`);
  let object = ref.object;
  const seen = new Set();
  for (let depth = 0; depth < 8; depth++) {
    if (!object || !SHA.test(object.sha) || seen.has(object.sha)) throw new Error(`Invalid release tag: ${repository}/${tag}`);
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') throw new Error(`Release tag does not point to a commit: ${repository}/${tag}`);
    seen.add(object.sha);
    object = (await api(`/repos/${repository}/git/tags/${object.sha}`)).object;
  }
  throw new Error(`Release tag nesting limit: ${repository}/${tag}`);
}

export async function collect(entry, api = github) {
  const repo = await api(`/repos/${entry.repository}`);
  if (!REPOSITORY.test(repo.full_name) || typeof repo.default_branch !== 'string' || !repo.default_branch) throw new Error('Invalid canonical repository');
  const repository = repo.full_name;
  if (entry.asset && repository.toLowerCase() !== entry.repository.toLowerCase()) {
    throw new Error(`Update sources.json to canonical repository ${repository} before applying its asset override`);
  }
  const ref = await api(`/repos/${repository}/git/ref/heads/${repo.default_branch.split('/').map(encodeURIComponent).join('/')}`);
  const commit = ref.object.sha;
  if (!SHA.test(commit)) throw new Error('Invalid source commit');
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
  let releaseCommit = null;
  let latestManifest = null;
  if (latest) {
    releaseCommit = await resolveReleaseCommit(repository, latest.tag, api);
    // Read the exact revision the worker will download, even when tags move.
    try {
      latestManifest = await readManifest(repository, releaseCommit, api);
    } catch (error) {
      if (error.cause !== 'manifest') throw error;
      console.log(`Blocking ${repository}@${latest.tag}: invalid release manifest`);
    }
  }
  return {
    repository, url: `https://github.com/${repository}`, archived: repo.archived === true,
    channel: entry.channel, manifest,
    source: { branch: repo.default_branch, commit, url: `https://github.com/${repository}/commit/${commit}` },
    latest: latest ? { ...latest, commit: releaseCommit, manifest: latestManifest } : null,
    releases,
  };
}

export async function buildIndex(config, api = github, { previousIndex = null } = {}) {
  validateSources(config);
  const mods = new Map();
  const protectedRepos = new Set([...config.repositories.map(entry => entry.repository),
    ...(previousIndex?.mods ?? []).map(mod => mod.repository)].map(repository => repository.toLowerCase()));
  const excluded = new Set(config.exclude.map(repository => repository.toLowerCase()));
  for (const entry of await discover(config, api)) {
    const mod = await collect(entry, api);
    if (!mod) {
      if (protectedRepos.has(entry.repository.toLowerCase())) throw new Error(`Tracked mod manifest unavailable: ${entry.repository}; keeping the existing index`);
      continue;
    }
    const key = mod.repository.toLowerCase();
    if (excluded.has(key)) continue;
    const previous = mods.get(key);
    if (previous && previous.channel !== mod.channel) throw new Error(`Conflicting channels for canonical repository: ${mod.repository}`);
    mods.set(key, mod);
  }
  const index = { schemaVersion: 2, topic: config.topic,
    mods: [...mods.values()].sort((a, b) => a.repository.toLowerCase().localeCompare(b.repository.toLowerCase(), 'en')) };
  return validateIndex(index);
}

export async function main(root = ROOT, api = github) {
  const config = JSON.parse(await readFile(new URL('sources.json', root), 'utf8'));
  const previousText = await readFile(new URL('index.json', root), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  let previousIndex = null;
  try { previousIndex = JSON.parse(previousText); } catch { /* A first run can replace an absent or corrupt snapshot. */ }
  // Build and validate both independent snapshots before publishing either.
  const index = await buildIndex(config, api, { previousIndex });
  validateIndexSources(index, config);
  const updates = validateUpdates(buildUpdates(index, config));
  const staged = [];
  try {
    for (const [name, value] of [['index.json', index], ['updates.json', updates]]) {
      const content = `${JSON.stringify(value, null, 2)}\n`;
      const destination = new URL(name, root);
      const existing = await readFile(destination, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      if (existing === content) continue;
      const temporary = new URL(`.${name}.${randomUUID()}.tmp`, root);
      staged.push({ temporary, destination });
      await writeFile(temporary, content, 'utf8');
    }
    for (const { temporary, destination } of staged) await rename(temporary, destination);
  } finally {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
  }
  console.log(`Indexed ${index.mods.length} mods; ${updates.mods.filter(mod => mod.status === 'ready').length} ready for updates.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
