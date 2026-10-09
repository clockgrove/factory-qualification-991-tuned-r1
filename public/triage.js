// Browser-local personal metadata. No incident or query state is changed here.
export const triageKey = 'incident-explorer.triage.v1';
const services = ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations'];
const severities = ['critical', 'high', 'medium', 'low'];
const statuses = ['open', 'in_progress', 'resolved'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validID = value => typeof value === 'string' && /^INC-[0-9]{6}$/.test(value);
function validSnapshot(value) {
  if (!hasKeys(value, ['title', 'service', 'severity', 'status', 'openedAt'])) return false;
  const time = Date.parse(value.openedAt);
  return typeof value.title === 'string' && services.includes(value.service) && severities.includes(value.severity) && statuses.includes(value.status)
    && typeof value.openedAt === 'string' && Number.isFinite(time) && new Date(time).toISOString() === value.openedAt;
}
function snapshot(detail) {
  return {title: detail.title, service: detail.service, severity: detail.severity, status: detail.status, openedAt: detail.openedAt};
}
const freezeEntries = entries => Object.freeze(entries.map(entry => Object.freeze({...entry, snapshot: Object.freeze({...entry.snapshot})})));
function decode(raw) {
  const value = JSON.parse(raw);
  if (!hasKeys(value, ['version', 'entries']) || value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Malformed triage');
  const ids = new Set();
  for (const entry of value.entries) {
    if (!hasKeys(entry, ['id', 'snapshot', 'note']) || !validID(entry.id) || !validSnapshot(entry.snapshot) || typeof entry.note !== 'string' || ids.has(entry.id)) throw new Error('Malformed triage');
    ids.add(entry.id);
  }
  return freezeEntries(value.entries);
}
export function createTriage(storage) {
  let entries = freezeEntries([]), readMessage = '', writeMessage = '';
  try {
    const raw = storage.getItem(triageKey);
    if (raw !== null) {
      try { entries = decode(raw); }
      catch { readMessage = 'Stored triage is malformed and could not be restored. A new list is usable for this visit.'; }
    }
  } catch { readMessage = 'Triage browser storage could not be read. Your list and notes remain usable for this visit; persistence is unavailable.'; }
  function publish(next) {
    entries = freezeEntries(next);
    try { storage.setItem(triageKey, JSON.stringify({version: 1, entries})); writeMessage = ''; }
    catch { writeMessage = 'Triage browser storage could not be updated. Your current list and notes remain usable for this visit; changes may not survive a reload.'; }
    return true;
  }
  return {
    get entries() { return entries; },
    get message() { return [readMessage, writeMessage].filter(Boolean).join(' '); },
    add(detail) {
      if (!isObject(detail) || !validID(detail.id) || !validSnapshot(snapshot(detail)) || entries.some(entry => entry.id === detail.id)) return false;
      return publish([...entries, {id: detail.id, snapshot: snapshot(detail), note: ''}]);
    },
    remove(id) {
      if (!entries.some(entry => entry.id === id)) return false;
      return publish(entries.filter(entry => entry.id !== id));
    },
    edit(id, note) {
      if (typeof note !== 'string' || !entries.some(entry => entry.id === id && entry.note !== note)) return false;
      return publish(entries.map(entry => entry.id === id ? {...entry, note} : entry));
    }
  };
}
