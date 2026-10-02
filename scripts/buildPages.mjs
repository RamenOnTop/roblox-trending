import { cp, mkdir, readFile, writeFile, rm, lstat, readdir, chmod, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = resolve(root, '.pagesBuild');
if (stage !== join(root, '.pagesBuild')) throw new Error('Invalid Pages staging path.');
const previous = await lstat(stage).catch(() => null);
if (previous?.isSymbolicLink()) throw new Error('Refusing to replace a linked Pages staging folder.');
async function prepareGeneratedDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) { await unlink(path); continue; }
    if (entry.isDirectory()) await prepareGeneratedDirectory(path);
    else await chmod(path, 0o666);
  }
  await chmod(directory, 0o777);
}
// OneDrive can mark copied directories read-only on Windows. Only touch the checked staging path.
if (previous && process.platform === 'win32') await prepareGeneratedDirectory(stage);
await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
await mkdir(stage, { recursive: true });
const excluded = [resolve(root, 'src/app/api'), resolve(root, 'src/app/games'), resolve(root, 'src/app/lib/supabaseServer.ts')];
await cp(join(root, 'src'), join(stage, 'src'), { recursive: true, filter: path => !excluded.some(item => path === item || path.startsWith(item + '/')) });
await cp(join(root, 'public'), join(stage, 'public'), { recursive: true });
for (const file of ['package.json', 'tsconfig.json', 'postcss.config.mjs', 'next-env.d.ts']) {
  await cp(join(root, file), join(stage, file));
}
await mkdir(join(stage, 'src/app/game'), { recursive: true });
await cp(join(root, 'scripts/pagesGame.tsx'), join(stage, 'src/app/game/page.tsx'));
const basePath = process.env.pagesBasePath ?? '';
if (basePath && !/^\/[A-Za-z0-9.-]+$/.test(basePath)) throw new Error('Invalid Pages base path.');
await writeFile(join(stage, 'next.config.mjs'), `export default ${JSON.stringify({
  output: 'export', trailingSlash: true, basePath, reactCompiler: true,
  images: { unoptimized: true }, env: { dashboardMode: 'pages', dashboardBasePath: basePath },
})};\n`);
// Check builds can render an honest empty state without Roblox requests or database secrets.
try { await readFile(join(stage, 'public/data/dashboard.json')); }
catch {
  await mkdir(join(stage, 'public/data'), { recursive: true });
  await writeFile(join(stage, 'public/data/dashboard.json'), JSON.stringify({ meta: {}, ranges: {}, games: [] }));
}
const result = spawnSync(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
  cwd: stage, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
if (result.status !== 0) process.exit(result.status ?? 1);
await writeFile(join(stage, 'out/.nojekyll'), '');
console.log(`Pages export ready: ${join(stage, 'out')}`);
