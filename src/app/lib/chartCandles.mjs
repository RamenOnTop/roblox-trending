// Candle extrema describe collected snapshots, not unseen activity between requests.
export function candleInterval(hours) {
  return hours <= 24 ? 3600 : hours <= 168 ? 14400 : hours <= 336 ? 43200 : 86400;
}

export function buildCandles(points, intervalSeconds) {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new Error('A positive candle interval is required.');
  const observations = new Map();
  for (const point of points) {
    if (Number.isFinite(point.time) && point.time >= 0 && Number.isFinite(point.value) && point.value >= 0) observations.set(Math.floor(point.time), point.value);
  }
  const buckets = new Map();
  for (const [time, value] of [...observations].sort((a, b) => a[0] - b[0])) {
    const bucket = Math.floor(time / intervalSeconds) * intervalSeconds;
    const candle = buckets.get(bucket);
    if (candle) {
      candle.high = Math.max(candle.high, value);
      candle.low = Math.min(candle.low, value);
      candle.close = value;
      candle.samples += 1;
    } else buckets.set(bucket, {time:bucket, open:value, high:value, low:value, close:value, samples:1});
  }
  return [...buckets.values()];
}
