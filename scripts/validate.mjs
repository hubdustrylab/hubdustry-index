import { isDeepStrictEqual } from 'node:util';
import { hashValue } from './worker-feed.mjs';

const TOPIC = 'hubdustry-index';
const REPOSITORY = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MANIFEST_PATHS = ['mod.json', 'mod.hjson', 'assets/mod.json', 'assets/mod.hjson'];
const RELEASE_FIELDS = ['id', 'tag', 'name', 'url', 'publishedAt', 'prerelease', 'assets'];
const CONTROL = /[\u0000-\u001f\u007f]/;

function requireValue(condition, path, description) {
  if (!condition) throw new Error(`${path}: ${description}`);
}

function object(value, path, fields, optional = []) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), path, 'expected an object');
  for (const field of fields) requireValue(Object.hasOwn(value, field), `${path}.${field}`, 'missing required field');
  for (const field of Object.keys(value)) requireValue(fields.includes(field) || optional.includes(field), `${path}.${field}`, 'unexpected field');
}

function string(value, path, { nonempty = false, noControls = false } = {}) {
  requireValue(typeof value === 'string', path, 'expected a string');
  if (nonempty) requireValue(value.trim().length > 0, path, 'expected a nonempty string');
  if (noControls) requireValue(!CONTROL.test(value), path, 'control characters are not allowed');
}

function boolean(value, path) {
  requireValue(typeof value === 'boolean', path, 'expected a boolean');
}

function integer(value, path, minimum = 0) {
  requireValue(Number.isSafeInteger(value) && value >= minimum, path, `expected a safe integer >= ${minimum}`);
}

function array(value, path) {
  requireValue(Array.isArray(value), path, 'expected an array');
}

function repository(value, path) {
  string(value, path);
  requireValue(REPOSITORY.test(value) && !['.', '..'].includes(value.split('/')[1]), path, 'invalid owner/repository');
}

function channel(value, path) {
  requireValue(value === 'stable' || value === 'prerelease', path, 'expected stable or prerelease');
}

function commit(value, path) {
  requireValue(typeof value === 'string' && COMMIT.test(value), path, 'expected a 40-character lowercase commit SHA');
}

function digest(value, path, nullable = true) {
  requireValue((nullable && value === null) || (typeof value === 'string' && DIGEST.test(value)), path,
    `expected ${nullable ? 'null or ' : ''}sha256:<64 lowercase hexadecimal characters>`);
}

