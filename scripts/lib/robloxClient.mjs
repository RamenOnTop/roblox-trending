const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function fetchJson(url, { fetcher = fetch, sleep = pause, attempts = 4 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetcher(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'RobloxTrends/1.0' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (attempt === attempts - 1) throw new Error(`Request failed for ${new URL(url).hostname}: ${error.message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) return response.json();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}${new URL(url).pathname}`);
    }
    const retryAfter = response.headers.get('retry-after');
    const seconds = Number(retryAfter);
    const retryMs = retryAfter == null ? 0 : Number.isFinite(seconds)
      ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    // Stop rather than retry sooner than a long server-requested cooldown.
    if (retryMs > 60000) throw new Error(`Rate limited by ${new URL(url).hostname}; retry after ${retryAfter}.`);
    const delay = Math.max(1000 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0);
    await response.body?.cancel();
    await sleep(delay + Math.floor(Math.random() * 250));
  }
  throw new Error('Request attempts exhausted');
}

export function batches(items, size = 50) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function normalizeUniverseId(value) {
  const id = String(value ?? '');
  return /^[1-9]\d*$/.test(id) ? id : null;
}

// Discovery is isolated because Explore is not documented in Creator Hub's public reference.
export async function discoverGames(sortId, request = fetchJson) {
  const url = new URL('https://apis.roblox.com/explore-api/v1/get-sort-content');
  url.searchParams.set('sessionId', crypto.randomUUID());
  url.searchParams.set('sortId', sortId);
  const payload = await request(url.href);
  const items = payload.games ?? payload.content ?? payload.data;
  if (!Array.isArray(items)) throw new Error('Roblox discovery response has an unrecognized shape.');
  return [...new Set(items.map(item => normalizeUniverseId(item.universeId)).filter(Boolean))];
}

export async function fetchGameStats(ids, batchSize = 50, request = fetchJson) {
  const games = [];
  for (const batch of batches(ids, batchSize)) {
    const query = new URLSearchParams({ universeIds: batch.join(',') });
    const payload = await request(`https://games.roblox.com/v1/games?${query}`);
    if (!Array.isArray(payload.data)) throw new Error('Roblox game stats response has an unrecognized shape.');
    games.push(...payload.data);
  }
  return games;
}

export async function fetchGameVotes(ids, batchSize = 50, request = fetchJson) {
  const votes = new Map();
  for (const batch of batches(ids, batchSize)) {
    const query = new URLSearchParams({ universeIds: batch.join(',') });
    const payload = await request(`https://games.roblox.com/v1/games/votes?${query}`);
    if (!Array.isArray(payload.data)) throw new Error('Roblox votes response has an unrecognized shape.');
    for (const item of payload.data) {
      const id = normalizeUniverseId(item.id);
      if (id) votes.set(id, item);
    }
  }
  return votes;
}
