// Stable two-column cursor: many games share one capture timestamp.
// Read only the fields used by this first experiment, never secrets or enrichment.
export async function readTrainingSnapshots(database,{since,until,maxRows,pageSize=1000}) {
  const rows = [];
  let cursor = null;
  while (true) {
    const limit = Math.min(pageSize,maxRows-rows.length+1);
    let query = database.from('trendSnapshots').select('gameId,capturedAt,activePlayers')
      .gte('capturedAt',since).lte('capturedAt',until)
      .order('capturedAt',{ascending:true}).order('gameId',{ascending:true}).limit(limit);
    if (cursor) query = query.or(`capturedAt.gt.${cursor.capturedAt},and(capturedAt.eq.${cursor.capturedAt},gameId.gt.${cursor.gameId})`);
    const result = await query;
    if (result.error) throw new Error(`Read training history failed (${result.error.code ?? 'unknown'}).`);
    const page = result.data ?? [];
    if (!page.length) break;
    if (rows.length+page.length>maxRows) throw new Error('Training row budget exceeded; refusing a partial export.');
    const next = page.at(-1);
    if (cursor && next.gameId === cursor.gameId && next.capturedAt === cursor.capturedAt) throw new Error('Training cursor did not advance.');
    rows.push(...page);
    cursor = next;
    if (page.length<limit) break;
  }
  return rows;
}
