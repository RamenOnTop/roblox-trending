export const rangeHours = [24, 168, 336, 720];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) ? Math.max(0, value) : 0;
export function median(values) {
  const sorted = values.filter(finite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function previousSample(samples, nowMs, hours) {
  const target = nowMs - hours * 3600000;
  return samples.find(sample => Date.parse(sample.capturedAt) <= target) ?? samples.at(-1);
}

function compareSamples(current, previous, maxReturn = 3) {
  const hours = (Date.parse(current.capturedAt) - Date.parse(previous.capturedAt)) / 3600000;
  if (hours <= 0) return { hours: 0, pct: null, logReturn: 0, absolute: 0 };
  const nowPlayers = nonnegative(current.activePlayers);
  const thenPlayers = nonnegative(previous.activePlayers);
  const logReturn = clamp(Math.log((nowPlayers + 50) / (thenPlayers + 50)), -maxReturn, maxReturn);
  return { hours, logReturn, pct: (Math.exp(logReturn) - 1) * 100, absolute: nowPlayers - thenPlayers };
}

export function scoreGame(samples, windowHours) {
  const current = samples[0];
  if (!current) throw new Error('Cannot score a game without snapshots.');
  const nowMs = Date.parse(current.capturedAt);
  const window = compareSamples(current, previousSample(samples, nowMs, windowHours));
  const short = compareSamples(current, previousSample(samples, nowMs, 0.5), 0.7);
  const medium = compareSamples(current, previousSample(samples, nowMs, 6), 1.2);
  const day = compareSamples(current, previousSample(samples, nowMs, 24), 2);
  const elapsed = (nowMs - Date.parse(samples.at(-1).capturedAt)) / 3600000;
  // A horizon is only present when we have genuinely collected that much history.
  const hasShort = short.hours >= 0.45;
  const hasMedium = medium.hours >= 5.4;
  const hasDay = day.hours >= 21.6;
  const confidence = clamp(elapsed / windowHours, 0, 1) * (0.15 + (hasShort ? 0.25 : 0) + (hasMedium ? 0.25 : 0) + (hasDay ? 0.35 : 0));
  const quality = finite(current.likeRatio) ? 2 * (clamp(current.likeRatio, 0, 1) - 0.5) : 0;
  let momentum = 0;
  const shortReturn = short.hours > 0 ? short.logReturn / short.hours * 0.5 : 0;
  if (hasShort) momentum += 1.35 * shortReturn;
  if (hasMedium) momentum += medium.logReturn / medium.hours;
  if (hasDay) momentum += 0.65 * day.logReturn / day.hours;
  if (hasShort && hasMedium) momentum += 0.9 * clamp(shortReturn - medium.logReturn / medium.hours * 0.5, -0.7, 0.7);
  if (hasDay) {
    const past = previousSample(samples, nowMs, 24);
    if (finite(current.visits) && finite(past.visits)) momentum += 0.1 * Math.log1p(Math.max(0, (current.visits - past.visits) / day.hours));
    if (finite(current.favorites) && finite(past.favorites)) momentum += 0.18 * Math.log1p(Math.max(0, (current.favorites - past.favorites) / day.hours));
  }
  if (window.hours > 0) momentum += 0.2 * quality;
  const liquidity = clamp(Math.log1p(nonnegative(current.activePlayers)), 0, 8);
  return {
    score: window.hours > 0 ? liquidity * momentum : 0,
    confidence, activePlayersNow: nonnegative(current.activePlayers),
    medianActiveWindow: median(samples.map(sample => sample.activePlayers)) ?? 0,
    rWindowPct: window.pct, growthAbsWindow: window.absolute, windowHoursUsed: window.hours,
    r24hPct: hasDay ? day.pct : null,
  };
}

export function genreSeries(samples, windowHours, nowMs) {
  const bucketMinutes = windowHours <= 36 ? 30 : windowHours <= 192 ? 60 : windowHours <= 384 ? 120 : 360;
  const bucketSeconds = bucketMinutes * 60;
  const start = Math.floor((nowMs / 1000 - windowHours * 3600) / bucketSeconds) * bucketSeconds;
  const end = Math.floor(nowMs / 1000 / bucketSeconds) * bucketSeconds;
  const updates = new Map();
  for (const sample of samples) {
    const capturedMs = Date.parse(sample.capturedAt);
    if (!Number.isFinite(capturedMs) || !finite(sample.activePlayers)) continue;
    const bucket = Math.floor(capturedMs / 1000 / bucketSeconds) * bucketSeconds;
    const byGame = updates.get(bucket) ?? new Map();
    const previous = byGame.get(sample.gameId);
    if (!previous || capturedMs > previous.capturedMs) byGame.set(sample.gameId, { capturedMs, value: sample.activePlayers });
    updates.set(bucket, byGame);
  }
  const latest = new Map();
  const points = [];
  for (let time = start; time <= end; time += bucketSeconds) {
    for (const [id, sample] of updates.get(time) ?? []) latest.set(id, sample);
    // Never carry a game's last known count indefinitely across missing collection runs.
    const maxAgeMs = Math.max(2 * 3600000, bucketSeconds * 1000);
    const values = [...latest.values()].filter(sample => (time + bucketSeconds) * 1000 - sample.capturedMs <= maxAgeMs).map(sample => sample.value);
    const value = median(values);
    if (value != null) points.push({ time, value });
  }
  return points;
}

export function buildDashboard(games, snapshots, metadata) {
  const nowMs = Date.parse(metadata.generatedAt);
  const byGame = new Map();
  const seenSamples = new Set();
  for (const sample of snapshots) {
    if (!finite(sample.activePlayers) || !Number.isFinite(Date.parse(sample.capturedAt))) continue;
    const identity = `${sample.gameId}:${Date.parse(sample.capturedAt)}`;
    if (seenSamples.has(identity)) continue;
    seenSamples.add(identity);
    const list = byGame.get(sample.gameId) ?? [];
    list.push(sample);
    byGame.set(sample.gameId, list);
  }
  for (const list of byGame.values()) list.sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
  const ranges = {};
  for (const windowHours of rangeHours) {
    const byGenre = new Map();
    for (const game of games) {
      const samples = (byGame.get(game.id) ?? []).filter(sample => Date.parse(sample.capturedAt) >= nowMs - (windowHours + 2) * 3600000);
      if (!samples.length) continue;
      const primaryGenre = game.genreL1?.trim() || 'Unknown';
      const secondaryGenre = game.genreL2?.trim();
      const key = secondaryGenre ? `${primaryGenre} / ${secondaryGenre}` : primaryGenre;
      const group = byGenre.get(key) ?? { key, games: [], samples: [] };
      group.games.push({ ...game, ...scoreGame(samples, windowHours) });
      group.samples.push(...samples);
      byGenre.set(key, group);
    }
    const allGenres = [...byGenre.values()].map(group => {
      group.games.sort((left, right) => right.score - left.score || right.activePlayersNow - left.activePlayersNow);
      const trendScore = group.games.slice(0, 5).reduce((sum, game) => sum + Math.max(0, game.score) * (0.5 + 0.5 * game.confidence), 0);
      const medianConfidence = median(group.games.map(game => game.confidence)) ?? 0;
      const measured = group.games.filter(game => game.rWindowPct != null);
      return {
        key: group.key, gamesCount: group.games.length, trendScore,
        opportunityScore: trendScore / Math.log1p(group.games.length),
        medianActivePlayers: median(group.games.map(game => game.medianActiveWindow)) ?? 0,
        medianGrowthPct: median(measured.map(game => game.rWindowPct)),
        medianWindowHoursUsed: median(group.games.map(game => game.windowHoursUsed)) ?? 0,
        windowCoverage: group.games.filter(game => game.windowHoursUsed >= windowHours * 0.9).length / group.games.length,
        medianGrowth24hPct: median(group.games.map(game => game.r24hPct)),
        medianConfidence, confidenceBand: medianConfidence >= 0.66 ? 'High' : medianConfidence >= 0.33 ? 'Medium' : 'Low',
        leaderGrowthMedian: median(measured.filter(game => game.activePlayersNow >= 100000).map(game => game.rWindowPct)),
        breakoutGrowthMedian: median(measured.filter(game => game.activePlayersNow < 50000).map(game => game.rWindowPct)),
        breakoutsCount: measured.filter(game => game.activePlayersNow < 75000 && game.rWindowPct >= 8 && game.growthAbsWindow >= 2000).length,
        topGames: group.games.slice(0, 5).map(game => ({ id: game.id, name: game.name, creator: game.creator, iconUrl: game.enrichment?.iconUrl ?? null, activePlayersNow: game.activePlayersNow, rWindowPct: game.rWindowPct, r24hPct: game.r24hPct })),
      };
    });
    allGenres.sort((left, right) => right.trendScore - left.trendScore || right.medianActivePlayers - left.medianActivePlayers);
    const genres = allGenres.slice(0, 20);
    const series = Object.fromEntries(genres.map(genre => [genre.key, genreSeries(byGenre.get(genre.key).samples, windowHours, nowMs)]));
    ranges[windowHours] = { genres, series };
  }
  const details = games.map(game => {
    const samples = byGame.get(game.id) ?? [];
    const current = samples[0];
    const metrics = Object.fromEntries(rangeHours.map(hours => {
      const window = samples.filter(sample => Date.parse(sample.capturedAt) >= nowMs - hours * 3600000);
      const score = window.length ? scoreGame(window, hours) : null;
      const points = window.slice().reverse();
      const sparkline = points.filter((_, index) => index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / 15)) === 0)
        .map(sample => ({time:Math.floor(Date.parse(sample.capturedAt) / 1000),value:sample.activePlayers}));
      const first = points[0];
      // Display actual count growth; smoothed/clamped returns remain internal to scoring.
      const growthPct = first && window.length > 1 && first.activePlayers > 0 ? (current.activePlayers - first.activePlayers) / first.activePlayers * 100 : null;
      return [hours, {growthPct, hoursUsed:score?.windowHoursUsed ?? 0, confidence:score?.confidence ?? 0, score:score?.score ?? 0, sparkline}];
    }));
    return {...game,activePlayers:current?.activePlayers ?? null,visits:current?.visits ?? null,favorites:current?.favorites ?? null,likeRatio:current?.likeRatio ?? null,metrics};
  });
  return { schemaVersion: 3, meta: metadata, ranges, games: details };
}

export function buildGameHistory(snapshots) {
  const byGame = new Map();
  for (const sample of snapshots) {
    const time = Math.floor(Date.parse(sample.capturedAt) / 1000);
    if (!Number.isFinite(time) || !finite(sample.activePlayers)) continue;
    const points = byGame.get(sample.gameId) ?? new Map();
    points.set(time, {time,value:sample.activePlayers});
    byGame.set(sample.gameId,points);
  }
  return new Map([...byGame].map(([id,points])=>[id,[...points.values()].sort((left,right)=>left.time-right.time)]));
}
