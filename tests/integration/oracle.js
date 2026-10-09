import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
export const rows = JSON.parse(await readFile(new URL('../../.runtime/incidents.json', import.meta.url), 'utf8'));
export const fields = Object.keys(rows[0]);
export function expected(options = {}) {
  const ranks = {critical: 4, high: 3, medium: 2, low: 1};
  const items = rows.filter(row => {
    if (options.q && !['id', 'title', 'description'].some(key => row[key].toUpperCase().includes(options.q.toUpperCase()))) return false;
    for (const key of ['service', 'status', 'severity']) if (options[key]?.length && !options[key].includes(row[key])) return false;
    const day = Date.parse(row.openedAt.slice(0, 10));
    return (!options.from || day >= Date.parse(options.from)) && (!options.to || day <= Date.parse(options.to));
  });
  items.sort((a, b) => {
    const primary = options.sort === 'severity' ? ranks[a.severity] - ranks[b.severity] : Date.parse(a.openedAt) - Date.parse(b.openedAt);
    return primary * (options.direction === 'asc' ? 1 : -1) || (options.sort === 'severity' ? Date.parse(b.openedAt) - Date.parse(a.openedAt) : 0) || a.id.localeCompare(b.id);
  });
  const counts = new Map();
  for (const row of items) { const day = row.openedAt.slice(0, 10); counts.set(day, (counts.get(day) || 0) + 1); }
  return {items, summary: {total: items.length, unresolved: items.filter(x => x.status !== 'resolved').length, highSeverity: items.filter(x => ranks[x.severity] >= 3).length, openedByDay: [...counts].sort().map(([date, count]) => ({date, count}))}};
}
export const csvRows = items => [fields, ...items.map(row => fields.map(key => row[key] === null ? '' : Array.isArray(row[key]) ? JSON.stringify(row[key]) : String(row[key])))];
// Calculate each measure directly from canonical matches, independently of server reducers.
export function expectedOverview(options = {}) {
  const selected = new Set(expected(options).items.map(row => row.id));
  const items = rows.filter(row => selected.has(row.id));
  const services = [...new Set(items.map(row => row.service))].map(service => {
    const matches = items.filter(row => row.service === service);
    const resolved = matches.filter(row => row.status === 'resolved');
    return {
      service, incidentCount: matches.length,
      unresolvedCount: matches.filter(row => row.status === 'open' || row.status === 'in_progress').length,
      highSeverityCount: matches.filter(row => row.severity === 'critical' || row.severity === 'high').length,
      averageResolutionHours: resolved.length ? resolved.reduce((sum, row) =>
        sum + (Date.parse(row.resolvedAt) - Date.parse(row.openedAt)) / 3600000, 0) / resolved.length : null,
    };
  });
  services.sort((a, b) => b.unresolvedCount - a.unresolvedCount ||
    (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
  return {total: items.length, services};
}
export function parseCSV(text) {
  const result = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\r')) {
      row.push(cell); cell = '';
      if (c === '\r') { assert.equal(text[++i], '\n'); result.push(row); row = []; }
    } else { if (!quoted) assert.notEqual(c, '\n'); cell += c; }
  }
  assert.equal(quoted, false); assert.equal(cell, ''); assert.deepEqual(row, []);
  return result;
}
