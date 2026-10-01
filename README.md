# Hubdustry Index

Public Mindustry mod metadata and a deterministic feed for a future auto-update worker. This repository collects release information; no installation worker is deployed here.

Add the **`hubdustry-index`** topic to a mod's GitHub repository for automatic discovery. Collection runs every two hours and can also be triggered manually in GitHub Actions. Repositories in `sources.json` are tracked even without the topic; `exclude` takes precedence.

## Feeds

| File | Schema | Purpose |
| --- | --- | --- |
| [`index.json`](index.json) | `2` | Full public metadata, default-branch manifest, source commit, and release history. |
| [`updates.json`](updates.json) | `1` | One install candidate or an explicit blocked result per repository. Use this for worker polling. |

Worker endpoint:

```text
https://raw.githubusercontent.com/hubdustrylab/hubdustry-index/main/updates.json
```

Use HTTP conditional requests with the response's `ETag`. Feed `revision` and each ready entry's `update.key` are deterministic SHA-256 identifiers. Changes to candidate metadata or its artifact change the key; repeated collection without changes produces identical files. Default-branch source commits and unrelated release-history changes are not deployment triggers. Compare `update.key` per repository rather than version strings, tags, or the full index.

Each `mods` entry contains `repository`, `channel`, `status`, `reason`, and `update`. A `ready` entry has `reason: null` and an `update` containing:

- `key`, `releaseId`, `tag`, and the resolved release `commit`.
- `publishedAt`, `modName`, `version`, `minGameVersion`, `java`, and `prerelease`.
- `artifact`: `kind`, `name`, `url`, `assetId`, `sizeBytes`, `digest`, and `updatedAt`.

`artifact.kind` is `release-asset` or `source-archive`. Some artifact metadata is unavailable and represented by `null`. `update.modName`, `version`, `minGameVersion`, and `java` come from the manifest at the release's resolved commit. That manifest can differ from a built JAR or ZIP, so the worker must inspect the downloaded package before installation. A checksum establishes integrity, not whether an upstream mod is trusted.

## Candidate selection

The `stable` channel selects the newest published, non-draft, non-prerelease release. The `prerelease` channel selects the newest published non-draft release, including prereleases. Selection uses publication time, with release ID as a deterministic tie-breaker. It does not assume semantic versions.

The release tag is resolved to a commit before reading its manifest. Java mods are identified by `java: true` or a non-empty `main` class. Default selection requires one installable JAR for Java mods. Content mods prefer one ZIP, then one JAR; when neither exists, they use a source archive pinned to the release commit. Multiple eligible files block automatic selection. Classifier artifacts such as sources and Javadocs are excluded from default selection.

The collector never silently falls back to an older release when the selected release cannot be installed. Blocked entries have `update: null` and one of these reasons:

| Reason | Meaning |
| --- | --- |
| `archived_repository` | Upstream repository is archived. |
| `no_release` | No published release matches the channel. |
| `missing_release_manifest` | The selected release's mod manifest is missing or invalid at its resolved commit. |
| `no_installable_asset` | The selected release has no suitable artifact, such as a Java mod without a JAR. |
| `ambiguous_assets` | More than one file matches the preferred artifact type. |
| `configured_asset_missing` | The explicitly configured filename is absent from the selected release. |
| `configured_asset_ineligible` | The configured file is not a supported installable archive. |

## Configure tracked repositories

`sources.json` remains schema `1`. Explicit entries choose a channel and can optionally choose an exact release-asset filename:

```json
{
  "schemaVersion": 1,
  "topic": "hubdustry-index",
  "exclude": ["hubdustrylab/hubdustry-index"],
  "repositories": [
    {
      "repository": "owner/mod",
      "channel": "stable",
      "asset": "mod.jar"
    }
  ]
}
```

Omit `asset` to use default selection. An exact override can select a JAR or ZIP, including a classifier file or a Java mod packaged as ZIP; inspect its contents before installing. A missing or unsupported override blocks the release instead of choosing another file. Topic-discovered repositories default to `stable`. A `prerelease` entry enables collection of prereleases; a worker must separately opt in for that repository.

Use canonical GitHub repository names in `sources.json`. After an upstream rename or transfer, update the configured name; generation or consistency checks fail until it matches the canonical repository.

## Future worker contract

Keep an explicit allowlist of trusted repositories and an applied key for each installation. Retain the last valid feed so a `304 Not Modified` response can still retry an installation that failed earlier.

```text
response = GET updates.json with If-None-Match: cachedETag
if response is 200:
    validate feed structure and schemaVersion == 1; reject unknown schemas
    cache accepted feed and its ETag
else if response is not 304:
    retry later using the last valid feed

for entry in cachedFeed.mods:
    if entry.repository is not explicitly trusted: continue
    if entry.status != "ready": report entry.reason; continue
    candidate = entry.update
    if candidate.key == applied[entry.repository].key: continue
    if candidate.prerelease and repository has no prerelease opt-in: continue
    require installed game meets candidate.minGameVersion
    require downgrade policy permits this release versus last applied release
    require explicit policy or operator approval if candidate.modName changes installed identity
    download candidate.artifact.url to staging
    verify sizeBytes when provided and SHA-256 digest when provided
    require archive manifest name == candidate.modName
    inspect archive manifest, game compatibility, and package contents
    atomically install staged package with a retained previous installation
    on success: persist key and release metadata
    on failure: restore previous installation; retain old applied key and retry later
```

Missing or removed upstream releases can expose an older candidate. Keep the last applied `publishedAt` and release metadata, and require an explicit policy or operator action for downgrades. Publication time is an ordering hint, not proof of version compatibility. A changed key for the same release may represent a replaced asset; verify it again.

When `digest` is `null`, the feed provides no upstream checksum. Source archives also have no upstream checksum here. The worker needs its own package validation and trust policy; calculating a local hash alone does not authenticate a download. Enforce download/extraction limits, reject unsafe archive paths, and verify the packaged manifest against the expected mod and release metadata. Only save the applied key after installation succeeds.

## Development and publication

Requires Node.js 24 or newer:

```sh
npm ci --ignore-scripts
npm test
npm run check
GITHUB_TOKEN=your_token npm run update
npm run check
git diff --check
```

`npm test` uses local fixtures. `npm run check` validates sources, both generated schemas, artifact selection, and feed consistency. `npm run update` reads public GitHub metadata; `GITHUB_TOKEN` or `GH_TOKEN` is optional locally and increases the API rate limit. Upstream transport errors, incomplete collection, and snapshot validation failures preserve the previous snapshot. A missing or invalid manifest on a selected release blocks that repository's candidate. After changing `sources.json` or collection logic, regenerate and commit both feeds with the change so CI can verify consistency.

The update workflow runs tests before collection, validates the generated feeds, then commits `index.json` and `updates.json` together only when content changes. If `main` advances while collection runs, publication is skipped so a later run can rebuild from current configuration. Pushes never use force. Pull requests and pushes run the same tests and feed validation in CI.
