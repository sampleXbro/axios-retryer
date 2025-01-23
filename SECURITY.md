# Security Policy

## Supported Versions

We actively support and patch security vulnerabilities for the following versions of the project:

| Version                | Supported          |
|------------------------|--------------------|
| > 1.x                  | ✅ Fully supported |
| < 1.0 or alpha or beta | ❌ Unsupported     |

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

## Known Security Risks and Considerations

While we aim to make this library as secure as possible, there are specific nuances users should consider:

1. **In-Memory Storage of Request Data**
   - Sensitive information, such as request headers or payloads, may be temporarily stored in memory.
   - **Mitigation**: Avoid including credentials or sensitive data in request payloads when possible, or use encryption for sensitive data.

2. **Request Retry Behavior**
   - Retried requests might unintentionally duplicate actions (e.g., creating resources) if the server does not support idempotency.
   - **Mitigation**: Use the `Idempotency-Key` header for POST, PUT, and DELETE requests, especially when working with critical resources.

3. **No Built-In Encryption**
   - The library does not encrypt stored data or requests by default.
   - **Mitigation**: Users can implement custom encryption for sensitive data before sending or storing it.

4. **Third-Party Dependencies**
   - This library relies on third-party dependencies, such as Axios, which may introduce vulnerabilities.
   - **Mitigation**: Regularly check for vulnerabilities using tools like `npm audit` and update dependencies promptly.

---

## How the Library Handles Sensitive Data

- **Request Data**:
   - Temporarily stored in memory for retries and may include sensitive information (headers, payloads).
   - Not written to disk or persisted outside runtime memory.
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
