import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const archiveDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export function makeArchive(day, rows, sourceFingerprint) {
  const identities = new Set();
  const sorted = rows.slice().sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt)||a.gameId.localeCompare(b.gameId));
  for (const row of sorted) {
    const key = `${row.gameId}:${row.capturedAt}`;
    if (!/^[1-9]\d*$/.test(row.gameId) || !row.capturedAt.startsWith(day+'T') || identities.has(key)) throw new Error('Invalid or duplicate archive observation.');
    identities.add(key);
  }
  const header = {kind:'archiveHeader',schemaVersion:1,table:'trendSnapshots',archiveDay:day,rowCount:rows.length,sourceFingerprint};
  const bytes = gzipSync([JSON.stringify(header),...sorted.map(row=>JSON.stringify(row))].join('\n')+'\n');
  return {bytes,manifest:{...header,archiveDigest:archiveDigest(bytes),compressedBytes:bytes.length},name:`trendSnapshots-${day}-${archiveDigest(bytes)}.jsonl.gz`};
}

export function verifyArchive(bytes, manifest) {
  if (archiveDigest(bytes) !== manifest.archiveDigest) throw new Error('Archive SHA-256 verification failed.');
  const lines = gunzipSync(bytes,{maxOutputLength:128*1024*1024}).toString('utf8').trimEnd().split('\n');
  const header = JSON.parse(lines.shift());
  if (header.schemaVersion !== 1 || header.table !== 'trendSnapshots' || header.archiveDay !== manifest.archiveDay || header.sourceFingerprint !== manifest.sourceFingerprint || header.rowCount !== manifest.rowCount || lines.length !== manifest.rowCount) throw new Error('Archive manifest verification failed.');
  const identities = new Set();
  for (const line of lines) {
    const row = JSON.parse(line);
    const key = `${row.gameId}:${row.capturedAt}`;
    if (!row.capturedAt.startsWith(manifest.archiveDay+'T') || identities.has(key)) throw new Error('Archive observations do not match the manifest.');
    identities.add(key);
  }
  return header;
}

// Deletion is deliberately downstream of upload AND a download verified byte-for-byte.
export async function archiveAndVerify(day, rows, inspection, store, finalize) {
  if (rows.length !== Number(inspection.rowCount) || !rows.length) throw new Error('Archive source row count changed.');
  const archive = makeArchive(day,rows,inspection.sourceFingerprint);
  await store.upload(archive.name,archive.bytes);
  await store.upload(archive.name+'.manifest.json',Buffer.from(JSON.stringify(archive.manifest)));
  const downloaded = await store.download(archive.name);
  const manifest = JSON.parse(await store.download(archive.name+'.manifest.json'));
  verifyArchive(downloaded,manifest);
  if (manifest.archiveDigest !== archive.manifest.archiveDigest || manifest.sourceFingerprint !== inspection.sourceFingerprint || manifest.rowCount !== rows.length) throw new Error('Downloaded manifest differs from the source.');
  return finalize(manifest,store.url(archive.name));
}