function date(value, path) {
  string(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  requireValue(match && Number.isFinite(Date.parse(value)), path, 'expected an ISO date or timestamp');
  const [, year, month, day] = match;
  const calendarDate = new Date(`${year}-${month}-${day}T00:00:00Z`);
  requireValue(calendarDate.getUTCFullYear() === Number(year) && calendarDate.getUTCMonth() + 1 === Number(month)
    && calendarDate.getUTCDate() === Number(day), path, 'invalid calendar date');
}

function url(value, expected, path) {
  string(value, path);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${path}: invalid URL`); }
  requireValue(parsed.protocol === 'https:' && parsed.origin === 'https://github.com'
    && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && value === expected && parsed.href === expected,
  path, `expected canonical GitHub URL ${expected}`);
}

function filename(value, path, installable = false) {
  string(value, path, { nonempty: true, noControls: true });
  requireValue(!/[\\/]/.test(value) && !['.', '..'].includes(value), path, 'expected a filename without a path');
  if (installable) requireValue(/\.(jar|zip)$/i.test(value), path, 'expected a .jar or .zip filename');
}

function manifest(value, path) {
  object(value, path, ['path', 'name', 'displayName', 'version', 'minGameVersion', 'java']);
  requireValue(MANIFEST_PATHS.includes(value.path), `${path}.path`, 'unsupported mod manifest path');
  string(value.name, `${path}.name`, { nonempty: true });
  for (const field of ['displayName', 'version', 'minGameVersion']) string(value[field], `${path}.${field}`);
  boolean(value.java, `${path}.java`);
}

function unique(value, seen, path, description) {
  requireValue(!seen.has(value), path, `duplicate ${description}`);
  seen.add(value);
}

function repositoriesInOrder(mods, path, validate) {
  array(mods, path);
  const seen = new Set();
  let previous;
  mods.forEach((mod, index) => {
    const itemPath = `${path}[${index}]`;
    validate(mod, itemPath);
    const canonical = mod.repository.toLowerCase();
    unique(canonical, seen, `${itemPath}.repository`, 'repository');
    requireValue(previous === undefined || previous.localeCompare(canonical, 'en') < 0, `${itemPath}.repository`,
      'repositories must be sorted case-insensitively');
    previous = canonical;
  });
}

export function validateSources(config) {
  object(config, 'sources', ['schemaVersion', 'topic', 'repositories', 'exclude']);
  requireValue(config.schemaVersion === 1, 'sources.schemaVersion', 'expected 1');
  requireValue(config.topic === TOPIC, 'sources.topic', `expected ${TOPIC}`);
  array(config.repositories, 'sources.repositories');
  array(config.exclude, 'sources.exclude');
  const tracked = new Set();
  config.repositories.forEach((entry, index) => {
    const path = `sources.repositories[${index}]`;
    object(entry, path, ['repository', 'channel'], ['asset']);
    repository(entry.repository, `${path}.repository`);
    unique(entry.repository.toLowerCase(), tracked, `${path}.repository`, 'tracked repository');
    channel(entry.channel, `${path}.channel`);
    if (Object.hasOwn(entry, 'asset')) filename(entry.asset, `${path}.asset`, true);
  });
  const excluded = new Set();
  config.exclude.forEach((entry, index) => {
    const path = `sources.exclude[${index}]`;
    repository(entry, path);
    unique(entry.toLowerCase(), excluded, path, 'excluded repository');
  });
  return config;
}

function asset(value, repo, tag, path) {
  object(value, path, ['id', 'name', 'sizeBytes', 'digest', 'updatedAt', 'url']);
  integer(value.id, `${path}.id`, 1);
  filename(value.name, `${path}.name`);
  integer(value.sizeBytes, `${path}.sizeBytes`);
  digest(value.digest, `${path}.digest`);
  date(value.updatedAt, `${path}.updatedAt`);
  url(value.url, `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(value.name)}`, `${path}.url`);
}

function release(value, repo, path, latest = false) {
  object(value, path, latest ? [...RELEASE_FIELDS, 'manifest', 'commit'] : RELEASE_FIELDS);
  integer(value.id, `${path}.id`, 1);
  string(value.tag, `${path}.tag`, { nonempty: true, noControls: true });
  string(value.name, `${path}.name`);
  url(value.url, `https://github.com/${repo}/releases/tag/${encodeURIComponent(value.tag)}`, `${path}.url`);
  date(value.publishedAt, `${path}.publishedAt`);
  boolean(value.prerelease, `${path}.prerelease`);
  array(value.assets, `${path}.assets`);
  const ids = new Set();
  const names = new Set();
  value.assets.forEach((item, index) => {
    const itemPath = `${path}.assets[${index}]`;
    asset(item, repo, value.tag, itemPath);
    unique(item.id, ids, `${itemPath}.id`, 'asset ID');
    unique(item.name, names, `${itemPath}.name`, 'asset filename');
  });
  if (latest) {
    commit(value.commit, `${path}.commit`);
    if (value.manifest !== null) manifest(value.manifest, `${path}.manifest`);
  }
}

function validateMod(mod, path) {
  object(mod, path, ['repository', 'url', 'archived', 'channel', 'manifest', 'source', 'latest', 'releases']);
  repository(mod.repository, `${path}.repository`);
  url(mod.url, `https://github.com/${mod.repository}`, `${path}.url`);
  boolean(mod.archived, `${path}.archived`);
  channel(mod.channel, `${path}.channel`);
  manifest(mod.manifest, `${path}.manifest`);
  object(mod.source, `${path}.source`, ['branch', 'commit', 'url']);
  string(mod.source.branch, `${path}.source.branch`, { nonempty: true, noControls: true });
  commit(mod.source.commit, `${path}.source.commit`);
  url(mod.source.url, `https://github.com/${mod.repository}/commit/${mod.source.commit}`, `${path}.source.url`);
  array(mod.releases, `${path}.releases`);
  const ids = new Set();
  const tags = new Set();
  let previous;
  mod.releases.forEach((item, index) => {
    const itemPath = `${path}.releases[${index}]`;
    release(item, mod.repository, itemPath);
    unique(item.id, ids, `${itemPath}.id`, 'release ID');
    unique(item.tag, tags, `${itemPath}.tag`, 'release tag');
    requireValue(!previous || Date.parse(previous.publishedAt) > Date.parse(item.publishedAt)
      || (Date.parse(previous.publishedAt) === Date.parse(item.publishedAt) && previous.id > item.id), itemPath,
    'releases must be sorted by publication descending, then ID descending');
    previous = item;
  });
  const selected = mod.releases.find(item => mod.channel === 'prerelease' || !item.prerelease);
  if (mod.latest === null) {
    requireValue(selected === undefined, `${path}.latest`, 'missing latest eligible release');
  } else {
    release(mod.latest, mod.repository, `${path}.latest`, true);
    requireValue(mod.channel !== 'stable' || !mod.latest.prerelease, `${path}.latest.prerelease`,
      'stable channel cannot select a prerelease');
    const { manifest: latestManifest, commit: latestCommit, ...metadata } = mod.latest;
    requireValue(isDeepStrictEqual(metadata, selected), `${path}.latest`, 'must match the newest eligible release metadata');
  }
}

