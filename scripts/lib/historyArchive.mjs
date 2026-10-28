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

export const snapshotArchivePattern=/^trendSnapshots-(\d{4}-\d{2}-\d{2})-([a-f0-9]{64})\.jsonl\.gz$/;
export function readSnapshotArchive(name,bytes,manifest,now=Date.now()){
  const match=name.match(snapshotArchivePattern);
  if(!match||manifest.archiveDay!==match[1]||manifest.archiveDigest!==match[2]||!Number.isSafeInteger(manifest.rowCount)||manifest.rowCount<=0||manifest.compressedBytes!==bytes.length||typeof manifest.sourceFingerprint!=='string')throw new Error('Archive filename, size, and manifest do not agree.');
  const dayStart=Date.parse(manifest.archiveDay+'T00:00:00.000Z');
  if(!Number.isFinite(dayStart)||new Date(dayStart).toISOString().slice(0,10)!==manifest.archiveDay||dayStart>=Date.parse(new Date(now).toISOString().slice(0,10)))throw new Error('Archive must describe a completed UTC day.');
  verifyArchive(bytes,manifest);
  const lines=gunzipSync(bytes,{maxOutputLength:128*1024*1024}).toString('utf8').trimEnd().split('\n');
  lines.shift();
  const seen=new Set();
  return lines.map(line=>{
    const row=JSON.parse(line);
    const stamp=Date.parse(row.capturedAt);
    if(typeof row.gameId!=='string'||!/^[1-9]\d*$/.test(row.gameId)||!Number.isFinite(stamp)||stamp<dayStart||stamp>=dayStart+86400000||!Number.isSafeInteger(row.activePlayers)||row.activePlayers<0||typeof row.collectionId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(row.collectionId))throw new Error('Invalid archived observation.');
    // Preserve upstream anomalies (for example negative favorites) instead of rewriting history.
    for(const key of ['visits','favorites','upVotes','downVotes'])if(row[key]!=null&&!Number.isSafeInteger(row[key]))throw new Error('Invalid archived count.');
    if(row.likeRatio!=null&&(typeof row.likeRatio!=='number'||!Number.isFinite(row.likeRatio)||row.likeRatio<0||row.likeRatio>1))throw new Error('Invalid archived rating.');
    const normalized={...row,capturedAt:new Date(stamp).toISOString(),collectionId:row.collectionId.toLowerCase()};
    const identity=`${normalized.gameId}:${normalized.capturedAt}`;
    if(seen.has(identity))throw new Error('Duplicate normalized archive observation.');
    seen.add(identity);
    return normalized;
  });
}
