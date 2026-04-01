# Known Issues

This document outlines known issues, unexpected behaviors, and edge cases discovered in axios-retryer through comprehensive integration testing.

## 🔴 Active Issues

### 1. Metrics Inconsistency
**Severity:** Medium  
**Component:** Core Metrics  
**Description:** Retry counts in metrics may not always match expected values across different scenarios.

```typescript
const metrics = retryer.getMetrics();
// Sometimes shows 1 retry when 2 were expected, or vice versa
expect(metrics.successfulRetries).toBe(2); // May fail intermittently
```

**Workaround:** Use `toBeGreaterThanOrEqual()` assertions instead of exact counts in tests.

**Impact:** Affects monitoring and debugging capabilities but not core retry functionality.

### 2. Sensitive Data Can Remain In Memory
**Severity:** High  
**Component:** Manual Retry Store / Caching  
**Description:** Failed requests stored for manual retry and responses stored by the caching plugin can retain raw headers, tokens, payloads, and response bodies in process memory.

**Impact:** Secrets are not written to disk by the library, but they may still be exposed through memory inspection, crash dumps, or accidental userland logging.

**Workaround:**
- Prefer automatic mode for high-sensitivity traffic
- Keep `maxRequestsToStore` low
- Avoid caching auth-scoped or personalized endpoints on shared instances
- Use separate retry managers per user, tenant, or request boundary

### 3. Shared Cache Instances Can Mix User-Specific Data
**Severity:** High  
**Component:** CachingPlugin  
**Description:** The cache key does not isolate users by default. If one retry manager instance is shared across multiple principals, a cached response for one user can be reused for another user requesting the same resource shape.

**Impact:** Possible cross-user or cross-tenant data exposure in SSR, backend, or worker environments.

**Workaround:**
- Do not share caching-enabled retryer instances across users or tenants
- Disable caching for personalized endpoints
- Only use shared caching for public or tenant-agnostic resources

### 4. Cache Keys and Debug Output May Include Sensitive Values
**Severity:** Medium  
**Component:** CachingPlugin / Debug Logging  
**Description:** Cache keys are derived from URL, params, body, and optionally headers. Sensitive values in those fields may therefore remain in memory and may appear in debug output.

**Workaround:**
- Keep secrets out of query params when possible
- Avoid `compareHeaders: true` for auth-bearing requests
- Disable debug mode in production unless logs are tightly controlled

---

## ⚠️ Unexpected Behaviors

### 1. POST Request Idempotency Requirement
**Severity:** Low (By Design)  
**Component:** Core Retry Logic  
**Description:** POST requests require an `Idempotency-Key` header to be retryable by default.

```typescript
// ❌ This POST won't be retried by default
await retryer.axiosInstance.post('/api/data', { data: 'test' });

// ✅ This POST will be retried
await retryer.axiosInstance.post('/api/data', 
  { data: 'test' }, 
  { headers: { 'Idempotency-Key': 'unique-key-123' } }
);
```

**Rationale:** Safety measure to prevent duplicate operations on non-idempotent endpoints.

**Workaround:** 
- Add `Idempotency-Key` headers to POST requests
- Or configure custom retry strategy to allow POST retries without the header

---

## 🔧 Configuration Gotchas

### 1. Concurrent Request Limits
**Description:** Setting `maxConcurrentRequests` too low can cause unexpected queuing behavior.

```typescript
const retryer = createRetryer({
  maxConcurrentRequests: 1, // May cause significant delays
  queueDelay: 100
});
```

**Recommendation:** Use higher concurrency limits unless specifically testing queue behavior.

---

### 2. Circuit Breaker Reset Timing
**Description:** Circuit breaker `openTimeout` affects both failure detection and recovery timing.

```typescript
const circuitBreaker = new CircuitBreakerPlugin({
  failureThreshold: 3,
  openTimeout: 1000 // Affects both failure counting window and recovery time
});
```

**Note:** Consider this dual impact when setting timeout values.

---

## 🧪 Test Environment Issues

### 1. Timing-Sensitive Test Flakiness
**Severity:** Low (Testing Only)  
**Component:** Test Suite  
**Description:** Tests involving delays or timeouts may be flaky in CI environments.

**Affected Areas:**
- Circuit breaker timeout tests
- Cache expiration tests
- Retry delay timing tests

**Workaround:** Use longer timeouts and `toBeGreaterThan()` assertions for timing-related tests.

---

## 🔄 Version Compatibility

### Node.js Versions
- **Tested:** Node.js 16, 18, 20
- **Known Issues:** None reported

### Axios Versions
- **Tested:** Axios 1.x
- **Known Issues:** None reported

---

## 📞 Reporting Issues

If you encounter any of these issues or discover new ones:

1. Check this document first
2. Search existing [GitHub issues](https://github.com/your-org/axios-retryer/issues)
3. Create a new issue with:
   - Clear reproduction steps
   - Environment details
   - Expected vs actual behavior
   - Workaround used (if any)

---

**Last Updated:** 2024-12-19  
**Test Coverage:** 97%+ of integration scenarios  
**Integration Tests:** 54 passing tests across 4 comprehensive test suites  
**Source:** Enhanced comprehensive integration testing suite with edge cases and error scenarios 
