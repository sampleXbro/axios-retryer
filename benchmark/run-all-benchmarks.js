const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { performance } = require('perf_hooks');

const { PROFILE_SETTINGS, RESULT_PREFIX, getProfile, parseArgs, round } = require('./_utils');

const BENCHMARKS = [
  {
    name: 'Core RetryManager',
    file: 'local-mock-server.js',
    timeoutByProfile: {
      quick: 120000,
      standard: 180000,
      full: 300000,
    },
  },
  {
    name: 'Stress',
    file: 'stress-testing.js',
    timeoutByProfile: {
      quick: 120000,
      standard: 240000,
      full: 420000,
    },
  },
  {
    name: 'Plugin Integration',
    file: 'plugin-integration.js',
    timeoutByProfile: {
      quick: 120000,
      standard: 180000,
      full: 300000,
    },
  },
  {
    name: 'Priority Queue',
    file: 'priority-queue.js',
    timeoutByProfile: {
      quick: 60000,
      standard: 90000,
      full: 150000,
    },
  },
  {
    name: 'Caching',
    file: 'caching.js',
    timeoutByProfile: {
      quick: 60000,
      standard: 90000,
      full: 150000,
    },
  },
  {
    name: 'Circuit Breaker',
    file: 'circuit-braker.js',
    timeoutByProfile: {
      quick: 60000,
      standard: 90000,
      full: 150000,
    },
  },
  {
    name: 'Token Refresh',
    file: 'token-refresh.js',
    timeoutByProfile: {
      quick: 60000,
      standard: 90000,
      full: 150000,
    },
  },
];

function resolveBenchmarks(profileName, args) {
  if (!args.include) {
    return BENCHMARKS;
  }

  const requested = String(args.include)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return BENCHMARKS.filter((benchmark) => requested.includes(benchmark.file) || requested.includes(benchmark.name));
}

function collectStructuredResult(stdout) {
  const line = stdout
    .split('\n')
    .reverse()
    .find((entry) => entry.startsWith(RESULT_PREFIX));

  if (!line) {
    return null;
  }

  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

async function runBenchmark(benchmark, profileName) {
  const timeoutMs = benchmark.timeoutByProfile[profileName] || benchmark.timeoutByProfile.standard;
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const child = spawn('node', ['--expose-gc', benchmark.file, `--profile=${profileName}`], {
      cwd: __dirname,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BENCHMARK_PROFILE: profileName,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    const timeoutId = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        name: benchmark.name,
        file: benchmark.file,
        success: false,
        durationMs: performance.now() - startedAt,
        error: `Timed out after ${timeoutMs}ms`,
        stdout,
        stderr,
        result: null,
      });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      const result = collectStructuredResult(stdout);

      resolve({
        name: benchmark.name,
        file: benchmark.file,
        success: code === 0 && Boolean(result),
        durationMs: performance.now() - startedAt,
        error: code === 0 ? (result ? null : 'Benchmark did not emit structured output') : `Exit code ${code}`,
        stdout,
        stderr,
        result,
      });
    });
  });
}

function summarizeRollup(executions) {
  const successful = executions.filter((execution) => execution.success && execution.result);
  const failed = executions.filter((execution) => !execution.success);
  const scenarioSummaries = successful.flatMap((execution) => {
    if (Array.isArray(execution.result.scenarios)) {
      return execution.result.scenarios;
    }

    if (execution.result.scenario) {
      return [execution.result.scenario];
    }

    return [];
  });

  return {
    benchmarkCount: executions.length,
    successfulCount: successful.length,
    failedCount: failed.length,
    avgDurationMs: successful.length ? round(successful.reduce((sum, execution) => sum + execution.durationMs, 0) / successful.length) : 0,
    avgScenarioSuccessRate: scenarioSummaries.length
      ? round(scenarioSummaries.reduce((sum, scenario) => sum + scenario.successRate, 0) / scenarioSummaries.length)
      : 0,
    peakThroughputPerSec: scenarioSummaries.length
      ? Math.max(...scenarioSummaries.map((scenario) => scenario.throughputPerSec || 0))
      : 0,
    slowestP95Ms: scenarioSummaries.length
      ? Math.max(...scenarioSummaries.map((scenario) => (scenario.latencyMs ? scenario.latencyMs.p95Ms : 0)))
      : 0,
    failures: failed.map((execution) => ({
      name: execution.name,
      error: execution.error,
    })),
  };
}

async function writeReport(profileName, executions, rollup) {
  const report = {
    generatedAt: new Date().toISOString(),
    profile: profileName,
    executions: executions.map((execution) => ({
      name: execution.name,
      file: execution.file,
      success: execution.success,
      durationMs: round(execution.durationMs),
      error: execution.error,
      result: execution.result,
    })),
    rollup,
  };

  const outputPath = path.join(__dirname, 'latest-benchmark-report.json');
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  return outputPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = getProfile(process.argv.slice(2));
  const benchmarks = resolveBenchmarks(profile.name, args);

  console.log(`Running ${benchmarks.length} benchmark(s) with profile "${profile.name}"`);

  const executions = [];
  for (const benchmark of benchmarks) {
    console.log(`\n>>> ${benchmark.name}`);
    executions.push(await runBenchmark(benchmark, profile.name));
  }

  const rollup = summarizeRollup(executions);
  const reportPath = await writeReport(profile.name, executions, rollup);

  console.log('\nRollup');
  console.log('------');
  console.log(`Successful benchmarks: ${rollup.successfulCount}/${rollup.benchmarkCount}`);
  console.log(`Average benchmark duration: ${rollup.avgDurationMs}ms`);
  console.log(`Average scenario success rate: ${rollup.avgScenarioSuccessRate}%`);
  console.log(`Peak throughput observed: ${rollup.peakThroughputPerSec} req/sec`);
  console.log(`Slowest p95 latency: ${rollup.slowestP95Ms}ms`);
  console.log(`Report written to: ${reportPath}`);

  if (rollup.failedCount > 0) {
    rollup.failures.forEach((failure) => {
      console.log(`Failure: ${failure.name} -> ${failure.error}`);
    });
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Benchmark runner failed:', error);
  process.exit(1);
});
