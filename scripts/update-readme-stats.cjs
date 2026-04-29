#!/usr/bin/env node
/**
 * Updates the test-suite stat line in README.md from a Jest run.
 *
 * Usage:
 *   node scripts/update-readme-stats.cjs           # runs `pnpm test:run` and parses output
 *   node scripts/update-readme-stats.cjs --check   # fails if README would change
 *
 * Run manually before cutting a release. Not wired into pnpm install or CI by
 * default — Jest is too slow to run on every postinstall.
 */
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const README = path.resolve(__dirname, '..', 'README.md');
const STAT_LINE_RE = /(- \*\*Test suite:\*\* `)(\d+)(` suites · `)(\d+)(` tests)/;

function runJest() {
  // Jest writes the summary table to stderr by default. Merge both streams so
  // we can grep the Test Suites / Tests lines regardless of where they land.
  try {
    return execSync('pnpm --silent test:run 2>&1', {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: '/bin/sh',
    });
  } catch (error) {
    if (error.stdout || error.stderr) {
      return `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    throw error;
  }
}

function parseCounts(output) {
  const suites = output.match(/Test Suites:[^\n]*?(\d+)\s+passed[^\n]*?(\d+)\s+total/);
  const tests = output.match(/Tests:[^\n]*?(\d+)\s+passed[^\n]*?(\d+)\s+total/);
  if (!suites || !tests) {
    throw new Error('Could not parse Jest summary from output');
  }
  return { suites: Number(suites[2]), tests: Number(tests[2]) };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const output = runJest();
  const { suites, tests } = parseCounts(output);

  const readme = fs.readFileSync(README, 'utf8');
  if (!STAT_LINE_RE.test(readme)) {
    process.stderr.write('[readme-stats] Could not find stat line in README.md; aborting.\n');
    process.exit(1);
  }

  const next = readme.replace(STAT_LINE_RE, (_match, p1, _oldSuites, p3, _oldTests, p5) => {
    return `${p1}${suites}${p3}${tests}${p5}`;
  });

  if (next === readme) {
    process.stdout.write(`[readme-stats] up to date (${suites} suites, ${tests} tests)\n`);
    return;
  }

  if (checkOnly) {
    process.stderr.write(
      `[readme-stats] README.md is stale. Expected: ${suites} suites, ${tests} tests. Run: node scripts/update-readme-stats.cjs\n`,
    );
    process.exit(1);
  }

  fs.writeFileSync(README, next);
  process.stdout.write(`[readme-stats] updated README.md → ${suites} suites, ${tests} tests\n`);
}

main();
