const { emitResult, getProfile, nowIso, printHeader, printScenario, round } = require('./_utils');
const {
  runCacheScenario,
  runCircuitBreakerScenario,
  runCombinedPluginScenario,
  runTokenRefreshScenario,
} = require('./plugin-scenarios');

const BENCHMARK_NAME = 'plugin-integration';

async function main() {
  const profile = getProfile();

  printHeader('Plugin Integration Benchmarks', `Profile: ${profile.name}`);

  const scenarios = [
    await runCacheScenario(profile),
    await runCircuitBreakerScenario(profile),
    await runTokenRefreshScenario(profile),
    await runCombinedPluginScenario(profile),
  ];

  scenarios.forEach(printScenario);

  const summary = {
    profile: profile.name,
    avgSuccessRate: round(scenarios.reduce((sum, scenario) => sum + scenario.successRate, 0) / scenarios.length),
    avgThroughputPerSec: round(scenarios.reduce((sum, scenario) => sum + scenario.throughputPerSec, 0) / scenarios.length),
    bestCacheHitRate: Math.max(...scenarios.map((scenario) => scenario.extras.hotReadHitRate || scenario.extras.cacheHitRateAfterWarmAuth || 0)),
    refreshCallsObserved: scenarios
      .map((scenario) => scenario.extras.refreshCalls)
      .filter((value) => typeof value === 'number'),
  };

  console.log('\nSummary');
  console.log('-------');
  console.log(`Average success rate: ${summary.avgSuccessRate}%`);
  console.log(`Average throughput: ${summary.avgThroughputPerSec} req/sec`);
  console.log(`Best observed cache hit rate: ${summary.bestCacheHitRate}%`);
  console.log(`Refresh calls observed: ${summary.refreshCallsObserved.join(', ') || 'none'}`);

  emitResult({
    benchmark: BENCHMARK_NAME,
    title: 'Plugin Integration Benchmarks',
    generatedAt: nowIso(),
    profile: profile.name,
    scenarios,
    summary,
  });
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
