import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubClient } from '../scripts/update.mjs';

function client(responses, extra = {}) {
  const waits = [];
  const calls = [];
  const api = createGithubClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'Unexpected extra retry');
      return response;
    },
    sleep: async delay => waits.push(delay), ...extra,
  });
  return { api, calls, waits };
}
const ok = () => new Response('{"ok":true}');

test('GitHub retries transient failures with bounded backoff and Retry-After', async () => {
  const { api, calls, waits } = client([new TypeError('network unavailable'),
    new Response('', { status: 503, headers: { 'retry-after': '2' } }), ok()]);
  assert.deepEqual(await api('/repos/owner/mod'), { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(calls[0].options.redirect, 'error');
});

test('GitHub handles 429, rate-limit reset and HTTP-date retry headers', async () => {
  const scenarios = [
    { status: 429, headers: { 'retry-after': '1' }, wait: 1000 },
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '12' }, wait: 2000 },
    { status: 503, headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:13 GMT' }, wait: 3000 },
  ];
  for (const scenario of scenarios) {
    const { api, waits } = client([new Response('', scenario), ok()], { now: () => 10_000 });
    await api('/repos/owner/mod');
    assert.deepEqual(waits, [scenario.wait]);
  }
});

test('GitHub does not retry permanent failures or exceed long rate-limit delays', async () => {
  for (const status of [401, 403, 404, 422]) {
    const { api, calls, waits } = client([new Response('', { status })]);
    await assert.rejects(api('/repos/owner/mod'), new RegExp(`HTTP ${status}`));
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  }
  const { api, calls, waits } = client([new Response('', { status: 429, headers: { 'retry-after': '3600' } })]);
  await assert.rejects(api('/repos/owner/mod'), /retry delay exceeds/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('GitHub retry exhaustion, missing manifests, malformed JSON and origin limits', async () => {
  const exhausted = client(Array.from({ length: 3 }, () => new Response('', { status: 502 })));
  await assert.rejects(exhausted.api('/repos/owner/mod'), /HTTP 502/);
  assert.equal(exhausted.calls.length, 3);
  const missing = client([new Response('', { status: 404 })]);
  assert.equal(await missing.api('/repos/owner/mod', { allowMissing: true }), null);
  const malformed = client([new Response('{invalid')]);
  await assert.rejects(malformed.api('/repos/owner/mod'), SyntaxError);
  assert.equal(malformed.calls.length, 1);
  const external = client([]);
  await assert.rejects(external.api('https://example.com/'), /Unexpected API origin/);
  assert.equal(external.calls.length, 0);
  const large = client([new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024) } })]);
  await assert.rejects(large.api('/repos/owner/mod'), /too large/);
});
