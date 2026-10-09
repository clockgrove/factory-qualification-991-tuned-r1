import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createAppServer } from '../../server/app.mjs';

const dataURL = new URL('../../.runtime/incidents.json', import.meta.url);

// Independent filtering and per-service calculations from canonical records.
function expected(rows, options) {
  const selected = rows.filter(row => {
    const needle = (options.q ?? '').toUpperCase();
    if (!['id', 'title', 'description'].some(key => row[key].toUpperCase().includes(needle))) return false;
    for (const key of ['service', 'status', 'severity']) {
      if (options[key]?.length && !options[key].includes(row[key])) return false;
    }
    const opened = Date.parse(row.openedAt);
    return (!options.from || opened >= Date.parse(`${options.from}T00:00:00Z`)) &&
      (!options.to || opened < Date.parse(`${options.to}T00:00:00Z`) + 86400000);
  });
  const services = [...new Set(selected.map(row => row.service))].map(service => {
    const incidents = selected.filter(row => row.service === service);
    const resolved = incidents.filter(row => row.status === 'resolved');
    return {
      service, incidentCount: incidents.length,
      unresolvedCount: incidents.filter(row => ['open', 'in_progress'].includes(row.status)).length,
      highSeverityCount: incidents.filter(row => ['critical', 'high'].includes(row.severity)).length,
      averageResolutionHours: resolved.length ? resolved.reduce((sum, row) =>
        sum + (new Date(row.resolvedAt).getTime() - new Date(row.openedAt).getTime()) / 3600000, 0) / resolved.length : null,
    };
  });
  services.sort((a, b) => b.unresolvedCount - a.unresolvedCount ||
    (a.service === b.service ? 0 : [a.service, b.service].sort()[0] === a.service ? -1 : 1));
  return { total: selected.length, services };
}

function parameters(options) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params;
}

test('service overview measures through real loopback HTTP', { timeout: 20000 }, async t => {
  const before = await readFile(dataURL);
  const rows = JSON.parse(before);
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.equal(server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = path => fetch(base + path, { signal: AbortSignal.timeout(3000) });
    const check = async (options = {}) => {
      const response = await request(`/api/services-overview?${parameters(options)}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-type'), /application\/json/);
      const actual = await response.json();
      assert.deepEqual(actual, expected(rows, options));
      return actual;
    };
    await t.test('whole canonical result and mixed-status resolved-only averages', async () => {
      const actual = await check();
      assert.equal(actual.total, 2400);
      assert.equal(actual.services.length, 6);
      assert.ok(actual.services.every(entry => entry.unresolvedCount > 0 && entry.averageResolutionHours > 0));
    });
    await t.test('combined filters span pages and ignore all valid presentation parameters', async () => {
      const options = { q: 'InCiDeNt', service: ['Billing', 'Notifications'], status: ['open', 'in_progress', 'resolved'], severity: ['critical', 'high'], from: '2026-04-15', to: '2026-06-13' };
      const original = await check(options);
      assert.ok(original.total > 50);
      for (const pageSize of [25, 50]) for (const sort of ['openedAt', 'severity']) for (const direction of ['asc', 'desc']) {
        assert.deepEqual(await check({ ...options, pageSize, page: 99999, sort, direction }), original);
      }
    });
    await t.test('null averages, resolved averages and alphabetical unresolved ties', async () => {
      const unresolved = await check({ status: ['open', 'in_progress'] });
      assert.ok(unresolved.services.length > 0);
      assert.ok(unresolved.services.every(entry => entry.averageResolutionHours === null));
      const resolved = await check({ status: ['resolved'] });
      assert.ok(resolved.services.every(entry => entry.unresolvedCount === 0 && entry.averageResolutionHours > 0));
      assert.deepEqual(resolved.services.map(entry => entry.service), resolved.services.map(entry => entry.service).sort());
    });
    await t.test('literal searches, inclusive dates, duplicate facets and empty results', async () => {
      for (const q of ['inc-000001', 'BATCH PROCESSING DELAY', 'sEcOnD LiNe: <SAMPLE>', 'retry, then continue', '.*', '[']) await check({ q });
      await check({ service: ['Billing', 'Billing', 'Search'] });
      for (const day of ['2026-04-01', '2026-06-29']) {
        assert.ok((await check({ from: day, to: day })).total > 0);
      }
      await check({ from: '2026-06-13' });
      await check({ to: '2026-04-15' });
      assert.deepEqual(await check({ q: 'no such incident', page: 300 }), { total: 0, services: [] });
    });
    await t.test('validation and structured errors exactly match the incident list', async () => {
      const bad = ['from=2026-02-30', 'from=', 'to=2026-13-01', 'from=2026-06-01&to=2026-04-01', 'service=billing', 'status=closed', 'severity=urgent', 'sort=id', 'direction=down', 'q=a&q=b', 'sort=severity&sort=openedAt', 'direction=asc&direction=desc', 'page=0', 'page=-1', 'page=1.5', 'page=9007199254740992', 'page=1&page=2', 'pageSize=100', 'pageSize=25&pageSize=50', 'unknown=yes'];
      for (const params of bad) {
        const overview = await request(`/api/services-overview?${params}`);
        const list = await request(`/api/incidents?${params}`);
        assert.equal(overview.status, 400, params);
        assert.equal(overview.headers.get('cache-control'), 'no-store');
        const error = await overview.json();
        assert.equal(error.error.code, 'INVALID_QUERY');
        assert.deepEqual(error, await list.json());
      }
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    assert.equal(server.listening, false);
    assert.deepEqual(await readFile(dataURL), before);
  }
});
