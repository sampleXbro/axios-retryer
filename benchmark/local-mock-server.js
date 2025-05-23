const { RetryManager } = require('../dist/index.cjs');
const { performance } = require('perf_hooks');

// Mock adapter that simulates various scenarios without network calls
function createMockAdapter(config = {}) {
  const {
    successRate = 0.7,  // 70% success rate
    avgLatency = 10,    // 10ms average latency
    variableLatency = 5 // ±5ms latency variation
  } = config;
  
  let requestCount = 0;
  
  return async function mockAdapter(config) {
    requestCount++;
    
    // Simulate realistic latency with variation
    const latency = avgLatency + (Math.random() - 0.5) * 2 * variableLatency;
    await new Promise(resolve => setTimeout(resolve, latency));
    
    // Determine if request should succeed based on success rate
    const shouldSucceed = Math.random() < successRate;
    
    if (shouldSucceed) {
      return {
        data: { 
          success: true, 
          requestId: requestCount,
          timestamp: Date.now()
        },
        status: 200,
        statusText: 'OK',
        headers: { 'x-request-id': requestCount.toString() },
        config: config
      };
    } else {
      // Simulate different error types
      const errorTypes = [500, 502, 503, 504, 429];
      const status = errorTypes[Math.floor(Math.random() * errorTypes.length)];
      
      const error = new Error(`Request failed with status code ${status}`);
      error.response = {
        data: { error: 'Simulated server error' },
        status: status,
        statusText: 'Server Error',
        headers: {},
        config: config
      };
      error.config = config;
      throw error;
    }
  };
}

