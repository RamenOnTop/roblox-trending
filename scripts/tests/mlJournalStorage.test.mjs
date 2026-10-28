import test from 'node:test';
import assert from 'node:assert/strict';
import {journalPartition,catalogJournals} from '../lib/mlJournalStorage.mjs';

const name=day=>`labBatch-${day}T120000000Z-00000000-0000-4000-8000-000000000001.json.gz`;
const assets=day=>[{name:name(day)},{name:name(day)+'.manifest.json'}];
test('ML journals partition by the actual UTC issue day and retain chronological legacy replay',()=>{
  assert.equal(journalPartition('2026-10-28T21:00:00-04:00'),'roblox-ml-journal-2026-10-29');
  const entries=catalogJournals([{tag:'roblox-ml-journal-2026-10-28',assets:assets('20261028')},{tag:'roblox-ml-lab',assets:[{name:'model.joblib'},...assets('20261017')]}]);
  assert.deepEqual(entries.map(row=>row.tag),['roblox-ml-lab','roblox-ml-journal-2026-10-28']);
});
test('partial journals, duplicate placements and unrelated release destinations are rejected',()=>{
  assert.throws(()=>catalogJournals([{tag:'roblox-ml-lab',assets:[{name:name('20261017')}]}]),/manifest missing/);
  assert.throws(()=>catalogJournals([{tag:'roblox-ml-lab',assets:assets('20261017')},{tag:'roblox-ml-journal-2026-10-17',assets:assets('20261017')}]),/multiple releases/);
  assert.throws(()=>catalogJournals([{tag:'other',assets:[]}]),/Unexpected/);
});
