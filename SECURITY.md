# Security Policy

## Supported Versions

We actively support and patch security vulnerabilities for the following versions of the project:

| Version                | Supported |
|------------------------|-----------|
| 2.x                    | ✅ Supported |
| 1.x                    | ⚠️ Best-effort security fixes; upgrade to 2.x recommended |
| < 1.0 stable, alpha, beta | ❌ Unsupported |

---

## Reporting a Vulnerability

We take security issues seriously. If you discover a vulnerability, please follow the steps below to report it responsibly:

### **1. Do Not Disclose Publicly**
   - Please avoid publicly disclosing the vulnerability on GitHub, social media, or other public forums until we have addressed it.

### **2. Contact Us**
   - Send an email to **[zhabskiydev@gmail.com](mailto:zhabskiydev@gmail.com)** with the following details:
   - A concise description of the vulnerability.
   - Steps to reproduce the issue, if applicable.
   - Any potential impact the vulnerability may cause.
   - Optionally, your name and any additional information.

### **3. Acknowledgment**
   - We will confirm receipt of your report within **one week** and provide regular updates on the status of the investigation and fix.

---

## Most Important Security Points

If you only read one section of this document, make it this one:

1. **Treat `onTokenRefreshed` as a credential-bearing event**
   - In the current `2.x` line, `TokenRefreshPlugin` emits the raw refreshed token to `onTokenRefreshed` listeners.
   - **Mitigation**: Do not attach untrusted plugins, analytics hooks, or broad logging to this event. Treat every listener as trusted credential-handling code.

2. **Do not use `ManualRetryPlugin` casually for sensitive traffic**
   - Stored manual retries keep replayable request configs in memory, including bodies and custom config fields. In the current `2.x` line, replay is also fail-fast: one replay failure aborts the rest of the batch.
   - **Mitigation**: Prefer automatic mode for sensitive traffic, keep `maxRequestsToStore` low, leave `storeAuthRequests` disabled unless absolutely necessary, use `prepareRequestForStore` to redact payloads, and clear pending retries when they are no longer needed.

3. **Be careful with high-throughput token refresh scenarios**
   - While a refresh is in progress, protected requests can accumulate inside `TokenRefreshPlugin`'s internal queue. In the current `2.x` line that queue is not capped by default.
   - **Mitigation**: Avoid sharing one retry manager across very high-cardinality or bursty traffic, keep refresh handlers fast, and place normal application-level rate limits in front of traffic spikes.

4. **Never share one cached retry manager across security boundaries**
   - `CachingPlugin` stores full responses in memory. If one manager instance is shared across users, tenants, or request contexts, cached data can cross principals if endpoints are not carefully scoped.
   - **Mitigation**: Use separate retry managers per user, tenant, or request boundary for auth-scoped traffic, and avoid caching personalized endpoints on shared instances.

5. **Keep dependencies current**
   - This library depends on Axios and other third-party packages that can receive security advisories independently of this codebase.
   - **Mitigation**: Run `npm audit`, review advisories regularly, and upgrade promptly when patched versions are available.

---

## Known Security Risks and Considerations

While we aim to make this library as secure as possible, there are specific nuances users should consider:

1. **In-Memory Storage of Request Data**
   - Sensitive information, such as request headers or payloads, may be temporarily stored in memory.
   - **Mitigation**: Avoid including credentials or sensitive data in request payloads when possible, or use encryption for sensitive data.

2. **Manual Retry Storage Keeps Replayable Request Data**
   - Failed requests stored for later replay may retain request bodies and custom config fields in process memory.
   - `ManualRetryPlugin` skips auth-bearing requests by default and strips sensitive auth headers before storage, but opting into auth-bearing replay (`storeAuthRequests`) can still retain sensitive material.
   - **Mitigation**: Prefer automatic mode for sensitive traffic, keep `maxRequestsToStore` low, leave `storeAuthRequests` disabled unless you truly need it, use `prepareRequestForStore` to redact payloads, and clear pending retries when they are no longer needed.

3. **Request Retry Behavior**
   - Retried requests might unintentionally duplicate actions (e.g., creating resources) if the server does not support idempotency.
   - **Mitigation**: Use the `Idempotency-Key` header for POST, PUT, and DELETE requests, especially when working with critical resources.

4. **Caching Can Retain Sensitive or User-Specific Responses**
   - The caching plugin stores full responses in memory. If a single `RetryManager` instance is shared across users, tenants, or requests, cached responses for one principal can be served to another unless you isolate instances or carefully scope cache usage.
   - **Mitigation**: Do not cache auth-scoped or personalized endpoints on shared instances. Use separate retry managers per user, tenant, or request boundary when caching sensitive data.

