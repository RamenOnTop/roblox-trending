import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { batches, discoverGames, fetchGameStats, fetchGameVotes, normalizeUniverseId } from './lib/robloxClient.mjs';
import { buildDashboard, buildGameHistory } from './lib/trends.mjs';
import { enrichGames } from './lib/enrichment.mjs';
import { fileURLToPath } from 'node:url';
import { databaseScope, loadCollectorState, saveCollectorState, historyPlan, readHistoryPages, mergeHistory } from './lib/collectorState.mjs';

const config = JSON.parse(await readFile(new URL('../config/collection.json', import.meta.url), 'utf8'));
const supabaseUrl = process.env.supabaseUrl;
const supabaseServiceKey = process.env.supabaseServiceKey;
if (Boolean(supabaseUrl) !== Boolean(supabaseServiceKey)) throw new Error('Configure both Supabase secrets, or leave both unset for live snapshots only.');
const database = supabaseUrl ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const startedAt = new Date().toISOString();
const collectionId = crypto.randomUUID();
const statePath = fileURLToPath(new URL('../.collectorState/state.json.gz',import.meta.url));
const scope = database ? databaseScope(`${supabaseUrl}|historyDays=${config.historyDays}`) : null;
const loaded = database ? await loadCollectorState(statePath,scope) : {state:null,warning:null};
const state = loaded.state;
let enrichmentRowsDownloaded = 0;

