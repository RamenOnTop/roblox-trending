const isPages = process.env.dashboardMode === "pages";
const basePath = process.env.dashboardBasePath ?? "";

export type DatasetMeta = {
  generatedAt?: string;
  historySource?: string;
  gamesCollected?: number;
  historyTruncated?: boolean;
  trackingCapped?: boolean;
};

type StaticDataset = {
  meta: DatasetMeta;
  ranges: Record<string, {
    genres: unknown[];
    series: Record<string, { time: number; value: number }[]>;
  }>;
};

let datasetRequest: Promise<StaticDataset> | undefined;
async function readJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Data request failed (${response.status}).`);
  const json = await response.json();
  if (json.error) throw new Error(json.error);
  return json;
}

function staticDataset() {
  datasetRequest ??= readJson(`${basePath}/data/dashboard.json`).catch(error => {
    datasetRequest = undefined;
    throw error;
  });
  return datasetRequest;
}

export async function loadTrendingGenres(windowHours: number) {
  if (!isPages) return readJson(`/api/genres/trending?group=both&windowHours=${windowHours}&limit=20&topK=5&minPlayers=0`);
  const dataset = await staticDataset();
  return { genres: dataset.ranges[String(windowHours)]?.genres ?? [], meta: dataset.meta };
}

export async function loadGenreSeries(key: string, windowHours: number) {
  if (!isPages) return readJson(`/api/genres/series?group=both&key=${encodeURIComponent(key)}&windowHours=${windowHours}&bucketMinutes=0`);
  const dataset = await staticDataset();
  return { points: dataset.ranges[String(windowHours)]?.series[key] ?? [] };
}

export function gameHref(id: string) {
  return isPages ? `/game/?id=${encodeURIComponent(id)}` : `/games/${id}`;
}
