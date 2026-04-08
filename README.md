<div align="center">
  <img src="assets/axios-retryer-logo.png" alt="axios-retryer – TypeScript Axios retry library" />
  <p><strong>Production-grade Axios retry library for TypeScript and JavaScript — with concurrency control, request prioritization, automatic token refresh, response caching, circuit breaker, and composable plugins.</strong></p>

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

<p align="center">
  <strong><a href="https://samplexbro.github.io/axios-retryer">📖 Full Documentation</a></strong> · <a href="https://github.com/sampleXbro/axios-retryer">GitHub</a> · <a href="https://www.npmjs.com/package/axios-retryer">npm</a> · <a href="./CHANGELOG.md">Changelog</a>
</p>

---

## What is axios-retryer?

`axios-retryer` is a drop-in Axios retry manager for Node.js, React, and any TypeScript or JavaScript project. It solves the hard parts that ad hoc retry interceptors get wrong: concurrent token refresh without duplicate calls, ordered request queues under backpressure, circuit breaking on unstable upstreams, response caching, and pluggable observability — all with zero magic and full type safety.

**Key capabilities:**

| Feature | Description |
|---------|-------------|
| 🔄 **Intelligent retries** | Automatic or manual retry modes, exponential / linear / static backoff, fully custom strategies |
| 🚦 **Priority queue** | CRITICAL → LOW priorities, binary-heap scheduling, configurable concurrency cap |
| 🔑 **Token refresh** | Queues concurrent 401s, refreshes once, replays all requests with the new token |
| 🛡️ **Circuit breaker** | Trips on N failures, fast-fails during recovery window, sliding-window analysis |
| 💾 **Response caching** | TTR-based in-memory cache, exact / prefix / regex invalidation, swappable storage adapters |
| 📊 **Metrics & events** | Live retry counters, timer health, rich lifecycle event hooks |
| 🌳 **Tree-shakeable plugins** | Each plugin is a separate entry point — unused code is never bundled |

**Peer dependency:** `axios >= 1.7.4`

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

// Chain .use() on one expression so TypeScript merges each plugin's event types
const retryer = createRetryer({
  retries: 3,
  maxConcurrentRequests: 10,
})
  .use(
    createTokenRefreshPlugin(async (axios) => {
      const { data } = await axios.post('/auth/refresh');
      return { token: data.accessToken };
    }),
  )
  .use(createCircuitBreaker({ failureThreshold: 5, openTimeout: 30_000 }));

// Drop-in replacement for your existing axios instance
const { data } = await retryer.axiosInstance.get('/api/users');
```

**Try it:** [Interactive sandbox](https://samplexbro.github.io/axios-retryer/sandbox) (browser, mocked HTTP)

---

## Plugins

Import only what your application needs. Each plugin is independently tree-shakeable:

| Plugin | Import path | Purpose |
|--------|-------------|---------|
| `TokenRefreshPlugin` | `axios-retryer/plugins/TokenRefreshPlugin` | Auth token refresh on 401; optional [per-request opt-out](https://samplexbro.github.io/axios-retryer/docs/plugins/token-refresh#opt-out-of-refresh) |
| `CircuitBreakerPlugin` | `axios-retryer/plugins/CircuitBreakerPlugin` | Fail-fast on repeated upstream failures |
| `CachingPlugin` | `axios-retryer/plugins/CachingPlugin` | In-memory response cache with TTR invalidation |
| `ManualRetryPlugin` | `axios-retryer/plugins/ManualRetryPlugin` | Store failed requests and replay on reconnect |
| `MetricsPlugin` | `axios-retryer/plugins/MetricsPlugin` | Live retry counters and lifecycle events |
| `DebugSanitizationPlugin` | `axios-retryer/plugins/DebugSanitizationPlugin` | Redact secrets from debug logs |

---

## How axios-retryer Compares

| Feature | axios-retryer | axios-retry | retry-axios |
|---------|:---:|:---:|:---:|
| Automatic & Manual retry modes | ✅ | ❌ | ❌ |
| Concurrency control | ✅ | ❌ | ❌ |
| Priority queue | ✅ | ❌ | ❌ |
| Token refresh (401 handling) | ✅ | ❌ | ❌ |
| Circuit breaker | ✅ | ❌ | ❌ |
| Response caching | ✅ | ❌ | ❌ |
| Request cancellation | ✅ | ❌ | ❌ |
| Plugin architecture | ✅ | ❌ | ❌ |
| TypeScript-first | ✅ | ⚠️ | ⚠️ |
| Tree-shakeable | ✅ | ❌ | ❌ |

---

## Performance

Benchmarks from the current release (standard profile, local suite):

- **Healthy-path throughput (core scenario):** `2,150 req/sec`
- **Peak burst throughput (stress scenario):** `4,285 req/sec`
- **Cache hit rate:** `100%` (integration + hot-read scenarios)
- **Test suite:** `67/67` suites · `675/675` tests passing

See [BENCHMARK_RESULTS.md](./BENCHMARK_RESULTS.md) for full methodology and raw numbers.

---

## Documentation

Full API reference, all plugin options, guides, and migration notes:

**[https://samplexbro.github.io/axios-retryer](https://samplexbro.github.io/axios-retryer)**

- [Installation guide](https://samplexbro.github.io/axios-retryer/docs/installation)
- [Configuration reference](https://samplexbro.github.io/axios-retryer/docs/configuration)
- [Plugins overview](https://samplexbro.github.io/axios-retryer/docs/plugins)
- [Production setup guide](https://samplexbro.github.io/axios-retryer/guides/production)
- [Offline support guide](https://samplexbro.github.io/axios-retryer/guides/offline)
- [Migration: v1.x → v2.0](https://samplexbro.github.io/axios-retryer/guides/migration)
- [API reference](https://samplexbro.github.io/axios-retryer/docs/api-reference)
- [SECURITY.md](./SECURITY.md) · [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) · [BENCHMARK_RESULTS.md](./BENCHMARK_RESULTS.md)

---

## Contributing

Bug reports, feature ideas, and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](./LICENSE).

---

<p align="center"><i>Made with ❤️ by <a href="https://github.com/sampleXbro">sampleX (Serhii Zhabskyi)</a></i></p>
