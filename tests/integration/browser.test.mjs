import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {once} from 'node:events';
import {createAppServer} from '../../server/app.mjs';
import {expected, expectedOverview, rows, parseCSV, csvRows} from './oracle.js';

const alias = dirname(execFileSync('bash', ['-c', 'command -v qualification-chromium'], {encoding: 'utf8'}).trim());
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(alias, '../browsers');
await mkdir('.runtime/browser-tmp', {recursive: true});
for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = '.runtime/browser-tmp';
const {chromium} = await import('playwright');
// Poll observable DOM state; node:assert supplies assertions without another package.
function expect(locator, negate = false) {
  const poll = async (read, wanted) => {
    const deadline = Date.now() + 10000;
    let actual;
    do {
      actual = await read();
      if ((actual === wanted) !== negate) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.fail(`DOM expectation timed out: actual=${actual}, expected=${wanted}, negate=${negate}`);
  };
  return {
    get not() { return expect(locator, !negate); },
    toHaveAttribute: (key, value) => poll(() => locator.getAttribute(key), value),
    toHaveText: value => poll(() => locator.textContent(), value),
    toContainText: value => poll(async () => (await locator.textContent()).includes(value), true),
    toHaveCount: value => poll(() => locator.count(), value),
    toHaveValue: value => poll(() => locator.inputValue(), value),
    toBeVisible: () => poll(() => locator.isVisible(), true),
    toBeFocused: () => poll(() => locator.evaluate(x => x === document.activeElement), true),
    toBeChecked: () => poll(() => locator.isChecked(), true),
    toBeDisabled: () => poll(() => locator.isDisabled(), true)
  };
}
const utc = value => value ? value.replace('T', ' ').replace('.000Z', ' UTC') : 'Not resolved';
const human = value => value.replaceAll('_', ' ');

test('real Chromium: correctness, persisted views, keyboard, phone and overlapping HTTP intents', {timeout: 120000}, async t => {
  const before = await readFile('.runtime/incidents.json');
  let server, browser, context, port;
  const start = async () => {
    server = await createAppServer(); server.listen(port || 0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
  };
  const stop = async () => {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  };
  try {
    await start();
    browser = await chromium.launch({channel: 'chromium', headless: true, chromiumSandbox: true, env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      LD_LIBRARY_PATH: resolve(alias, '../host-libs/usr/lib/x86_64-linux-gnu'),
      ALSA_CONFIG_PATH: resolve(alias, '../host-libs/usr/share/alsa/alsa.conf'),
      TMPDIR: '.runtime/browser-tmp', TMP: '.runtime/browser-tmp', TEMP: '.runtime/browser-tmp'
    }});
    context = await browser.newContext({acceptDownloads: true});
    let page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    const throttle = latency => cdp.send('Network.emulateNetworkConditions', {offline: false, latency, downloadThroughput: -1, uploadThroughput: -1});
    await cdp.send('Network.enable');
    const checkOverview = async (options = {}) => {
      await expect(page.locator('#overview')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('#overview')).toHaveAttribute('data-stale', 'false');
      await expect(page.locator('#overview-selection')).toContainText('Measures represent current selections');
      const oracle = expectedOverview(options);
      assert.deepEqual(await page.locator('.service-card h3').allTextContents(), oracle.services.map(x => x.service));
      assert.deepEqual(await page.locator('.service-card dl dd').allTextContents(), oracle.services.flatMap(x => [
        String(x.incidentCount), String(x.unresolvedCount), String(x.highSeverityCount),
        x.averageResolutionHours === null ? 'Unavailable' : x.averageResolutionHours.toLocaleString(undefined, {maximumFractionDigits: 2})
      ]));
      await expect(page.locator('#overview-message')).toHaveText(oracle.total ? '' : 'No services match these selections. Change your search or clear a filter.');
    };
    const check = async (options = {}) => {
      await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('#freshness')).toHaveText('Current selections');
      const {items, summary} = expected(options);
      const size = options.pageSize || 25, n = options.page || 1;
      const address = new URL(page.url()).searchParams;
      for (const [key, fallback] of Object.entries({q: '', from: '', to: '', sort: 'openedAt', direction: 'desc', page: 1, pageSize: 25})) assert.equal(address.get(key) ?? '', String(options[key] ?? fallback), `address ${key}`);
      for (const facet of ['service', 'status', 'severity']) assert.deepEqual(address.getAll(facet), [...(options[facet] || [])].sort());
      assert.deepEqual(await page.locator('#rows button').evaluateAll(nodes => nodes.map(x => x.dataset.incident)), items.slice((n - 1) * size, n * size).map(x => x.id));
      assert.deepEqual(await page.locator('#summary strong').allTextContents(), [summary.total, summary.unresolved, summary.highSeverity].map(x => x.toLocaleString()));
      await expect(page.locator('#chart-text')).toHaveText(summary.openedByDay.length ? summary.openedByDay.map(d => `${d.date}: ${d.count} incident${d.count === 1 ? '' : 's'}`).join('; ') : 'No matching incidents were opened in this range.');
      await expect(page.locator('#page-label')).toHaveText(items.length ? `Page ${n} of ${Math.ceil(items.length / size)} · ${items.length.toLocaleString()} incidents` : '0 incidents · no pages');
    };
    const search = async q => { await page.getByLabel('Search ID, title or description').fill(q); await page.getByLabel('Search ID, title or description').press('Enter'); };
    const clear = async () => { await page.getByRole('button', {name: 'Clear search and filters', exact: true}).click(); };
    const detail = async row => {
      await expect(page.locator('#detail-content dd')).toHaveCount(11);
      assert.deepEqual(await page.locator('#detail-content dd').allTextContents(), Object.entries(row).map(([key, value]) => key.endsWith('At') ? utc(value) : key === 'tags' ? value.join(', ') : key === 'status' ? human(value) : String(value)));
    };
    await t.test('unfiltered startup and loading, complete summaries and repeated pagination', async () => {
      await throttle(600); await page.goto(`http://127.0.0.1:${port}`);
      await expect(page.locator('#result-message')).toContainText('Loading'); await check(); await throttle(0);
      await page.getByRole('button', {name: 'Next', exact: true}).click(); await check({page: 2});
      await page.getByRole('button', {name: 'Next', exact: true}).click(); await check({page: 3});
      await page.getByLabel('Rows per page').selectOption('50'); await check({pageSize: 50});
      await page.getByRole('button', {name: 'Next', exact: true}).click(); await check({pageSize: 50, page: 2});
    });
    await t.test('search, facet OR/AND, dates, all sorts, page resets and CSV', async () => {
      await page.getByLabel('Rows per page').selectOption('25');
      for (const q of ['inc-000001', 'BATCH PROCESSING DELAY', 'sEcOnD LiNe: <SAMPLE>']) { await search(q); await check({q}); }
      await search('incident');
      const options = {q: 'incident', service: ['Billing', 'Notifications'], status: ['open', 'in_progress'], severity: ['critical', 'high'], from: '2026-04-01', to: '2026-06-29'};
      for (const [facet, values] of Object.entries(options)) if (Array.isArray(values)) for (const value of values) await page.locator(`#${facet}`).getByLabel(human(value), {exact: true}).check();
      await page.getByLabel('From (inclusive)').fill(options.from); await page.getByLabel('To (inclusive)').fill(options.to); await check(options);
      assert.ok(expected(options).items.length > 50);
      for (const sort of ['openedAt', 'severity']) for (const direction of ['asc', 'desc']) {
        await page.getByLabel('Sort by').selectOption(sort); await page.getByLabel('Order', {exact: true}).selectOption(direction); await check({...options, sort, direction});
      }
      const downloadReady = page.waitForEvent('download'); await page.getByRole('button', {name: 'Download CSV'}).click(); const download = await downloadReady;
      assert.deepEqual(parseCSV(await readFile(await download.path(), 'utf8')), csvRows(expected({...options, sort: 'severity', direction: 'desc'}).items));
      await clear(); await page.getByLabel('Sort by').selectOption('openedAt'); await page.getByLabel('Order', {exact: true}).selectOption('desc');
      for (const date of ['2026-04-01', '2026-06-29', rows[0].openedAt.slice(0, 10)]) {
        await clear(); await page.getByLabel('From (inclusive)').fill(date); await page.getByLabel('To (inclusive)').fill(date); await check({from: date, to: date});
      }
    });
    await t.test('saved views survive reload, restore all choices and delete persistently', async () => {
      await clear(); await search('retry'); await page.locator('#service').getByLabel('Billing', {exact: true}).check();
      await page.getByLabel('Sort by').selectOption('severity'); await page.getByLabel('Order', {exact: true}).selectOption('asc'); await page.getByLabel('Rows per page').selectOption('50');
      const options = {q: 'retry', service: ['Billing', 'Search'], status: ['open', 'resolved'], severity: ['critical', 'high'], from: '2026-04-15', to: '2026-06-13', sort: 'severity', direction: 'asc', pageSize: 50};
      await page.locator('#service').getByLabel('Search', {exact: true}).check();
      for (const facet of ['status', 'severity']) for (const value of options[facet]) await page.locator(`#${facet}`).getByLabel(human(value), {exact: true}).check();
      await page.getByLabel('From (inclusive)').fill(options.from); await page.getByLabel('To (inclusive)').fill(options.to); await check(options);
      await page.getByLabel('Name this view').fill('Billing retry'); await page.getByRole('button', {name: 'Save current view'}).click();
      await page.reload(); await check(options); await page.getByRole('button', {name: 'Open saved view Billing retry'}).click(); await check(options);
      await expect(page.getByLabel('Search ID, title or description')).toHaveValue('retry'); await expect(page.locator('#service').getByLabel('Billing', {exact: true})).toBeChecked();
      for (const facet of ['service', 'status', 'severity']) for (const value of options[facet]) await expect(page.locator(`#${facet}`).getByLabel(human(value), {exact: true})).toBeChecked();
      for (const [label, value] of [['From (inclusive)', options.from], ['To (inclusive)', options.to], ['Sort by', options.sort], ['Order', options.direction], ['Rows per page', '50']]) await expect(page.getByLabel(label, {exact: true})).toHaveValue(value);
      await page.getByRole('button', {name: 'Delete saved view Billing retry'}).click(); await page.reload(); await check(options); await expect(page.locator('#views')).toHaveText('No saved views yet.');
    });
    await t.test('share every applied field and later page through reload, fresh tab and history', async () => {
      const options = {q: 'incident', service: ['Billing', 'Notifications'], status: ['open', 'in_progress'], severity: ['critical', 'high'], from: '2026-04-01', to: '2026-06-29', sort: 'severity', direction: 'asc', pageSize: 25, page: 2};
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options)) for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
      const address = `http://127.0.0.1:${port}/?${params}#results`;
      const controls = async () => {
        for (const [id, key] of [['search', 'q'], ['from', 'from'], ['to', 'to'], ['sort', 'sort'], ['direction', 'direction'], ['page-size', 'pageSize']]) await expect(page.locator(`#${id}`)).toHaveValue(String(options[key]));
        for (const facet of ['service', 'status', 'severity']) assert.deepEqual(await page.locator(`#${facet} input:checked`).evaluateAll(xs => xs.map(x => x.value).sort()), [...options[facet]].sort());
      };
      await page.goto(address); await check(options); await controls();
      const canonical = page.url(); assert.equal(new URL(canonical).hash, '#results');
      await page.reload(); await check(options); await controls(); assert.equal(page.url(), canonical);
      const original = page; const fresh = await context.newPage(); fresh.setDefaultTimeout(10000);
      try { page = fresh; await page.goto(canonical); await check(options); await controls(); await expect(page.locator('#detail')).not.toBeVisible(); }
      finally { page = original; await fresh.close(); }
      const historyLength = await page.evaluate(() => history.length);
      await search('incident'); await check({...options, page: 1});
      assert.equal(await page.evaluate(() => history.length), historyLength + 1);
      await search('incident'); await check({...options, page: 1});
      assert.equal(await page.evaluate(() => history.length), historyLength + 1);
      await page.locator('#search').fill('discard this draft');
      await page.evaluate(() => history.back()); await check(options); await controls(); await expect(page.locator('#search')).toBeFocused();
      await page.evaluate(() => history.forward()); await check({...options, page: 1});
      await page.goto(`http://127.0.0.1:${port}/`); await check();
    });
    await t.test('malformed links normalize before HTTP; encoded text and repeated facets retain meaning', async () => {
      const requests = [];
      const observe = request => { if (request.url().includes('/api/incidents?')) requests.push(request.url()); };
      page.on('request', observe);
      try {
        for (const [query, options] of [
          ['q=a&q=b&sort=id&direction=down&page=1e2&pageSize=5e1&from=2026-02-29&to=2026-04-31&unknown=yes', {}],
          ['from=1900-02-29&to=2026-13-01&page=9007199254740992', {}],
          ['from=2026-04-01&from=2026-04-01&to=2026-06-29&to=2026-06-29&page=-1&pageSize=100', {}],
          ['page=1.5', {}],
          ['from=2026-06-01&to=2026-04-01&page=0', {}],
          ['sort=severity&sort=severity&direction=asc&direction=asc&pageSize=50&pageSize=50&page=2&page=2', {}],
          ['from=2000-02-29&to=2000-02-29', {from: '2000-02-29', to: '2000-02-29'}],
          ['q=a%2Bb%20%26%20%25%20%23%20caf%C3%A9&service=Search&service=Billing&service=Search&service=bad&status=open&status=resolved', {q: 'a+b & % # café', service: ['Billing', 'Search'], status: ['open', 'resolved']}]
        ]) {
          await page.goto(`http://127.0.0.1:${port}/?${query}`); await check(options);
          const actual = new URL(requests.at(-1)).searchParams;
          assert.equal(actual.has('unknown'), false);
          for (const key of ['q', 'from', 'to', 'sort', 'direction', 'page', 'pageSize']) assert.ok(actual.getAll(key).length <= 1);
          assert.equal(new URL(page.url()).search, new URL(requests.at(-1)).search);
          await expect(page.locator('#search')).toHaveValue(options.q || '');
        }
        await page.goto(`http://127.0.0.1:${port}/?page=999999`); await check({page: 96});
        assert.equal(new URL(page.url()).searchParams.get('page'), '96');
      } finally { page.off('request', observe); }
      await page.goto(`http://127.0.0.1:${port}/`); await check();
    });
    await t.test('Back during pending HTTP, current failure/retry, details and obsolete export cleanup', async () => {
      await search('Uploads'); await check({q: 'Uploads'});
      await throttle(900);
      const pending = page.waitForRequest(r => r.url().includes('/api/incidents?') && new URL(r.url()).searchParams.get('q') === 'Billing');
      await search('Billing'); await pending;
      const snapshot = await page.locator('#summary').textContent();
      await stop();
      await page.evaluate(() => history.back());
      await expect(page.locator('#search')).toHaveValue('Uploads');
      assert.equal(await page.locator('#summary').textContent(), snapshot);
      await expect(page.locator('#result-message button')).toHaveText('Retry');
      await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
      await start(); await throttle(0);
      const length = await page.evaluate(() => history.length);
      await page.locator('#result-message button').click(); await check({q: 'Uploads'});
      assert.equal(await page.evaluate(() => history.length), length);
      await page.evaluate(() => history.forward()); await check({q: 'Billing'});
      await page.locator('#rows button').first().click(); await detail(expected({q: 'Billing'}).items[0]);
      await page.evaluate(() => history.back()); await expect(page.locator('#detail')).not.toBeVisible(); await check({q: 'Uploads'});
      const downloads = []; const download = value => downloads.push(value); page.on('download', download);
      try {
        await throttle(900);
        const exporting = page.waitForRequest(r => r.url().includes('/api/export.csv?'));
        await page.locator('#export').click(); await exporting;
        await page.evaluate(() => history.forward()); await check({q: 'Billing'});
        await expect(page.locator('#export-message')).toHaveText('');
        assert.equal(downloads.length, 0);
      } finally { page.off('download', download); await throttle(0); }
      const ready = page.waitForEvent('download'); await page.locator('#export').click();
      assert.deepEqual(parseCSV(await readFile(await (await ready).path(), 'utf8')), csvRows(expected({q: 'Billing'}).items));
      await clear(); await check();
    });
    await t.test('keyboard details expose all fields, focus and results return; phone controls fit', async () => {
      await search('inc-000001'); await check({q: 'inc-000001'});
      const button = page.locator('#rows button').first(); await button.focus(); await button.press('Enter'); await detail(rows[0]);
      await page.keyboard.press('Escape'); await expect(page.locator('#detail')).not.toBeVisible(); await expect(button).toBeFocused(); await check({q: 'inc-000001'});
      assert.notEqual(await button.evaluate(x => getComputedStyle(x).outlineStyle), 'none');
      await page.setViewportSize({width: 375, height: 812}); await clear(); await check();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#service').getByLabel('Search', {exact: true}).focus(); await page.keyboard.press('Space'); await check({service: ['Search']});
      await page.locator('#rows button').first().click(); await detail(expected({service: ['Search']}).items[0]); await page.getByRole('button', {name: 'Close details'}).click(); await check({service: ['Search']});
      await page.setViewportSize({width: 1280, height: 900});
    });
    await t.test('pending intent replacement, detail close/reselection, empty and genuine failure/retry', async () => {
      await clear(); await check(); await throttle(900);
      const previousSummary = await page.locator('#summary').textContent();
      const firstRequest = page.waitForRequest(r => r.url().includes('/api/incidents?') && new URL(r.url()).searchParams.get('q') === 'Billing');
      await search('Billing'); await firstRequest; await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('#results')).toHaveAttribute('data-stale', 'true');
      assert.equal(await page.locator('#summary').textContent(), previousSummary);
      await expect(page.locator('#next')).toBeDisabled();
      // Repeated keyboard activation while stale must not move pagination.
      await page.locator('#next').press('Enter'); await page.locator('#next').press('Enter');
      await search('Uploads'); await check({q: 'Uploads'});
      const snapshot = await page.locator('#rows').textContent();
      const oldDetail = page.waitForRequest(r => r.url().includes('/api/incidents/INC-'));
      await page.locator('#rows button').first().click(); await oldDetail; await expect(page.locator('#detail-content')).toContainText('Loading');
      await page.keyboard.press('Escape'); await page.locator('#rows button').nth(1).click(); await detail(expected({q: 'Uploads'}).items[1]);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#rows').textContent(), snapshot); await check({q: 'Uploads'});
      const pending = page.waitForRequest(r => r.url().includes('/api/incidents?') && new URL(r.url()).searchParams.get('q') === 'Billing');
      await search('Billing'); await pending; await stop(); await search('Search');
      await expect(page.locator('#result-message button')).toHaveText('Retry'); await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
      await expect(page.getByLabel('Search ID, title or description')).toHaveValue('Search');
      await search('Notifications'); await expect(page.locator('#result-message button')).toHaveText('Retry');
      await start(); await throttle(0); await page.locator('#result-message').getByRole('button', {name: 'Retry'}).click(); await check({q: 'Notifications'});
      // A real detail connection failure is retried for the newly selected ID.
      await stop(); await page.locator('#rows button').first().click();
      await expect(page.locator('#detail-content button')).toHaveText('Retry');
      await page.keyboard.press('Escape'); await page.locator('#rows button').nth(1).click();
      await expect(page.locator('#detail-content button')).toHaveText('Retry');
      await start(); await page.locator('#detail-content').getByRole('button', {name: 'Retry'}).click();
      await detail(expected({q: 'Notifications'}).items[1]); await page.keyboard.press('Escape'); await check({q: 'Notifications'});
      await search('nothing matches this phrase'); await check({q: 'nothing matches this phrase'}); await expect(page.locator('#result-message')).toContainText('No incidents match'); await expect(page.locator('#next')).toBeDisabled();
    });
    await t.test('overview follows whole-result selections while pagination and sorting leave measures unchanged', async () => {
      await clear(); await check(); await checkOverview();
      await search('incident'); await check({q: 'incident'}); await checkOverview({q: 'incident'});
      await page.locator('#service').getByLabel('Billing', {exact: true}).check();
      await page.locator('#service').getByLabel('Notifications', {exact: true}).check();
      const options = {q: 'incident', service: ['Billing', 'Notifications']};
      await check(options); await checkOverview(options);
      assert.ok(expected(options).items.length > 50);
      await page.locator('#next').click(); await check({...options, page: 2}); await checkOverview(options);
      await page.getByLabel('Rows per page').selectOption('50'); await check({...options, pageSize: 50}); await checkOverview(options);
      await page.locator('#next').click(); await check({...options, pageSize: 50, page: 2}); await checkOverview(options);
      await page.getByLabel('Sort by').selectOption('severity'); await check({...options, pageSize: 50, sort: 'severity'}); await checkOverview(options);
      await page.getByLabel('Order', {exact: true}).selectOption('asc'); await check({...options, pageSize: 50, sort: 'severity', direction: 'asc'}); await checkOverview(options);
      await page.goto(`http://127.0.0.1:${port}/?status=resolved`); await check({status: ['resolved']}); await checkOverview({status: ['resolved']});
      await page.goto(`http://127.0.0.1:${port}/?status=open&status=in_progress`); await check({status: ['open', 'in_progress']}); await checkOverview({status: ['open', 'in_progress']});
      await page.goto(`http://127.0.0.1:${port}/`); await check(); await checkOverview();
    });
    await t.test('overview owns overlapping selections, real connection failure and current retry', async () => {
      await clear(); await check();
      await throttle(1200);
      const settlements = new Set();
      const settled = request => { if (request.url().includes('/api/services-overview?')) settlements.add(request); };
      page.on('requestfinished', settled); page.on('requestfailed', settled);
      try {
        const olderReady = page.waitForRequest(r => r.url().includes('/api/services-overview?') && new URL(r.url()).searchParams.get('q') === 'Billing');
        await search('Billing'); const older = await olderReady;
        await expect(page.locator('#overview')).toHaveAttribute('aria-busy', 'true');
        await expect(page.locator('#overview')).toHaveAttribute('data-stale', 'true');
        await expect(page.locator('#overview-message')).toContainText('Loading service measures');
        await expect(page.locator('#overview-selection')).toContainText('Current selections: Search: Billing');
        await expect(page.locator('#overview-selection')).toContainText('Previous measures represent: No search or filters');
        // The previous request is observed while latency keeps it pending; the next intent owns the failure and retry.
        assert.equal(settlements.has(older), false);
        await stop(); await search('Uploads');
        await expect(page.locator('#overview-message button')).toHaveText('Retry');
        await expect(page.locator('#overview')).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator('#overview-selection')).toContainText('Current selections: Search: Uploads');
        const currentError = await page.locator('#overview-message').textContent();
        await page.waitForFunction(() => document.querySelector('#overview').getAttribute('aria-busy') === 'false');
        const deadline = Date.now() + 10000;
        while (!settlements.has(older) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(settlements.has(older), true, 'obsolete real overview request settled within deadline');
        assert.equal(await page.locator('#overview-message').textContent(), currentError);
        await expect(page.locator('#overview')).toHaveAttribute('aria-busy', 'false');
        await start(); await throttle(600);
        await page.locator('#overview-message button').click();
        await expect(page.locator('#overview')).toHaveAttribute('aria-busy', 'true');
        await expect(page.locator('#overview-message')).toContainText('Loading service measures');
        await checkOverview({q: 'Uploads'});
        await page.locator('#result-message button').click(); await check({q: 'Uploads'});
        await throttle(0);
        await search('nothing matches this phrase'); await check({q: 'nothing matches this phrase'});
        await checkOverview({q: 'nothing matches this phrase'});
        await expect(page.locator('#overview-message')).toBeVisible();
        await expect(page.locator('.service-card')).toHaveCount(0);
      } finally {
        page.off('requestfinished', settled); page.off('requestfailed', settled); await throttle(0);
      }
    });
    await t.test('triage order, duplicate, literal notes, persistence, unchanged results and malformed storage', async () => {
      await clear(); await search('incident'); await check({q: 'incident'});
      const selected = expected({q: 'incident'}).items.slice(0, 2);
      const ids = selected.map(x => x.id);
      const add = async row => {
        await page.locator(`#rows button[data-incident="${row.id}"]`).click(); await detail(row);
        await page.getByRole('button', {name: 'Add to personal triage', exact: true}).click();
        await expect(page.getByRole('button', {name: 'Added to personal triage', exact: true})).toBeVisible();
        await page.keyboard.press('Escape');
      };
      await add(selected[0]); await add(selected[1]); await add(selected[0]);
      assert.deepEqual(await page.locator('#triage-list button[data-triage]').evaluateAll(xs => xs.map(x => x.dataset.triage)), ids);
      const note = '<b>Investigate</b> & "retry", then continue; <script>literal</script>!';
      const noteField = page.getByLabel(`Plain-text note for ${ids[0]}`, {exact: true});
      await noteField.fill('first draft'); await noteField.fill(note);
      const address = page.url(); const resultIDs = await page.locator('#rows button').evaluateAll(xs => xs.map(x => x.dataset.incident));
      await page.reload(); await check({q: 'incident'});
      await expect(noteField).toHaveValue(note);
      assert.deepEqual(await page.locator('#triage-list button[data-triage]').evaluateAll(xs => xs.map(x => x.dataset.triage)), ids);
      assert.equal(await page.locator('#triage-list b, #triage-list script').count(), 0);
      const reopen = page.locator(`#triage-list button[data-triage="${ids[0]}"]`);
      await reopen.focus(); await reopen.press('Enter'); await detail(selected[0]);
      await page.keyboard.press('Escape'); await expect(reopen).toBeFocused();
      assert.notEqual(await reopen.evaluate(x => getComputedStyle(x).outlineStyle), 'none');
      assert.equal(page.url(), address);
      assert.deepEqual(await page.locator('#rows button').evaluateAll(xs => xs.map(x => x.dataset.incident)), resultIDs);
      const remove = page.getByRole('button', {name: `Remove ${ids[0]}`, exact: true});
      await remove.focus(); await remove.press('Enter');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('incident-explorer.triage.v1')));
      assert.deepEqual(stored.entries.map(x => x.id), [ids[1]]);
      assert.equal(JSON.stringify(stored).includes(note), false);
      await page.reload(); await check({q: 'incident'});
      await expect(page.getByLabel(`Plain-text note for ${ids[0]}`, {exact: true})).toHaveCount(0);
      await page.evaluate(() => localStorage.setItem('incident-explorer.triage.v1', '{malformed persisted triage'));
      await page.reload(); await check({q: 'incident'});
      await expect(page.locator('#triage-message')).toContainText('Stored triage is malformed');
      await expect(page.locator('#triage-list')).toContainText('No incidents in personal triage');
      await add(selected[0]);
      await expect(page.locator('#triage-list button[data-triage]')).toHaveCount(1);
      await page.getByLabel(`Plain-text note for ${ids[0]}`, {exact: true}).fill('usable after malformed storage');
      await check({q: 'incident'});
    });
    await t.test('fresh phone overview-first landing and keyboard reachability without content loss', async () => {
      const phone = await browser.newContext({viewport: {width: 375, height: 812}, isMobile: true, hasTouch: true});
      const original = page;
      try {
        page = await phone.newPage(); page.setDefaultTimeout(10000);
        await page.goto(`http://127.0.0.1:${port}/`); await check(); await checkOverview();
        assert.equal(await page.evaluate(() => localStorage.getItem('incident-explorer.triage.v1')), null);
        const tops = await page.evaluate(() => ['overview', 'results', 'triage', 'filters'].map(id => document.getElementById(id).getBoundingClientRect().top));
        assert.ok(tops.every((top, i) => i === 0 || top > tops[i - 1]), 'fresh phone puts overview before incidents, triage and controls');
        assert.ok(tops[0] < 812, 'overview begins in initial phone viewport');
        const fits = async locator => {
          await locator.scrollIntoViewIfNeeded();
          assert.equal(await locator.evaluate(x => { const r = x.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), true);
        };
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        for (const card of await page.locator('.service-card').all()) {
          await fits(card); await expect(card.locator('dt')).toHaveCount(4); await expect(card.locator('dd')).toHaveCount(4);
        }
        for (const [name, target] of [['Incidents', '#results'], ['Personal triage', '#triage'], ['Filters and saved views', '#filters'], ['Service overview', '#overview']]) {
          const link = page.getByRole('link', {name, exact: true}); await link.focus();
          assert.notEqual(await link.evaluate(x => getComputedStyle(x).outlineStyle), 'none');
          await link.press('Enter'); await expect(page.locator(target)).toBeFocused(); await fits(page.locator(target));
        }
        const status = page.locator('#status').getByLabel('open', {exact: true});
        await status.focus(); await status.press('Space'); await check({status: ['open']}); await checkOverview({status: ['open']});
        assert.equal(expectedOverview({status: ['open']}).services.every(x => x.averageResolutionHours === null), true);
        await expect(page.locator('.service-card dd').filter({hasText: 'Unavailable'})).toHaveCount(expectedOverview({status: ['open']}).services.length);
        const row = expected({status: ['open']}).items[0];
        const incident = page.locator('#rows button').first(); await incident.focus(); await incident.press('Enter'); await detail(row);
        const add = page.getByRole('button', {name: 'Add to personal triage', exact: true}); await fits(add); await add.focus(); await add.press('Enter');
        await page.keyboard.press('Escape'); await expect(incident).toBeFocused();
        const note = page.getByLabel(`Plain-text note for ${row.id}`, {exact: true}); await fits(note); await note.fill('<phone> & note');
        const reopen = page.locator('#triage-list button[data-triage]'); await fits(reopen); await reopen.focus(); await reopen.press('Enter'); await detail(row);
        await page.keyboard.press('Escape'); await expect(reopen).toBeFocused();
        const remove = page.getByRole('button', {name: `Remove ${row.id}`, exact: true}); await fits(remove); await remove.focus(); await remove.press('Enter');
        await expect(page.locator('#triage-list')).toContainText('No incidents in personal triage');
        await check({status: ['open']});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      } finally { page = original; await phone.close(); }
    });
    await t.test('native browser storage quota failure preserves usable current-visit triage and notes', async () => {
      const quotaContext = await browser.newContext();
      const original = page;
      try {
        page = await quotaContext.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${port}/`); await check(); await checkOverview();
        const quota = await page.evaluate(() => {
          const key = 'incident-explorer.integration-quota-filler';
          const value = 'x'.repeat(6 * 1024 * 1024);
          let lower = 0, upper = value.length, attempts = 0, failures = 0;
          // Real native setItem calls find the exact capacity in at most 24 attempts.
          // No storage API is replaced and no incident or saved-view metadata is changed.
          while (lower < upper && attempts < 24) {
            const size = Math.ceil((lower + upper) / 2); attempts++;
            try { localStorage.setItem(key, value.slice(0, size)); lower = size; }
            catch (error) {
              if (error.name !== 'QuotaExceededError') throw error;
              failures++; upper = size - 1;
            }
          }
          if (lower !== upper) throw new Error('Native storage capacity search exceeded its finite bound');
          localStorage.setItem(key, value.slice(0, lower));
          return {attempts, failures, characters: lower};
        });
        assert.ok(quota.failures > 0, 'real Chromium reported native QuotaExceededError');
        assert.ok(quota.characters > 0 && quota.attempts <= 24);
        const row = expected().items[0];
        await page.locator('#rows button').first().click(); await detail(row);
        await page.getByRole('button', {name: 'Add to personal triage', exact: true}).click();
        await page.keyboard.press('Escape');
        await expect(page.locator('#triage-message')).toContainText('Triage browser storage could not be updated');
        await expect(page.locator('#triage-message')).toContainText('current list and notes remain usable for this visit');
        await expect(page.locator('#triage-list button[data-triage]')).toHaveCount(1);
        const note = '<quota> & "current visit"';
        const input = page.getByLabel(`Plain-text note for ${row.id}`, {exact: true});
        await input.fill(note); await expect(input).toHaveValue(note);
        await expect(page.locator('#triage-message')).toContainText('changes may not survive a reload');
        assert.equal(await page.evaluate(() => localStorage.getItem('incident-explorer.triage.v1')), null);
        await page.locator('#triage-list button[data-triage]').click(); await detail(row);
        await page.keyboard.press('Escape'); await expect(input).toHaveValue(note); await check();
        await page.getByRole('button', {name: `Remove ${row.id}`, exact: true}).click();
        await expect(page.locator('#triage-list')).toContainText('No incidents in personal triage');
      } finally {
        try {
          if (!page.isClosed() && page !== original) await page.evaluate(() => localStorage.removeItem('incident-explorer.integration-quota-filler'));
        } finally { page = original; await quotaContext.close(); }
      }
    });
    // Native write failure is exercised above. Native storage access/read exceptions
    // remain source-reviewed and component-tested; they are not manufactured here.
    assert.deepEqual(errors, []);
  } finally {
    try { await context?.close(); } finally { try { await browser?.close(); } finally { await stop(); } }
    assert.deepEqual(await readFile('.runtime/incidents.json'), before);
  }
});
