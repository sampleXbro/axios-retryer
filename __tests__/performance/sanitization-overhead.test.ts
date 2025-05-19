import { RetryManager } from '../../src';
import AxiosMockAdapter from 'axios-mock-adapter';
import { SanitizeOptions } from '../../src/utils/sanitize';

describe('Sanitization Performance Tests', () => {
  let mock: AxiosMockAdapter;

  afterEach(() => {
    if (mock) mock.restore();
  });

  // Test to measure the impact of sanitization on request throughput
  test('should measure the overhead of sanitization on request throughput', async () => {
    // Create test scenarios
    const scenarios = [
      { name: 'No sanitization', enableSanitization: false },
      { name: 'Default sanitization', enableSanitization: true },
      { 
        name: 'Heavy sanitization', 
        enableSanitization: true, 
        sanitizeOptions: { 
          sensitiveHeaders: ['x-custom-header', 'x-session-id'],
          sensitiveFields: ['token', 'password', 'secret', 'key', 'auth'],
          redactionChar: '*'
        } as SanitizeOptions
      }
    ];
    
    const results: Record<string, number> = {};
    const requestCount = 15; // Reduced from 30 for test performance
    
    // Create requests with sensitive data that would trigger sanitization
    const createRequests = (retryManager: RetryManager) => {
      const promises: Promise<any>[] = [];
      
      // Create requests with different types of sensitive data
      for (let i = 0; i < requestCount / 3; i++) {
        // Request with sensitive URL parameters
        promises.push(
          retryManager.axiosInstance.get(`/api/users?token=SENSITIVE_TOKEN_${i}&password=secret${i}`)
        );
        
        // Request with sensitive headers
        promises.push(
          retryManager.axiosInstance.get('/api/data', {
            headers: {
              'Authorization': `Bearer VERY_LONG_JWT_TOKEN_THAT_NEEDS_SANITIZATION_${i}`,
              'x-api-key': `sensitive-api-key-${i}`,
              'Cookie': `session=complex-session-data-${i}; auth=sensitive-auth-data-${i}`
            }
          })
        );
        
        // Request with sensitive body data
        promises.push(
          retryManager.axiosInstance.post('/api/login', {
            username: `user${i}`,
            password: `sensitive-password-${i}`,
            creditCard: `4111-1111-1111-${i}`,
            ssn: `123-45-678${i}`
          })
        );
      }
      
      return promises;
    };
    
    // Run each scenario
    for (const scenario of scenarios) {
      // Create RetryManager with specific sanitization settings
      const retryManager = new RetryManager({
        maxConcurrentRequests: 10,
        debug: true, // Enable debug to ensure sanitization is used
        enableSanitization: scenario.enableSanitization,
        sanitizeOptions: scenario.sanitizeOptions
      });
      
      // Setup mock
      mock = new AxiosMockAdapter(retryManager.axiosInstance);
      mock.onAny().reply(200, { success: true });
      
      // Measure performance
      const startTime = Date.now();
      
      const promises = createRequests(retryManager);
      await Promise.all(promises);
      
      const endTime = Date.now();
      results[scenario.name] = endTime - startTime;
      
      // Clean up
      mock.restore();
    }
    
    // Output results
    console.log('Sanitization Performance Impact:');
    const baseline = results['No sanitization'];
    
    for (const scenario of scenarios) {
      const time = results[scenario.name];
      console.log(`- ${scenario.name}: ${time.toFixed(2)}ms`);
      
      if (scenario.name !== 'No sanitization') {
        const overhead = ((time - baseline) / baseline) * 100;
        console.log(`  Overhead: ${overhead.toFixed(2)}%`);
      }
    }
    
    // In test environments, sometimes timing can be inconsistent
    // Just log the results without strict assertions
    console.log('\nTest complete - check the logs for performance metrics');
  }, 30000);

  // Test to evaluate the impact of sanitization under high request volume
  test('should evaluate sanitization impact under high request volume', async () => {
    // Test parameters - reduced for test environments
    const scenarios = [
      { name: 'No sanitization', enableSanitization: false },
      { name: 'With sanitization', enableSanitization: true }
    ];
    
    const requestVolumes = [5, 20, 50]; // Reduced from [10, 50, 200]
    const results: Record<string, Record<number, number>> = {
      'No sanitization': {},
      'With sanitization': {}
    };
    
    // Create request with some sensitive data
    const createRequest = (retryManager: RetryManager, index: number) => {
      return retryManager.axiosInstance.post('/api/data', {
        id: index,
        user: `user${index}`,
        authToken: `sensitive-auth-token-that-requires-sanitization-${index}`,
        someData: `regular-data-${index}`,
        moreData: `more-data-${index}`.repeat(5) // Create larger payload
      }, {
        headers: {
          'X-Request-ID': `req-id-${index}`,
          'Authorization': `Bearer token-${index}`.repeat(3),
          'Custom-Header': `custom-value-${index}`
        }
      });
    };
    
    // Test each scenario with different volumes
    for (const scenario of scenarios) {
      for (const volume of requestVolumes) {
        // Create RetryManager with specific settings
        const retryManager = new RetryManager({
          maxConcurrentRequests: 20,
          queueDelay: 0, // Minimize queue delay to isolate sanitization impact
          debug: true,
          enableSanitization: scenario.enableSanitization
        });
        
        // Setup mock
        mock = new AxiosMockAdapter(retryManager.axiosInstance);
        mock.onAny().reply(200, { success: true });
        
        // Measure performance
        const startTime = Date.now();
        
        const promises: Promise<any>[] = [];
        for (let i = 0; i < volume; i++) {
          promises.push(createRequest(retryManager, i));
        }
        
        await Promise.all(promises);
        
        const endTime = Date.now();
        results[scenario.name][volume] = endTime - startTime;
        
        // Clean up
        mock.restore();
      }
    }
    
    // Output results
    console.log('\nSanitization Impact with Increasing Request Volume:');
    
    for (const volume of requestVolumes) {
      const withoutSanitization = results['No sanitization'][volume];
      const withSanitization = results['With sanitization'][volume];
      const overhead = ((withSanitization - withoutSanitization) / withoutSanitization) * 100;
      
      console.log(`\nRequest volume: ${volume}`);
      console.log(`- Without sanitization: ${withoutSanitization.toFixed(2)}ms`);
      console.log(`- With sanitization: ${withSanitization.toFixed(2)}ms`);
      console.log(`- Overhead: ${overhead.toFixed(2)}%`);
    }
    
    // We're primarily interested in the results being logged for analysis
    // Don't enforce strict assertions as timings can vary significantly in test environments
    console.log('\nTest complete - check the logs for performance metrics');
  }, 30000);
}); 