export function validateIndex(index) {
  object(index, 'index', ['schemaVersion', 'topic', 'mods']);
  requireValue(index.schemaVersion === 2, 'index.schemaVersion', 'expected 2');
  requireValue(index.topic === TOPIC, 'index.topic', `expected ${TOPIC}`);
  repositoriesInOrder(index.mods, 'index.mods', validateMod);
  return index;
}

export function validateIndexSources(index, config) {
  validateSources(config);
  validateIndex(index);
  const excluded = new Set(config.exclude.map(value => value.toLowerCase()));
  const indexed = new Map(index.mods.map(mod => [mod.repository.toLowerCase(), mod]));
  for (const mod of index.mods) {
    requireValue(!excluded.has(mod.repository.toLowerCase()), 'index.mods', `excluded repository ${mod.repository} is still indexed`);
  }
  for (const entry of config.repositories) {
    const identity = entry.repository.toLowerCase();
    if (excluded.has(identity)) continue;
    const tracked = indexed.get(identity);
    requireValue(tracked !== undefined, 'index.mods', `tracked repository ${entry.repository} is missing; check its manifest and update sources.json to its canonical GitHub repository if it was renamed`);
    requireValue(tracked.channel === entry.channel, 'index.mods', `channel for ${tracked.repository} must match sources.json (${entry.channel})`);
  }
  return index;
}

function artifact(value, update, repo, path) {
  object(value, path, ['kind', 'name', 'url', 'assetId', 'sizeBytes', 'digest', 'updatedAt']);
  filename(value.name, `${path}.name`, true);
  if (value.kind === 'release-asset') {
    integer(value.assetId, `${path}.assetId`, 1);
    integer(value.sizeBytes, `${path}.sizeBytes`);
    digest(value.digest, `${path}.digest`);
    date(value.updatedAt, `${path}.updatedAt`);
    url(value.url, `https://github.com/${repo}/releases/download/${encodeURIComponent(update.tag)}/${encodeURIComponent(value.name)}`, `${path}.url`);
  } else if (value.kind === 'source-archive') {
    requireValue(!update.java, path, 'a Java mod requires a compiled release asset');
    requireValue(/\.zip$/i.test(value.name), `${path}.name`, 'source archive must be a .zip');
    for (const field of ['assetId', 'sizeBytes', 'digest', 'updatedAt']) requireValue(value[field] === null, `${path}.${field}`, 'source archive metadata must be null');
    url(value.url, `https://github.com/${repo}/archive/${update.commit}.zip`, `${path}.url`);
  } else {
    throw new Error(`${path}.kind: expected release-asset or source-archive`);
  }
}

function updateEntry(mod, path) {
  object(mod, path, ['repository', 'channel', 'status', 'reason', 'update']);
  repository(mod.repository, `${path}.repository`);
  channel(mod.channel, `${path}.channel`);
  if (mod.status === 'blocked') {
    string(mod.reason, `${path}.reason`, { nonempty: true });
    requireValue(mod.update === null, `${path}.update`, 'blocked entry must have a null update');
    return;
  }
  requireValue(mod.status === 'ready', `${path}.status`, 'expected ready or blocked');
  requireValue(mod.reason === null, `${path}.reason`, 'ready entry must have a null reason');
  const update = mod.update;
  const updatePath = `${path}.update`;
  object(update, updatePath, ['key', 'releaseId', 'tag', 'publishedAt', 'commit', 'modName', 'version', 'minGameVersion', 'java', 'prerelease', 'artifact']);
  digest(update.key, `${updatePath}.key`, false);
  integer(update.releaseId, `${updatePath}.releaseId`, 1);
  string(update.tag, `${updatePath}.tag`, { nonempty: true, noControls: true });
  date(update.publishedAt, `${updatePath}.publishedAt`);
  commit(update.commit, `${updatePath}.commit`);
  string(update.modName, `${updatePath}.modName`, { nonempty: true });
  string(update.version, `${updatePath}.version`);
  string(update.minGameVersion, `${updatePath}.minGameVersion`);
  boolean(update.java, `${updatePath}.java`);
  boolean(update.prerelease, `${updatePath}.prerelease`);
  requireValue(mod.channel !== 'stable' || !update.prerelease, `${updatePath}.prerelease`, 'stable channel cannot select a prerelease');
  artifact(update.artifact, update, mod.repository, `${updatePath}.artifact`);
  const { key, ...metadata } = update;
  requireValue(key === hashValue(metadata), `${updatePath}.key`, 'update fingerprint does not match its metadata');
}

export function validateUpdates(feed) {
  object(feed, 'updates', ['schemaVersion', 'topic', 'revision', 'mods']);
  requireValue(feed.schemaVersion === 1, 'updates.schemaVersion', 'expected 1');
  requireValue(feed.topic === TOPIC, 'updates.topic', `expected ${TOPIC}`);
  digest(feed.revision, 'updates.revision', false);
  repositoriesInOrder(feed.mods, 'updates.mods', updateEntry);
  requireValue(feed.revision === hashValue(feed.mods), 'updates.revision', 'feed fingerprint does not match its mods');
  return feed;
}
