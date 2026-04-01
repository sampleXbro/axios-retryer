const { emitResult, getProfile, nowIso, printHeader } = require('./_utils');
const { runCacheScenario } = require('./plugin-scenarios');

async function main() {
  const profile = getProfile();
  printHeader('Caching Benchmark', `Profile: ${profile.name}`);

  const scenario = await runCacheScenario(profile);

  console.log(`Hot-cache hit rate: ${scenario.extras.hotReadHitRate}%`);
  console.log(`Upstream calls: ${scenario.upstreamCalls}`);
  console.log(`Warmup upstream calls: ${scenario.extras.warmupUpstreamCalls}`);

  emitResult({
    benchmark: 'caching',
    title: 'Caching Benchmark',
    generatedAt: nowIso(),
    profile: profile.name,
    scenario,
  });
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
