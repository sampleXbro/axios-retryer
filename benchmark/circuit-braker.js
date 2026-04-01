const { emitResult, getProfile, nowIso, printHeader } = require('./_utils');
const { runCircuitBreakerScenario } = require('./plugin-scenarios');

async function main() {
  const profile = getProfile();
  printHeader('Circuit Breaker Benchmark', `Profile: ${profile.name}`);

  const scenario = await runCircuitBreakerScenario(profile);

  console.log(`Blocked by circuit: ${scenario.extras.blockedByCircuit}`);
  console.log(`Upstream calls avoided: ${scenario.extras.upstreamCallsAvoided}`);
  console.log(`Final state: ${scenario.extras.finalState}`);

  emitResult({
    benchmark: 'circuit-breaker',
    title: 'Circuit Breaker Benchmark',
    generatedAt: nowIso(),
    profile: profile.name,
    scenario,
  });
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