async function runControlledBenchmark() {
  console.log('🚀 Starting controlled local benchmark...');
  
  const scenarios = [
    { name: 'High Success Rate (90%)', successRate: 0.9, requests: 5000 },
    { name: 'Medium Success Rate (70%)', successRate: 0.7, requests: 5000 },
    { name: 'Low Success Rate (30%)', successRate: 0.3, requests: 2000 },
    { name: 'High Latency (50ms)', successRate: 0.8, avgLatency: 50, requests: 1000 }
  ];
  
  const results = [];
  
  for (const scenario of scenarios) {
    console.log(`\n📊 Testing: ${scenario.name}`);
    
    const manager = new RetryManager({
      retries: 3,
      maxConcurrentRequests: 100,
      debug: false
    });
    
    // Replace axios adapter with mock
    manager.axiosInstance.defaults.adapter = createMockAdapter({
      successRate: scenario.successRate,
      avgLatency: scenario.avgLatency || 10
    });
    
    const startTime = performance.now();
    const startMemory = process.memoryUsage();
    
    // Create requests
    const requests = Array.from({ length: scenario.requests }, (_, i) => 
      manager.axiosInstance.get(`/test/${i}`, {
        __priority: i % 5 // Mixed priorities
      }).catch(err => err) // Don't let Promise.all fail
    );
    
    // Wait for completion
    const responses = await Promise.all(requests);
    const endTime = performance.now();
    const endMemory = process.memoryUsage();
    
    // Analyze results
    const successful = responses.filter(r => r.status === 200).length;
    const failed = responses.length - successful;
    const duration = endTime - startTime;
    const throughput = (responses.length / duration) * 1000; // req/sec
    const memoryDelta = endMemory.heapUsed - startMemory.heapUsed;
    
    const metrics = manager.getMetrics();
    const timerStats = manager.getTimerStats ? manager.getTimerStats() : { healthScore: 0 };
    
    const result = {
      scenario: scenario.name,
      requests: scenario.requests,
      successful,
      failed,
      duration: Math.round(duration),
      throughput: Math.round(throughput),
      memoryDelta: Math.round(memoryDelta / 1024 / 1024), // MB
      retries: metrics.successfulRetries + metrics.failedRetries,
      timerHealth: isNaN(timerStats.healthScore) ? 0 : timerStats.healthScore
    };
    
    results.push(result);
    
    console.log(`✅ ${successful}/${responses.length} successful`);
    console.log(`⚡ ${Math.round(throughput)} req/sec`);
    console.log(`🧠 Memory delta: ${result.memoryDelta}MB`);
    console.log(`🔄 Total retries: ${result.retries}`);
    console.log(`⏱️  Timer health: ${result.timerHealth}`);
    
    manager.destroy();
    
    // Allow garbage collection
    if (global.gc) global.gc();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Summary report
  console.log('\n📋 BENCHMARK SUMMARY');
  console.log('='.repeat(50));
  results.forEach(r => {
    console.log(`${r.scenario}:`);
    console.log(`  Throughput: ${r.throughput} req/sec`);
    console.log(`  Success Rate: ${Math.round(r.successful/r.requests*100)}%`);
    console.log(`  Memory Delta: ${r.memoryDelta}MB`);
    console.log(`  Timer Health: ${r.timerHealth}`);
  });
  
  return results;
}

// Memory leak detection
async function memoryLeakTest() {
  console.log('\n🔍 Running memory leak detection...');
  
  const cycles = 10;
  const requestsPerCycle = 500;
  const memorySnapshots = [];
  
  for (let cycle = 0; cycle < cycles; cycle++) {
    const manager = new RetryManager({
      retries: 2,
      maxConcurrentRequests: 50,
      debug: false
    });
    
    manager.axiosInstance.defaults.adapter = createMockAdapter({
      successRate: 0.8,
      avgLatency: 5
    });
    
    // Force garbage collection if available
    if (global.gc) global.gc();
    
    const memoryBefore = process.memoryUsage();
    
    const requests = Array.from({ length: requestsPerCycle }, (_, i) => 
      manager.axiosInstance.get(`/leak-test/${i}`).catch(err => err)
    );
    
    await Promise.all(requests);
    manager.destroy();
    
    // Force garbage collection
    if (global.gc) global.gc();
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const memoryAfter = process.memoryUsage();
    const heapDelta = memoryAfter.heapUsed - memoryBefore.heapUsed;
    
    memorySnapshots.push({
      cycle,
      heapDelta: Math.round(heapDelta / 1024 / 1024), // MB
      totalHeap: Math.round(memoryAfter.heapUsed / 1024 / 1024) // MB
    });
    
    console.log(`Cycle ${cycle + 1}/${cycles}: Heap delta ${Math.round(heapDelta / 1024 / 1024)}MB, Total: ${Math.round(memoryAfter.heapUsed / 1024 / 1024)}MB`);
  }
  
  // Analyze memory trend
  const avgDelta = memorySnapshots.reduce((sum, s) => sum + s.heapDelta, 0) / cycles;
  const totalGrowth = memorySnapshots[cycles-1].totalHeap - memorySnapshots[0].totalHeap;
  
  console.log(`\n🧠 Memory Analysis:`);
  console.log(`  Average delta per cycle: ${avgDelta.toFixed(2)}MB`);
  console.log(`  Total heap growth: ${totalGrowth.toFixed(2)}MB`);
  console.log(`  Memory leak risk: ${totalGrowth > 50 ? '⚠️  HIGH' : totalGrowth > 20 ? '⚠️  MODERATE' : '✅ LOW'}`);
  
  return { avgDelta, totalGrowth, snapshots: memorySnapshots };
}

// Run benchmarks
if (require.main === module) {
  (async () => {
    try {
      console.log('Run with --expose-gc for better memory analysis');
      
      const benchmarkResults = await runControlledBenchmark();
      const memoryResults = await memoryLeakTest();
      
      console.log('\n🎯 PRODUCTION READINESS ASSESSMENT');
      console.log('='.repeat(50));
      
      const avgThroughput = benchmarkResults.reduce((sum, r) => sum + r.throughput, 0) / benchmarkResults.length;
      const maxMemoryDelta = Math.max(...benchmarkResults.map(r => r.memoryDelta));
      const validTimerHealths = benchmarkResults.map(r => r.timerHealth).filter(h => !isNaN(h));
      const avgTimerHealth = validTimerHealths.length > 0 ? validTimerHealths.reduce((sum, h) => sum + h, 0) / validTimerHealths.length : 0;
      
      console.log(`✅ Average Throughput: ${Math.round(avgThroughput)} req/sec`);
      console.log(`🧠 Max Memory Delta: ${maxMemoryDelta}MB`);
      console.log(`⏱️  Average Timer Health: ${avgTimerHealth.toFixed(1)}`);
      console.log(`🔒 Memory Leak Risk: ${memoryResults.totalGrowth > 20 ? 'MODERATE' : 'LOW'}`);
      
      const score = avgThroughput > 200 && maxMemoryDelta < 100 && avgTimerHealth < 50 && memoryResults.totalGrowth < 50 ? '🏆 EXCELLENT' : '✅ GOOD';
      console.log(`\n🎖️  Overall Rating: ${score}`);
      
    } catch (error) {
      console.error('Benchmark failed:', error);
      process.exit(1);
    }
  })();
} 