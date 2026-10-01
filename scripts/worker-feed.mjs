import { createHash } from 'node:crypto';

const COMMIT = /^[a-f0-9]{40}$/;
const CLASSIFIER = /(?:^|[._-])(?:sources?|javadocs?|debug|android|desktop)(?=[._-]|$)/i;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function hashValue(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function eligible(asset) {
  return /\.(jar|zip)$/i.test(asset.name) && !CLASSIFIER.test(asset.name);
}

function releaseArtifact(asset) {
  return {
    kind: 'release-asset', name: asset.name, url: asset.url,
    assetId: asset.id, sizeBytes: asset.sizeBytes, digest: asset.digest ?? null,
    updatedAt: asset.updatedAt ?? null,
  };
}

function selectArtifact(mod, configuredAsset) {
  const { latest } = mod;
  if (configuredAsset !== undefined) {
    const matching = latest.assets.filter(asset => asset.name === configuredAsset);
    if (matching.length === 0) return { reason: 'configured_asset_missing' };
    if (matching.length > 1) return { reason: 'ambiguous_assets' };
    if (!/\.(jar|zip)$/i.test(matching[0].name)) return { reason: 'configured_asset_ineligible' };
    return { artifact: releaseArtifact(matching[0]) };
  }

  const assets = latest.assets.filter(eligible);
  const jars = assets.filter(asset => /\.jar$/i.test(asset.name));
  const zips = assets.filter(asset => /\.zip$/i.test(asset.name));
  const preferred = latest.manifest.java ? jars : (zips.length ? zips : jars);
  if (preferred.length > 1) return { reason: 'ambiguous_assets' };
  if (preferred.length === 1) return { artifact: releaseArtifact(preferred[0]) };
  if (latest.manifest.java) return { reason: 'no_installable_asset' };
  return {
    artifact: {
      kind: 'source-archive', name: `${mod.repository.split('/')[1]}-${latest.commit}.zip`,
      url: `https://github.com/${mod.repository}/archive/${latest.commit}.zip`,
      assetId: null, sizeBytes: null, digest: null, updatedAt: null,
    },
  };
}

export function buildUpdates(index, config = {}) {
  if (index.schemaVersion !== 2 || index.topic !== 'hubdustry-index' || !Array.isArray(index.mods)) {
    throw new Error('Invalid index for worker feed');
  }
  const overrides = new Map((config.repositories ?? []).map(entry => [entry.repository.toLowerCase(), entry.asset]));
  const seen = new Set();
  const mods = [...index.mods].sort((a, b) => a.repository.toLowerCase().localeCompare(b.repository.toLowerCase(), 'en'))
    .map(mod => {
      const identity = mod.repository.toLowerCase();
      if (seen.has(identity)) throw new Error(`Duplicate worker repository: ${mod.repository}`);
      seen.add(identity);
      const result = { repository: mod.repository, channel: mod.channel, status: 'blocked', reason: null, update: null };
      if (mod.archived) return { ...result, reason: 'archived_repository' };
      if (!mod.latest) return { ...result, reason: 'no_release' };
      if (!mod.latest.manifest) return { ...result, reason: 'missing_release_manifest' };
      if (!COMMIT.test(mod.latest.commit)) throw new Error(`Invalid release commit: ${mod.repository}`);
      const selection = selectArtifact(mod, overrides.get(identity));
      if (selection.reason) return { ...result, reason: selection.reason };
      const { latest } = mod;
      const update = {
        releaseId: latest.id, tag: latest.tag, commit: latest.commit, publishedAt: latest.publishedAt,
        modName: latest.manifest.name, version: latest.manifest.version, minGameVersion: latest.manifest.minGameVersion,
        java: latest.manifest.java, prerelease: latest.prerelease,
        artifact: selection.artifact,
      };
      return { ...result, status: 'ready', update: { key: hashValue(update), ...update } };
    });
  return { schemaVersion: 1, topic: 'hubdustry-index', revision: hashValue(mods), mods };
}
