export type Point = {time:number;value:number};
export type GameMetric = {growthPct:number|null;hoursUsed:number;confidence:number;score:number;sparkline:Point[]};
export type BreakoutSignal = {
  status:'sustained'|'spike'|'early'|'cooling'|'insufficientHistory'|'patchyHistory'|'stale'|'zeroBaseline'|'belowThreshold';
  tier:string;hoursUsed:number;observations:number;ageMinutes:number|null;maxGapMinutes:number;
  gain:number|null;growthPct:number|null;score:number;sparkline:Point[];
};
export type RelatedGame = {id:string;name:string;rootPlaceId:string|null};
export type Badge = {id:string;name:string;description:string;enabled:boolean;awardedCount:number|null;pastDayAwardedCount:number|null};
export type Game = {
  id:string;name:string;creator:string;creatorType?:string;rootPlaceId:string|null;description:string;
  genreL1:string|null;genreL2:string|null;activePlayers:number|null;visits?:number|null;favorites?:number|null;likeRatio?:number|null;
  createdAt?:string;updatedAt?:string;metrics?:Record<string,GameMetric>;breakouts?:Record<string,BreakoutSignal>;
  enrichment?:{iconUrl?:string;thumbnails?:string[];badges?:Badge[];badgesHasMore?:boolean;badgesCheckedAt?:string;
    relatedGames?:RelatedGame[];relatedCheckedAt?:string;creatorGames?:RelatedGame[];creatorCheckedAt?:string};
};
export type Genre = {key:string;gamesCount:number;medianGrowthPct:number|null;medianActivePlayers:number;opportunityScore:number;medianWindowHoursUsed:number;medianConfidence:number};
export type DatasetMeta = {generatedAt?:string;historySource?:string;gamesCollected?:number;historyTruncated?:boolean;trackingCapped?:boolean};
export type Dataset = {meta:DatasetMeta;games:Game[];ranges:Record<string,{genres:Genre[];series:Record<string,Point[]>}>};
const basePath = process.env.dashboardBasePath ?? '';
let datasetRequest:Promise<Dataset>|undefined;
async function readJson(url:string) {
  const response = await fetch(url,{cache:'no-store'});
  if (!response.ok) throw new Error('The latest collection is temporarily unavailable. Please try again.');
  return response.json();
}
export function loadDashboard(refresh=false):Promise<Dataset> {
  if(refresh)datasetRequest=undefined;
  datasetRequest ??= readJson(`${basePath}/data/dashboard.json`).catch(error=>{datasetRequest=undefined;throw error;});
  return datasetRequest;
}
export async function loadGameHistory(id:string):Promise<Point[]> {
  if (!/^[1-9]\d*$/.test(id)) return [];
  const data = await readJson(`${basePath}/data/games/${id}.json`);
  return Array.isArray(data.points) ? data.points : [];
}
export function gameHref(id:string) {return `/game/?id=${encodeURIComponent(id)}`;}