function checked(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}. Check the freshDataset.sql setup.`);
  return result.data ?? [];
}

async function writeBatches(table, rows, conflict) {
  for (const batch of batches(rows, 100)) checked(await database.from(table).upsert(batch, { onConflict: conflict }), `Write ${table}`);
}

try {
  let cachedEnrichment = state?.enrichment ?? [];
  let enrichmentStorageReady = false;
  let enrichmentStorageWarning = null;
  if (database) {
    let query = database.from('trendEnrichment').select('gameId,payload').order('refreshedAt', {ascending:false}).limit(config.maxTrackedGames);
    if (state) query = query.gt('refreshedAt',state.generatedAt);
    const result = await query;
    if (!result.error) {
      enrichmentRowsDownloaded = result.data?.length ?? 0;
      const merged = new Map(cachedEnrichment.map(row=>[row.gameId,row]));
      for (const row of result.data ?? []) merged.set(row.gameId,row);
      cachedEnrichment = [...merged.values()];enrichmentStorageReady = true;
    }
    else enrichmentStorageWarning = `Enrichment cache unavailable (${result.error.code ?? 'unknown'}); run database/addEnrichment.sql.`;
  }
  const tracked = database ? checked(await database.from('trendGames').select('id').order('lastSeenAt', { ascending: false }).limit(config.maxTrackedGames), 'Read tracked games') : [];
  const seeds = (config.seedUniverseIds ?? []).map(normalizeUniverseId).filter(Boolean);
  let discovered = [];
  let discoveryWarning = null;
  try { discovered = await discoverGames(config.sortId); }
  catch (error) {
    discoveryWarning = error.message;
    console.warn(`Discovery unavailable; using saved and configured IDs. ${error.message}`);
  }
  const relatedIds = cachedEnrichment.flatMap(row => row.payload?.relatedGames ?? []).map(game => normalizeUniverseId(game.id)).filter(Boolean);
  const candidates = [...new Set([...seeds, ...discovered, ...tracked.map(game => game.id), ...relatedIds])];
  const ids = candidates.slice(0, config.maxTrackedGames);
  if (!ids.length) throw new Error('No universe IDs are available. Restore discovery or add seedUniverseIds to config/collection.json.');
  if (database) checked(await database.from('collectionRuns').insert({ id: collectionId, startedAt, status: 'running', requestedGames: ids.length }), 'Start collection run');
  const rawGames = await fetchGameStats(ids, config.batchSize);
  if (!rawGames.length) throw new Error('Roblox returned no game details; refusing to replace the current site with an empty dataset.');
  let votes = new Map();
  let votesWarning = null;
  try { votes = await fetchGameVotes(rawGames.map(game => String(game.id)), config.batchSize); }
  catch (error) { votesWarning = error.message; console.warn(`Votes unavailable; ratings will be unknown. ${error.message}`); }
  const generatedAt = new Date().toISOString();
  const games = [];
  const currentSamples = [];
  for (const raw of rawGames) {
    const id = normalizeUniverseId(raw.id);
    // Missing counts are missing observations, never fabricated zero-player snapshots.
    if (!id || typeof raw.playing !== 'number' || !Number.isFinite(raw.playing) || raw.playing < 0) continue;
    const vote = votes.get(id);
    const upVotes = typeof vote?.upVotes === 'number' ? vote.upVotes : null;
    const downVotes = typeof vote?.downVotes === 'number' ? vote.downVotes : null;
    games.push({ id, rootPlaceId: raw.rootPlaceId != null ? String(raw.rootPlaceId) : null,
      name: raw.name ?? 'Unknown', description: raw.description ?? '', creator: raw.creator?.name ?? 'Unknown',
      creatorId: raw.creator?.id != null ? String(raw.creator.id) : null, creatorType: raw.creator?.type ?? null,
      genreL1: raw.genre_l1?.trim() || raw.genre?.trim() || null, genreL2: raw.genre_l2?.trim() || null,
      maxPlayers: raw.maxPlayers ?? null, createdAt: raw.created ?? null, updatedAt: raw.updated ?? null, lastSeenAt: generatedAt });
    currentSamples.push({ gameId: id, capturedAt: generatedAt, activePlayers: raw.playing,
      visits: raw.visits ?? null, favorites: raw.favoritedCount ?? null, upVotes, downVotes,
      likeRatio: upVotes != null && downVotes != null && upVotes + downVotes > 0 ? upVotes / (upVotes + downVotes) : null,
      collectionId });
  }
  if (!games.length) throw new Error('No valid player-count observations were returned.');
  let history = { samples: [], truncated: false };
  let checkpoint = null;
  let historyRowsDownloaded = 0;
  let historyJsonBytesDownloaded = 0;
  if (database) {
    await writeBatches('trendGames', games, 'id');
    await writeBatches('trendSnapshots', currentSamples, 'gameId,capturedAt');
    const bucketAt = new Date(Math.floor(Date.parse(generatedAt) / 3600000) * 3600000).toISOString();
    await writeBatches('trendHourlySamples', currentSamples.map(sample => ({ ...sample, bucketAt })), 'gameId,bucketAt');
    const validIds = games.map(game=>game.id);
    const rawRows = [];const hourlyRows = [];
    for (const plan of historyPlan(state,validIds,generatedAt,config.historyDays)) {
      const part = await readHistoryPages(database,plan,{maxRows:config.maxHistoryRows-historyRowsDownloaded});
      historyRowsDownloaded += part.rows.length;historyJsonBytesDownloaded += part.jsonBytes;
      (plan.table === 'trendSnapshots' ? rawRows : hourlyRows).push(...part.rows);
    }
    checkpoint = mergeHistory(state,[...rawRows,...currentSamples],[...hourlyRows,...currentSamples.map(sample=>({...sample,bucketAt}))],validIds,generatedAt,config.historyDays);
    history.samples = [...checkpoint.rawSamples,...checkpoint.hourlySamples];
    if (history.samples.length > config.maxHistoryRows) throw new Error('Merged history exceeds the checkpoint budget.');
  }
  const enriched = await enrichGames(games, cachedEnrichment, config, generatedAt);
  if (database && enrichmentStorageReady) {
    try { await writeBatches('trendEnrichment', enriched.rows, 'gameId'); }
    catch (error) { enrichmentStorageWarning = `Enrichment cache write failed: ${error.message}`; }
  }
  const warnings = [loaded.warning,discoveryWarning, votesWarning, enrichmentStorageWarning, ...enriched.warnings].filter(Boolean);
  if (database) checked(await database.from('collectionRuns').update({ completedAt: new Date().toISOString(), status: 'complete', collectedGames: games.length, warning: warnings.join('; ').slice(0,4000) || null }).eq('id', collectionId), 'Complete collection run');
  if (warnings.length) console.warn(warnings.join('\n'));
  const meta = { generatedAt, startedAt, collectionId, historySource: database ? 'Supabase' : 'currentSnapshot',
    gamesTracked: ids.length, gamesCollected: games.length, historyRows: history.samples.length,
    historyTruncated: history.truncated, trackingCapped: candidates.length > ids.length,
    historyMode: database ? (state ? 'incremental' : 'bootstrap') : 'currentSnapshot',historyRowsDownloaded,historyJsonBytesDownloaded,enrichmentRowsDownloaded,
    discoveryWarning, votesWarning, enrichmentStorageReady, enrichmentWarnings: enriched.warnings,
    enrichmentStorageWarning, sampleScope: 'Tracked chart games, configured seeds, and cached recommendations; not all Roblox experiences.' };
  const dashboard = buildDashboard(enriched.games, [...currentSamples, ...history.samples], meta);
  const output = new URL('../public/data/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('dashboard.json', output), JSON.stringify(dashboard));
  const historyOutput = new URL('games/', output);
  await mkdir(historyOutput, {recursive:true});
  for (const [gameId, points] of buildGameHistory([...history.samples, ...currentSamples])) {
    if (normalizeUniverseId(gameId)) await writeFile(new URL(`${gameId}.json`, historyOutput),JSON.stringify({gameId,generatedAt,points}));
  }
  if (checkpoint) {
    const cached = new Map(cachedEnrichment.map(row=>[row.gameId,row]));
    for (const row of enriched.rows) cached.set(row.gameId,row);
    const validIds = new Set(games.map(game=>game.id));
    await saveCollectorState(statePath,{scope,generatedAt,gameIds:[...validIds],...checkpoint,enrichment:[...cached.values()].filter(row=>validIds.has(row.gameId))});
  }
  console.log(JSON.stringify({ collected: games.length, tracked: ids.length, historySource: meta.historySource, historyRows: history.samples.length, historyMode:meta.historyMode,historyRowsDownloaded,historyJsonBytesDownloaded,enrichmentRowsDownloaded,generatedAt }));
} catch (error) {
  if (database) await database.from('collectionRuns').update({ completedAt: new Date().toISOString(), status: 'failed', warning: error.message }).eq('id', collectionId);
  console.error(error.message);
  process.exitCode = 1;
}
