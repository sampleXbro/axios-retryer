<div align="center">
  <img src="assets/axios-retryer-logo.png" alt="axios-retryer logo" width="96" />
  <h1>axios-retryer</h1>
  <p><strong>TypeScript-first Axios retry library with concurrency control, request prioritization, token refresh, response caching, circuit breaker, and more — as composable plugins.</strong></p>

  [![npm version](https://img.shields.io/npm/v/axios-retryer.svg)](https://www.npmjs.com/package/axios-retryer)
  [![npm downloads](https://img.shields.io/npm/dm/axios-retryer.svg)](https://www.npmjs.com/package/axios-retryer)
  [![codecov](https://codecov.io/github/sampleXbro/axios-retryer/graph/badge.svg?token=BRQB5DJVLK)](https://codecov.io/github/sampleXbro/axios-retryer)
  [![Known Vulnerabilities](https://snyk.io/test/github/sampleXbro/axios-retryer/badge.svg)](https://snyk.io/test/github/sampleXbro/axios-retryer)
  ![Build](https://github.com/sampleXbro/axios-retryer/actions/workflows/publish.yml/badge.svg)
  [![Gzipped Size](https://img.shields.io/bundlephobia/minzip/axios-retryer)](https://bundlephobia.com/package/axios-retryer)
  [![TypeScript](https://img.shields.io/badge/TypeScript-First-blue)](https://www.typescriptlang.org/)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
</div>

---

**[📖 Full Documentation & Website](https://axios-retryer.dev)** · [GitHub](https://github.com/sampleXbro/axios-retryer) · [npm](https://www.npmjs.com/package/axios-retryer) · [Changelog](./CHANGELOG.md)

---

## What is axios-retryer?

`axios-retryer` wraps Axios with a production-grade retry manager. It handles the parts that ad hoc interceptors get wrong: concurrent token refresh, orderly request queues, circuit breaking on failing upstreams, response caching, and pluggable observability.

**Key capabilities:**

| | |
|---|---|
| 🔄 **Intelligent retries** | Automatic or manual modes, exponential/linear/static backoff, custom strategies |
| 🚦 **Priority queue** | CRITICAL → LOW priorities, binary-heap scheduling, configurable concurrency |
| 🔑 **Token refresh** | Queues concurrent 401s, refreshes once, replays all with new token |
| 🛡️ **Circuit breaker** | Trips on N failures, fast-fails during recovery, sliding-window analysis |
| 💾 **Response caching** | TTR, exact/prefix/regex invalidation, pluggable storage adapters |
| 📊 **Metrics & events** | Live retry counters, timer health, rich lifecycle event hooks |
| 🌳 **Tree-shakeable plugins** | Each plugin is a separate entry point — unused code stays out of your bundle |

**Requires:** `axios >= 1.7.4`

---

## Installation

```bash
npm install axios-retryer
# yarn add axios-retryer
# pnpm add axios-retryer
```

---

## Quick Start

```typescript
import { createRetryer } from 'axios-retryer';
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
import { createCircuitBreaker } from 'axios-retryer/plugins/CircuitBreakerPlugin';

const retryer = createRetryer({
  retries: 3,
  maxConcurrentRequests: 10,
});

// Refresh tokens automatically on 401
retryer.use(createTokenRefreshPlugin(async (axios) => {
  const { data } = await axios.post('/auth/refresh');
  return { token: data.accessToken };
}));

// Trip circuit open after 5 failures
retryer.use(createCircuitBreaker({ failureThreshold: 5, openTimeout: 30_000 }));

// Drop-in replacement for axios
const { data } = await retryer.axiosInstance.get('/api/users');
```

Try it: [![Edit on CodeSandbox](https://img.shields.io/badge/Edit_on-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/sandbox/axios-retryer-demo-fppdc4)

---

## Plugins

Import only what your app needs. Each plugin is a documented, tree-shakeable entry point:

| Plugin | Import | Purpose |
|--------|--------|---------|
| `TokenRefreshPlugin` | `axios-retryer/plugins/TokenRefreshPlugin` | Auth token refresh on 401 |
| `CircuitBreakerPlugin` | `axios-retryer/plugins/CircuitBreakerPlugin` | Fail-fast on repeated upstream failures |
| `CachingPlugin` | `axios-retryer/plugins/CachingPlugin` | In-memory response cache with TTR |
| `ManualRetryPlugin` | `axios-retryer/plugins/ManualRetryPlugin` | Store failures and replay on reconnect |
| `MetricsPlugin` | `axios-retryer/plugins/MetricsPlugin` | Live retry counters and events |
| `DebugSanitizationPlugin` | `axios-retryer/plugins/DebugSanitizationPlugin` | Redact secrets from debug logs |
| `RequestDependencyPlugin` | `axios-retryer/plugins/RequestDependencyPlugin` | Block low-priority work until critical requests resolve |

---

## Comparison

| Feature | axios-retryer | axios-retry | retry-axios |
|---------|--------------|-------------|-------------|
| Automatic & Manual Modes | ✅ | ❌ | ❌ |
| Concurrency Control | ✅ | ❌ | ❌ |
| Priority Queue | ✅ | ❌ | ❌ |
| Token Refresh Plugin | ✅ | ❌ | ❌ |
| Circuit Breaker | ✅ | ❌ | ❌ |
| Response Caching | ✅ | ❌ | ❌ |
| Cancellation | ✅ | ❌ | ❌ |
| Plugin Architecture | ✅ | ❌ | ❌ |
| TypeScript-First | ✅ | ⚠️ | ⚠️ |
| Tree-Shakeable | ✅ | ❌ | ❌ |

---

## Performance

Current release benchmarks (standard profile, local suite):

- **Healthy-path throughput:** `2,647 req/sec`
- **Peak burst throughput:** `4,013 req/sec`
- **Cache hit rate:** `100%`
- **Test suite:** `63/63` suites · `630/630` tests passing

---

## Documentation

The full documentation — detailed API reference, all plugin options, guides, examples, and migration notes — lives at:

**[https://axios-retryer.dev](https://axios-retryer.dev)**

Quick links:
- [Installation](https://axios-retryer.dev/docs/installation)
- [Configuration reference](https://axios-retryer.dev/docs/configuration)
- [Plugins overview](https://axios-retryer.dev/docs/plugins)
- [Production setup guide](https://axios-retryer.dev/guides/production)
- [Offline support guide](https://axios-retryer.dev/guides/offline)
- [Migration 1.x → 2.0](https://axios-retryer.dev/guides/migration)
- [API reference](https://axios-retryer.dev/docs/api-reference)
- [SECURITY.md](./SECURITY.md) · [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) · [BENCHMARK_RESULTS.md](./BENCHMARK_RESULTS.md)

---

## Contributing

Bug reports, feature ideas, and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](./LICENSE).

---

<p align="center"><i>Made with ❤️ by <a href="https://github.com/sampleXbro">sampleX (Serhii Zhabskyi)</a></i></p>
