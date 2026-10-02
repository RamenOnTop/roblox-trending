import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { batches, discoverGames, fetchGameStats, fetchGameVotes, normalizeUniverseId } from './lib/robloxClient.mjs';
import { buildDashboard } from './lib/trends.mjs';

const config = JSON.parse(await readFile(new URL('../config/collection.json', import.meta.url), 'utf8'));
const supabaseUrl = process.env.supabaseUrl;
const supabaseServiceKey = process.env.supabaseServiceKey;
if (Boolean(supabaseUrl) !== Boolean(supabaseServiceKey)) throw new Error('Configure both Supabase secrets, or leave both unset for live snapshots only.');
const database = supabaseUrl ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const startedAt = new Date().toISOString();
const collectionId = crypto.randomUUID();

function checked(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}. Check the freshDataset.sql setup.`);
  return result.data ?? [];
}

async function writeBatches(table, rows, conflict) {
  for (const batch of batches(rows, 100)) checked(await database.from(table).upsert(batch, { onConflict: conflict }), `Write ${table}`);
}

async function readHistory(ids, generatedAt, remainingBudget) {
  const since = new Date(Date.parse(generatedAt) - config.historyDays * 86400000).toISOString();
  const samples = [];
  let cursor = null;
  while (samples.length < remainingBudget) {
    const pageSize = Math.min(1000, remainingBudget - samples.length);
    let query = database.from('trendHourlySamples')
      .select('gameId,bucketAt,capturedAt,activePlayers,visits,favorites,likeRatio')
      .in('gameId', ids).gte('bucketAt', since)
      .order('bucketAt', { ascending: false }).order('gameId', { ascending: true }).limit(pageSize);
    if (cursor) query = query.or(`bucketAt.lt.${cursor.bucketAt},and(bucketAt.eq.${cursor.bucketAt},gameId.gt.${cursor.gameId})`);
    const rows = checked(await query, 'Read hourly history');
    if (!rows.length) break;
    samples.push(...rows);
    const next = rows.at(-1);
    if (cursor && cursor.bucketAt === next.bucketAt && cursor.gameId === next.gameId) throw new Error('History cursor did not advance.');
    cursor = next;
    if (rows.length < pageSize) break;
  }
  return { samples, truncated: samples.length >= remainingBudget };
}

try {
  const tracked = database ? checked(await database.from('trendGames').select('id').order('lastSeenAt', { ascending: false }).limit(config.maxTrackedGames), 'Read tracked games') : [];
  const seeds = (config.seedUniverseIds ?? []).map(normalizeUniverseId).filter(Boolean);
  let discovered = [];
  let discoveryWarning = null;
  try { discovered = await discoverGames(config.sortId); }
  catch (error) {
    discoveryWarning = error.message;
    console.warn(`Discovery unavailable; using saved and configured IDs. ${error.message}`);
  }
  const candidates = [...new Set([...seeds, ...discovered, ...tracked.map(game => game.id)])];
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
  if (database) {
    await writeBatches('trendGames', games, 'id');
    await writeBatches('trendSnapshots', currentSamples, 'gameId,capturedAt');
    const bucketAt = new Date(Math.floor(Date.parse(generatedAt) / 3600000) * 3600000).toISOString();
    await writeBatches('trendHourlySamples', currentSamples.map(sample => ({ ...sample, bucketAt })), 'gameId,bucketAt');
    // Request chunks keep PostgREST URLs bounded. Pagination uses both timestamp and ID.
    for (const batch of batches(games.map(game => game.id), 100)) {
      const remainingBudget = config.maxHistoryRows - history.samples.length;
      if (remainingBudget <= 0) { history.truncated = true; break; }
      const part = await readHistory(batch, generatedAt, remainingBudget);
      history.samples.push(...part.samples);
      history.truncated ||= part.truncated;
    }
    checked(await database.from('collectionRuns').update({ completedAt: generatedAt, status: 'complete', collectedGames: games.length, warning: [discoveryWarning, votesWarning].filter(Boolean).join('; ') || null }).eq('id', collectionId), 'Complete collection run');
  }
  const meta = { generatedAt, startedAt, collectionId, historySource: database ? 'Supabase' : 'currentSnapshot',
    gamesTracked: ids.length, gamesCollected: games.length, historyRows: history.samples.length,
    historyTruncated: history.truncated, trackingCapped: candidates.length > ids.length,
    discoveryWarning, votesWarning, sampleScope: 'Tracked chart games and configured seeds; not all Roblox experiences.' };
  const dashboard = buildDashboard(games, [...currentSamples, ...history.samples], meta);
  const output = new URL('../public/data/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('dashboard.json', output), JSON.stringify(dashboard));
  console.log(JSON.stringify({ collected: games.length, tracked: ids.length, historySource: meta.historySource, historyRows: history.samples.length, generatedAt }));
} catch (error) {
  if (database) await database.from('collectionRuns').update({ completedAt: new Date().toISOString(), status: 'failed', warning: error.message }).eq('id', collectionId);
  console.error(error.message);
  process.exitCode = 1;
}
