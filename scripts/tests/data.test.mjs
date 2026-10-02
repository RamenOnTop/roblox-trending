import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, discoverGames, fetchGameStats, fetchGameVotes, normalizeUniverseId } from '../lib/robloxClient.mjs';
import { buildDashboard, genreSeries, scoreGame } from '../lib/trends.mjs';

const sample = (gameId, capturedAt, activePlayers) => ({ gameId, capturedAt, activePlayers, visits: 10000, favorites: 100, likeRatio: null });

test('a fresh snapshot does not fabricate growth or model confidence', () => {
  const result = scoreGame([sample('1', '2026-10-02T12:00:00Z', 200)], 168);
  assert.equal(result.rWindowPct, null);
  assert.equal(result.r24hPct, null);
  assert.equal(result.confidence, 0);
  assert.equal(result.score, 0);
});

test('equivalent timestamps do not inflate historical observations', () => {
  const dataset = buildDashboard([{ id: '1', name: 'Game', creator: 'Creator', genreL1: 'RPG' }], [
    sample('1', '2026-10-02T12:00:00Z', 200), sample('1', '2026-10-02T12:00:00.000Z', 200),
  ], { generatedAt: '2026-10-02T12:00:00Z' });
  assert.equal(dataset.ranges[168].genres[0].medianGrowthPct, null);
  assert.equal(dataset.ranges[168].genres[0].windowCoverage, 0);
});

test('short history is reported as partial coverage, not seven days', () => {
  const dataset = buildDashboard([{ id: '1', name: 'Game', creator: 'Creator', genreL1: 'RPG' }], [
    sample('1', '2026-10-02T12:00:00Z', 500), sample('1', '2026-10-02T06:00:00Z', 100),
  ], { generatedAt: '2026-10-02T12:00:00Z' });
  const genre = dataset.ranges[168].genres[0];
  assert.equal(genre.medianWindowHoursUsed, 6);
  assert.equal(genre.windowCoverage, 0);
  assert.equal(genre.medianGrowth24hPct, null);
  assert.ok(genre.medianGrowthPct > 0);
});

test('charts stop carrying stale player counts through collection gaps', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const points = genreSeries([sample('1', '2026-10-02T06:00:00Z', 100)], 24, now);
  assert.ok(points.length > 0);
  assert.ok(points.at(-1).time < now / 1000 - 2 * 3600);
});

test('one day of history cannot imply high confidence for a thirty-day window', () => {
  const observations = [sample('1', '2026-10-02T12:00:00Z', 200), sample('1', '2026-10-01T12:00:00Z', 100)];
  assert.ok(scoreGame(observations, 720).confidence < 0.1);
});

test('missing player counts are not charted as zero', () => {
  const points = genreSeries([sample('1', '2026-10-02T12:00:00Z', null)], 24, Date.parse('2026-10-02T12:00:00Z'));
  assert.deepEqual(points, []);
});

test('empty genre labels become Unknown instead of an unselectable blank category', () => {
  const dataset = buildDashboard([{ id: '1', name: 'Game', creator: 'Creator', genreL1: '' }], [sample('1', '2026-10-02T12:00:00Z', 200)], { generatedAt: '2026-10-02T12:00:00Z' });
  assert.equal(dataset.ranges[24].genres[0].key, 'Unknown');
});

test('429 responses honor Retry-After before a bounded retry', async () => {
  let calls = 0;
  const delays = [];
  const result = await fetchJson('https://games.roblox.com/v1/games', {
    fetcher: async () => ++calls === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '3' } }) : Response.json({ data: [] }),
    sleep: async delay => delays.push(delay),
  });
  assert.equal(calls, 2);
  assert.ok(delays[0] >= 3000);
  assert.deepEqual(result, { data: [] });
});

test('non-retryable errors fail immediately', async () => {
  let calls = 0;
  await assert.rejects(fetchJson('https://games.roblox.com/v1/games', {
    fetcher: async () => { calls++; return new Response('{}', { status: 400 }); },
    sleep: async () => assert.fail('Should not sleep'),
  }), /HTTP 400/);
  assert.equal(calls, 1);
});

test('repeated rate limits wait longer and stop after bounded attempts', async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(fetchJson('https://games.roblox.com/v1/games', {
    fetcher: async () => { calls++; return new Response('{}', {status:429}); },
    sleep: async delay => delays.push(delay),
  }), /HTTP 429/);
  assert.equal(calls,4);
  assert.equal(delays.length,3);
  for (let index=0;index<delays.length;index++) assert.ok(delays[index]>=10000*2**index);
});

test('long server cooldowns stop collection instead of retrying early', async () => {
  let calls = 0;
  await assert.rejects(fetchJson('https://games.roblox.com/v1/games', {
    fetcher: async () => { calls++; return new Response('{}', {status:429,headers:{'Retry-After':'120'}}); },
    sleep: async () => assert.fail('Must not retry before the server cooldown'),
  }), /retry after 120/);
  assert.equal(calls,1);
});

test('discovery validates its shape and deduplicates universe IDs', async () => {
  assert.deepEqual(await discoverGames('top-playing-now', async () => ({ games: [{ universeId: 1 }, { universeId: 1 }, { universeId: null }] })), ['1']);
  await assert.rejects(discoverGames('top-playing-now', async () => ({ unexpected: [] })), /unrecognized shape/);
  assert.equal(normalizeUniverseId('1,2'), null);
});

test('game requests use bounded batches of universe IDs', async () => {
  const queries = [];
  const delays = [];
  await fetchGameStats(['1', '2', '3'], 2, async url => { queries.push(new URL(url).searchParams.get('universeIds')); return { data: [] }; }, async delay => delays.push(delay));
  assert.deepEqual(queries, ['1,2', '3']);
  assert.deepEqual(delays,[1000]);
  const voteQueries = [];
  await fetchGameVotes(['1','2','3'],2,async url => { voteQueries.push(new URL(url).searchParams.get('universeIds')); return {data:[]}; },async delay=>delays.push(delay));
  assert.deepEqual(voteQueries,['1,2','3']);
  assert.deepEqual(delays,[1000,1000]);
});
