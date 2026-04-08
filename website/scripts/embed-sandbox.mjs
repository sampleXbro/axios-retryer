#!/usr/bin/env node
/**
 * Builds the Vite sandbox with the same URL prefix as the Astro site, then
 * copies the output to `website/public/sandbox/` for static hosting.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_BASE } from '../site-base.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const websiteDir = join(__dirname, '..');
const repoRoot = join(websiteDir, '..');
const sandboxDir = join(repoRoot, 'sandbox');
/** Not `public/sandbox/` — that path is reserved for Astro `sandbox.astro` (`/sandbox/index.html`). */
const outDir = join(websiteDir, 'public', 'playground');

const rootBase = SITE_BASE.endsWith('/') ? SITE_BASE : `${SITE_BASE}/`;
const sandboxViteBase = `${rootBase}playground/`;

function run(cmd, args, cwd, env = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!process.env.SANDBOX_SKIP_LIB_BUILD) {
  run('npm', ['run', 'build'], repoRoot);
}

run('npm', ['ci'], sandboxDir);

run('npm', ['run', 'build'], sandboxDir, { SANDBOX_VITE_BASE: sandboxViteBase });

mkdirSync(join(websiteDir, 'public'), { recursive: true });
rmSync(outDir, { recursive: true, force: true });
cpSync(join(sandboxDir, 'dist'), outDir, { recursive: true });
