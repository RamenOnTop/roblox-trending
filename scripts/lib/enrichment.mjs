import { batches, fetchJson, normalizeUniverseId } from './robloxClient.mjs';

export function imageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'rbxcdn.com' || url.hostname.endsWith('.rbxcdn.com')) ? url.href : null;
  } catch { return null; }
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function relatedGames(payload, sourceId) {
  if (!Array.isArray(payload.games)) throw new Error('Unrecognized recommendations response.');
  const seen = new Set([sourceId]);
  return payload.games.flatMap(raw => {
    const id = normalizeUniverseId(raw.universeId);
    if (!id || seen.has(id) || raw.isSponsored) return [];
    seen.add(id);
    return [{ id, name: String(raw.name ?? 'Unknown'), rootPlaceId: normalizeUniverseId(raw.placeId) }];
  }).slice(0, 10);
}

export function badgePage(payload) {
  if (!Array.isArray(payload.data)) throw new Error('Unrecognized badges response.');
  return { badges: payload.data.flatMap(raw => {
    const id = normalizeUniverseId(raw.id);
    return id ? [{ id, name: String(raw.displayName ?? raw.name ?? 'Badge'), description: String(raw.displayDescription ?? raw.description ?? ''),
      enabled: raw.enabled === true, awardedCount: count(raw.statistics?.awardedCount),
      pastDayAwardedCount: count(raw.statistics?.pastDayAwardedCount) }] : [];
  }).slice(0, 10), badgesHasMore: Boolean(payload.nextPageCursor) };
}

export function refreshQueue(games, cache, nowMs, refreshHours, limit) {
  return games.filter(game => {
    const checked = Date.parse(cache.get(game.id)?.detailsCheckedAt ?? '');
    return !Number.isFinite(checked) || nowMs - checked >= refreshHours * 3600000;
  }).sort((left, right) => (Date.parse(cache.get(left.id)?.detailsCheckedAt ?? '') || 0) - (Date.parse(cache.get(right.id)?.detailsCheckedAt ?? '') || 0))
    .slice(0, limit);
}

export async function enrichGames(games, cached, config, generatedAt, request = url => fetchJson(url, { attempts: 2 })) {
  const cache = new Map(cached.map(row => [row.gameId, { ...row.payload }]));
  const warnings = [];
  const changed = new Set();
  const deadline = Date.now() + (config.enrichmentBudgetSeconds ?? 120) * 1000;
  const update = (id, patch) => { cache.set(id, { ...cache.get(id), ...patch }); changed.add(id); };
  async function optional(label, task) {
    if (Date.now() >= deadline) return;
    try { await task(); } catch (error) { warnings.push(`${label}: ${error.message}`); }
  }
  for (const ids of batches(games.map(game => game.id), 50)) {
    await optional('Icons', async () => {
      const query = new URLSearchParams({universeIds:ids.join(','),size:'150x150',format:'Png',isCircular:'false'});
      const payload = await request(`https://thumbnails.roblox.com/v1/games/icons?${query}`);
      if (!Array.isArray(payload.data)) throw new Error('Unrecognized icons response.');
      for (const row of payload.data) {
        const id = normalizeUniverseId(row.targetId);
        if (ids.includes(id) && row.state === 'Completed' && imageUrl(row.imageUrl)) update(id, {iconUrl:imageUrl(row.imageUrl),iconsCheckedAt:generatedAt});
      }
    });
    await optional('Thumbnails', async () => {
      const query = new URLSearchParams({universeIds:ids.join(','),countPerUniverse:'3',size:'768x432',format:'Png',isCircular:'false'});
      const payload = await request(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?${query}`);
      if (!Array.isArray(payload.data)) throw new Error('Unrecognized thumbnails response.');
      for (const row of payload.data) {
        const id = normalizeUniverseId(row.universeId);
        if (ids.includes(id) && !row.error && Array.isArray(row.thumbnails)) {
          const completed = row.thumbnails.filter(item => item.state === 'Completed').map(item => imageUrl(item.imageUrl)).filter(Boolean).slice(0,3);
          if (completed.length || row.thumbnails.length === 0) update(id, {thumbnails:completed,thumbnailsCheckedAt:generatedAt});
        }
      }
    });
  }
  const queue = refreshQueue(games, cache, Date.parse(generatedAt), config.enrichmentRefreshHours ?? 24, config.enrichmentGamesPerRun ?? 20);
  for (const game of queue) {
    if (Date.now() >= deadline) break;
    await optional(`Badges ${game.id}`, async () => {
      const payload = await request(`https://badges.roblox.com/v1/universes/${game.id}/badges?limit=10&sortOrder=Asc`);
      update(game.id, {...badgePage(payload),badgesCheckedAt:generatedAt});
    });
    await optional(`Recommendations ${game.id}`, async () => {
      const payload = await request(`https://games.roblox.com/v1/games/recommendations/game/${game.id}?maxRows=10`);
      update(game.id, {relatedGames:relatedGames(payload, game.id),relatedCheckedAt:generatedAt});
    });
    if (game.creatorType === 'User' && normalizeUniverseId(game.creatorId)) {
      await optional(`Creator games ${game.id}`, async () => {
        const payload = await request(`https://games.roblox.com/v2/users/${game.creatorId}/games?accessFilter=Public&limit=10&sortOrder=Desc`);
        if (!Array.isArray(payload.data)) throw new Error('Unrecognized creator-games response.');
        update(game.id, {creatorGames:payload.data.filter(raw => normalizeUniverseId(raw.id) && String(raw.id) !== game.id).slice(0,10)
          .map(raw => ({id:String(raw.id),name:String(raw.name ?? 'Unknown'),rootPlaceId:normalizeUniverseId(raw.rootPlace?.id)})),creatorCheckedAt:generatedAt});
      });
    }
    update(game.id, {detailsCheckedAt:generatedAt});
  }
  if (Date.now() >= deadline) warnings.push('Enrichment time budget reached; remaining games will be refreshed in later runs.');
  return { games:games.map(game => ({...game,enrichment:cache.get(game.id) ?? {}})),
    rows:[...changed].map(gameId => ({gameId,payload:cache.get(gameId),refreshedAt:generatedAt})), warnings };
}
