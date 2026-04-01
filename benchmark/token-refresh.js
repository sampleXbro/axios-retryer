const { emitResult, getProfile, nowIso, printHeader } = require('./_utils');
const { runTokenRefreshScenario } = require('./plugin-scenarios');

async function main() {
  const profile = getProfile();
  printHeader('Token Refresh Benchmark', `Profile: ${profile.name}`);

  const scenario = await runTokenRefreshScenario(profile);

  console.log(`Refresh calls: ${scenario.extras.refreshCalls}`);
  console.log(`Replay amplification: ${scenario.extras.replayAmplification}x`);
  console.log(`Success rate: ${scenario.successRate}%`);

  emitResult({
    benchmark: 'token-refresh',
    title: 'Token Refresh Benchmark',
    generatedAt: nowIso(),
    profile: profile.name,
    scenario,
  });
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
