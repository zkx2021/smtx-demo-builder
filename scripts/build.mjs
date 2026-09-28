import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await viteBuild({ configFile: false, publicDir: false, build: { outDir: 'dist', emptyOutDir: true } });
await esbuild({ entryPoints: ['src/recorder.ts'], bundle: true, format: 'iife', target: 'chrome116', outfile: 'dist/recorder.js' });
await esbuild({ entryPoints: ['src/sw.ts'], bundle: true, format: 'esm', target: 'chrome116', outfile: 'dist/sw.js' });
await mkdir('dist', { recursive: true });
await copyFile('manifest.json', 'dist/manifest.json');