5. **Cache Keys and Debug Output Can Contain Sensitive Values**
   - Cache keys are derived from request URL, params, body, and optionally headers. Sensitive values included in those fields may therefore remain in memory and may appear in debug output.
   - **Mitigation**: Keep secrets out of query params when possible, avoid enabling `compareHeaders` for auth-bearing traffic, and disable debug mode in production unless logs are tightly controlled.

6. **Token Refresh Client Inherits Axios Defaults**
   - The token refresh plugin creates a dedicated Axios client by cloning the manager's defaults. This can include inherited auth headers or other default headers, which may be undesirable if the refresh call targets a different host or trust boundary.
   - **Mitigation**: Keep refresh calls within the same trust boundary when possible, and explicitly override or remove inherited headers inside the refresh function when calling a different endpoint or host.

7. **No Built-In Encryption**
   - The library does not encrypt stored data or requests by default.
   - **Mitigation**: Users can implement custom encryption for sensitive data before sending or storing it.

8. **Third-Party Dependencies**
   - This library relies on third-party dependencies, such as Axios, which may introduce vulnerabilities.
   - **Mitigation**: Regularly check for vulnerabilities using tools like `npm audit` and update dependencies promptly.

9. **User Hooks and Event Listeners Receive Raw Objects**
   - Library events and hooks expose live request and response-adjacent objects to userland code. If your application logs those objects directly, secrets can bypass the library's built-in redaction paths.
   - **Mitigation**: Sanitize data again inside your own listeners, telemetry pipelines, and error-reporting hooks.

---

## How the Library Handles Sensitive Data

- **Request Data**:
   - Temporarily stored in memory for retries and may include sensitive information (headers, payloads).
   - Not written to disk or persisted outside runtime memory.
- **Built-in Logging**:
   - Internal debug and error logging attempts to sanitize configured sensitive headers, body fields, and URL parameters.
   - This protection is primarily for built-in logging paths and should not be treated as full in-memory data sanitization.
- **Caching**:
   - Cached responses are kept in memory and may include sensitive response data depending on the endpoints you cache.
- **User Responsibility**:
   - Ensure that sensitive data (e.g., API keys, tokens) is secured when included in requests.
   - Use HTTPS to encrypt data in transit.

---

## User Responsibilities

To maintain secure usage of this library:
1. **Use the Latest Version**:
   - Always use the most recent version of the library, which includes the latest security patches.
2. **Secure Your Environment**:
   - Run the library in a trusted, secure environment. Avoid execution in untrusted environments without proper precautions.
3. **Monitor Dependencies**:
   - Use tools like `npm audit` or `Snyk` to check for vulnerabilities in dependencies.
4. **Implement Idempotency**:
   - Use `Idempotency-Key` headers for POST, PUT, and DELETE requests to ensure safe retries.
5. **Encryption**:
   - Encrypt sensitive data in request payloads, especially when using retryable storage.
6. **Isolate Security Boundaries**:
   - Do not share one retry manager with caching enabled across multiple users, tenants, or request contexts when responses may differ by identity.
7. **Disable or Limit Debugging in Production**:
   - Use debug logging only in controlled environments, especially if requests or responses can contain secrets.

---

## Handling Process

1. **Validation**:
   - Once a vulnerability is reported, we validate and reproduce the issue.
   - Assess the severity based on its potential impact.

2. **Fix Development**:
   - Security patches are developed, prioritized, and thoroughly tested.

3. **Release Notification**:
   - We release patched versions and disclose vulnerability details responsibly, with acknowledgment for the reporter if agreed upon.

---

## Security Audits and Updates

- **Dependency Monitoring**:
   - Dependencies are regularly audited for vulnerabilities, and patches are applied as needed.
- **Internal Security Audits**:
   - The codebase is reviewed periodically for potential security flaws.
- **Community Reports**:
   - We encourage community members to report vulnerabilities.

---

## Scope and Limitations

1. **Scope**:
   - This library provides retry functionality for HTTP requests and does not include features like data encryption or token management by default.
2. **Limitations**:
   - Security of the underlying transport (e.g., HTTPS) is the user's responsibility.
   - Server-side behavior (e.g., handling of retries or idempotency) is outside the library's control.

---

## Thank You

We appreciate your efforts to responsibly disclose vulnerabilities and contribute to the security of this project. Together, we can ensure a safer and more reliable ecosystem!
