import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {snapshotArchivePattern} from './historyArchive.mjs';

const execute=promisify(execFile);
export function createArchiveReader(directory){
  const repository='RamenOnTop/roblox-trending';
  const environment={...process.env};
  delete environment.supabaseUrl;delete environment.supabaseServiceKey;
  if(process.env.githubToken)environment.GH_TOKEN=process.env.githubToken;
  const ghPath=process.env.ghPath??(process.platform==='win32'?'C:\\Program Files\\GitHub CLI\\gh.exe':'gh');
  async function boundedFile(path,budget){const info=await stat(path);if(info.size>budget)throw new Error('Dashboard archive file exceeds its byte budget.');return readFile(path);}
  return async(record,name)=>{
    if(!snapshotArchivePattern.test(name)||record.archiveUrl!==`https://github.com/${repository}/releases/download/roblox-history/${name}`)throw new Error('Unexpected dashboard archive destination.');
    await mkdir(directory,{recursive:true});
    async function getFile(file,budget){
      const path=join(directory,file);
      try{return await boundedFile(path,budget);}catch(error){if(error.code!=='ENOENT')throw error;}
      const temporary=join(directory,'downloads',record.archiveDigest);
      await mkdir(temporary,{recursive:true});
      try{await execute(ghPath,['release','download','roblox-history','--repo',repository,'--pattern',file,'--dir',temporary,'--clobber'],{env:environment,timeout:90000,maxBuffer:1024*1024});}
      catch{throw new Error(`Verified history archive download unavailable for ${record.archiveDay}. Existing published history is preserved.`);}
      const bytes=await boundedFile(join(temporary,file),budget);
      await rename(join(temporary,file),path);
      return bytes;
    }
    const manifest=JSON.parse((await getFile(name+'.manifest.json',65536)).toString('utf8'));
    const bytes=await getFile(name,32*1024*1024);
    return {manifest,bytes};
  };
}
