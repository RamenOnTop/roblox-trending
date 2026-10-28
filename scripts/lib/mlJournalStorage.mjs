export const journalPattern=/^labBatch-\d{8}T\d{9}Z-[a-f0-9-]{36}\.json\.gz$/;
export const journalReleasePattern=/^roblox-ml-journal-\d{4}-\d{2}-\d{2}$/;
export function journalPartition(issuedAt){return 'roblox-ml-journal-'+new Date(issuedAt).toISOString().slice(0,10);}

export function catalogJournals(releases){
  const journals=[],seen=new Set();
  for(const release of releases){
    if(release.tag!=='roblox-ml-lab'&&!journalReleasePattern.test(release.tag))throw new Error('Unexpected ML journal release.');
    const names=new Set(release.assets.map(asset=>asset.name));
    for(const asset of release.assets.filter(asset=>journalPattern.test(asset.name))){
      if(seen.has(asset.name))throw new Error('ML journal occurs in multiple releases.');
      if(!names.has(asset.name+'.manifest.json'))throw new Error('ML journal manifest missing.');
      seen.add(asset.name);journals.push({...asset,tag:release.tag});
    }
  }
  if(journals.length>4096)throw new Error('ML journal budget exceeded; compact journals before continuing.');
  return journals.sort((a,b)=>a.name.localeCompare(b.name));
}
