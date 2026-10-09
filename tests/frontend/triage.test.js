import test from 'node:test';
import assert from 'node:assert/strict';
import {createTriage, triageKey} from '../../public/triage.js';

const detail = (id = 'INC-000001') => ({id, title: 'Retry <sample>', service: 'Billing', severity: 'high', status: 'open', openedAt: '2026-04-01T01:00:00.000Z', description: 'Full details text', tags: ['example']});
function memory(raw = null) {
  const values = new Map(raw === null ? [] : [[triageKey, raw]]);
  return {values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
}
test('added order, deduplication and literal notes survive a reload separately from saved views', () => {
  const storage = memory(); storage.values.set('incident-explorer.views.v1', 'untouched');
  const list = createTriage(storage), first = detail(), second = detail('INC-000002');
  assert.equal(list.add(first), true); assert.equal(list.add(second), true);
  const note = '<script>alert("hello")</script> & punctuation: \' "\nNext line.';
  assert.equal(list.edit(first.id, note), true);
  const existing = list.entries;
  assert.equal(list.add({...first, title: 'Changed display'}), false);
  assert.equal(list.entries, existing);
  assert.deepEqual(list.entries.map(entry => entry.id), [first.id, second.id]);
  assert.equal(list.entries[0].note, note);
  assert.equal(list.entries[0].snapshot.title, first.title);
  assert.equal('description' in list.entries[0].snapshot, false);
  const reopened = createTriage(storage);
  assert.deepEqual(reopened.entries, list.entries);
  assert.equal(reopened.message, '');
  assert.equal(storage.values.get('incident-explorer.views.v1'), 'untouched');
  assert.equal(JSON.parse(storage.values.get(triageKey)).version, 1);
});
test('removal deletes its note; re-add goes last with a new empty note', () => {
  const storage = memory(), list = createTriage(storage);
  list.add(detail()); list.add(detail('INC-000002')); list.edit('INC-000001', 'Remember');
  assert.equal(list.remove('INC-000001'), true);
  assert.equal(list.edit('INC-000001', 'stale editor'), false);
  assert.equal(list.remove('INC-000001'), false);
  assert.equal(createTriage(storage).entries.some(entry => entry.note === 'Remember'), false);
  list.add(detail());
  assert.deepEqual(list.entries.map(entry => entry.id), ['INC-000002', 'INC-000001']);
  assert.equal(list.entries[1].note, '');
});
test('unavailable reads and failed writes preserve usable membership and literal edits', () => {
  const storage = {getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }};
  const list = createTriage(storage);
  assert.match(list.message, /could not be read/);
  assert.equal(list.add(detail()), true); assert.equal(list.edit('INC-000001', '<b>literal</b>'), true);
  assert.equal(list.entries[0].note, '<b>literal</b>'); assert.match(list.message, /could not be updated/);
  assert.equal(list.remove('INC-000001'), true); assert.equal(list.entries.length, 0);
  assert.equal(createTriage(undefined).add(detail()), true);
});
test('a later write failure retains loaded membership and a subsequent successful write persists it', () => {
  const storage = memory(), original = createTriage(storage); original.add(detail());
  const list = createTriage(storage), write = storage.setItem;
  storage.setItem = () => { throw new Error('full'); };
  list.edit('INC-000001', 'kept in memory'); list.add(detail('INC-000002'));
  assert.equal(list.entries[0].note, 'kept in memory'); assert.equal(list.entries.length, 2);
  assert.match(list.message, /may not survive a reload/);
  storage.setItem = write; list.edit('INC-000002', 'now saved');
  assert.equal(list.message, ''); assert.deepEqual(createTriage(storage).entries, list.entries);
});
test('malformed versioned shape is rejected as a whole, without disabling current-visit triage', () => {
  const valid = {id: detail().id, snapshot: {title: detail().title, service: 'Billing', severity: 'high', status: 'open', openedAt: detail().openedAt}, note: ''};
  const malformed = ['{', 'null', '[]', JSON.stringify({version: 2, entries: []}), JSON.stringify({version: 1}),
    ...[{...valid, id: 'other'}, {...valid, note: 12}, {...valid, snapshot: {...valid.snapshot, service: 'other'}},
      {...valid, snapshot: {...valid.snapshot, status: 'other'}}, {...valid, snapshot: {...valid.snapshot, severity: 'other'}},
      {...valid, snapshot: {...valid.snapshot, title: null}}, {...valid, snapshot: {...valid.snapshot, openedAt: '2026-02-30T00:00:00.000Z'}},
      {...valid, snapshot: {...valid.snapshot, extra: 'unknown'}}, {...valid, extra: true}].map(entry => JSON.stringify({version: 1, entries: [valid, entry]})),
    JSON.stringify({version: 1, entries: [valid, valid]})];
  for (const raw of malformed) {
    const list = createTriage(memory(raw));
    assert.deepEqual(list.entries, []); assert.match(list.message, /malformed/);
    assert.equal(list.add(detail('INC-000002')), true); list.edit('INC-000002', 'usable');
    assert.equal(list.entries[0].note, 'usable'); assert.match(list.message, /malformed/);
  }
});
test('invalid additions and external mutation cannot corrupt membership or notes', () => {
  const list = createTriage(memory());
  for (const value of [null, {}, {...detail(), id: 'fake'}, {...detail(), openedAt: 'invalid'}, {...detail(), status: 'unknown'}]) assert.equal(list.add(value), false);
  list.add(detail());
  assert.equal(list.edit('INC-000001', {}), false);
  assert.throws(() => list.entries.push({}));
  assert.throws(() => { list.entries[0].note = 'external'; });
  assert.throws(() => { list.entries[0].snapshot.title = 'external'; });
  assert.equal(list.entries[0].note, '');
});
