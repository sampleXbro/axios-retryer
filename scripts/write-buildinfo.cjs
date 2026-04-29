#!/usr/bin/env node
/**
 * Emits dist/.buildinfo.json with version, commit hash, and build timestamp.
 * Falls back gracefully when run outside a git repo (e.g. during npm install
 * from a tarball).
 */
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function readGitCommit() {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function main() {
  const root = path.resolve(__dirname, '..');
  const distDir = path.join(root, 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const buildInfo = {
    version: pkg.version,
    commit: readGitCommit(),
    builtAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(distDir, '.buildinfo.json'),
    JSON.stringify(buildInfo, null, 2) + '\n',
  );
  process.stdout.write(`[buildinfo] wrote dist/.buildinfo.json (${buildInfo.version} @ ${buildInfo.commit.slice(0, 7)})\n`);
}

main();
