import test from 'node:test';
import assert from 'node:assert/strict';
import { badgePage, relatedGames, imageUrl, refreshQueue, enrichGames } from '../lib/enrichment.mjs';

test('recommendations reject sponsored, duplicate and invalid IDs', () => {
  const result = relatedGames({games:[{universeId:1},{universeId:2,name:'Game',placeId:20},{universeId:2},{universeId:3,isSponsored:true},{universeId:'1,2'}]}, '1');
  assert.deepEqual(result, [{id:'2',name:'Game',rootPlaceId:'20'}]);
});
test('badges retain missing award counts and mark paginated samples', () => {
  const result = badgePage({data:[{id:1,name:'Badge',enabled:true,statistics:{awardedCount:5}}],nextPageCursor:'next'});
  assert.equal(result.badges[0].pastDayAwardedCount, null);
  assert.equal(result.badgesHasMore, true);
});
test('image URLs accept only HTTPS Roblox CDN assets', () => {
  assert.equal(imageUrl('javascript:alert(1)'), null);
  assert.equal(imageUrl('https://rbxcdn.com.evil.example/image'), null);
  assert.equal(imageUrl('http://tr.rbxcdn.com/image'), null);
  assert.equal(imageUrl('https://tr.rbxcdn.com/image'), 'https://tr.rbxcdn.com/image');
});
test('refresh queue rotates uncollected games before expired cached games', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const cache = new Map([['1',{detailsCheckedAt:'2026-10-01T12:00:00Z'}],['3',{detailsCheckedAt:'2026-10-03T11:00:00Z'}]]);
  assert.deepEqual(refreshQueue([{id:'1'},{id:'2'},{id:'3'}],cache,now,24,2).map(game=>game.id), ['2','1']);
});
test('optional endpoint failures preserve cached values and core games', async () => {
  const cached = [{gameId:'1',payload:{iconUrl:'https://tr.rbxcdn.com/old',badges:[{id:'2'}]}}];
  const result = await enrichGames([{id:'1',name:'Game'}],cached,{enrichmentGamesPerRun:1,enrichmentBudgetSeconds:120},'2026-10-03T12:00:00Z',async()=>{throw new Error('HTTP 429');});
  assert.equal(result.games[0].name, 'Game');
  assert.equal(result.games[0].enrichment.iconUrl, cached[0].payload.iconUrl);
  assert.deepEqual(result.games[0].enrichment.badges, [{id:'2'}]);
  assert.equal(result.warnings.length,4);
});
test('out-of-order icon responses map by universe ID and pending images preserve cached values', async () => {
  const result = await enrichGames([{id:'1'},{id:'2'}],[{gameId:'1',payload:{iconUrl:'https://tr.rbxcdn.com/old'}}],{enrichmentGamesPerRun:0},'2026-10-03T12:00:00Z',async url => url.includes('/icons?') ?
    {data:[{targetId:2,state:'Completed',imageUrl:'https://tr.rbxcdn.com/new'},{targetId:1,state:'Pending',imageUrl:null}]} : {data:[]});
  assert.equal(result.games[0].enrichment.iconUrl,'https://tr.rbxcdn.com/old');
  assert.equal(result.games[1].enrichment.iconUrl,'https://tr.rbxcdn.com/new');
});
