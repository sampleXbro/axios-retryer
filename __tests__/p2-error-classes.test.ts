/**
 * P2 coverage for TEST_GAP_ANALYSIS.md §20 Error classes.
 * Complements __tests__/error-standardization.test.ts.
 */
import {
  AxiosRetryerError,
  PluginRegistrationError,
  QueueClearedError,
  QueueDestroyedError,
  QueueFullError,
  QueuedRequestCanceledError,
  RequestAbortedError,
  RetryerConfigError,
  RetryManager,
} from '../src';

describe('P2 Error classes (§20)', () => {
  const cfg = { url: '/x', method: 'GET' as const };

  it('20.1–20.2 AxiosRetryerError has name, message, code, stack and instanceof Error', () => {
    const e = new AxiosRetryerError('m', 'ECODE');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AxiosRetryerError');
    expect(e.message).toBe('m');
    expect(e.code).toBe('ECODE');
    expect(typeof e.stack).toBe('string');
  });

  it('20.3 PluginRegistrationError carries pluginName and pluginVersion', () => {
    const e = new PluginRegistrationError('bad', 'EINVALID_PLUGIN_VERSION', 'P', 'v');
    expect(e.pluginName).toBe('P');
    expect(e.pluginVersion).toBe('v');
    expect(e.code).toBe('EINVALID_PLUGIN_VERSION');
  });

  it('20.4 QueueClearedError attaches request config', () => {
    const e = new QueueClearedError(cfg);
    expect(e.config).toEqual(cfg);
  });

  it('20.5 QueueDestroyedError attaches request config', () => {
    const e = new QueueDestroyedError(cfg);
    expect(e.config).toEqual(cfg);
  });

  it('20.6 QueueFullError attaches request config', () => {
    const e = new QueueFullError(cfg);
    expect(e.config).toEqual(cfg);
  });

  it('20.7 QueuedRequestCanceledError carries requestId and config', () => {
    const e = new QueuedRequestCanceledError('rid-1', cfg);
    expect(e.requestId).toBe('rid-1');
    expect(e.config).toEqual(cfg);
  });

  it('20.8 RequestAbortedError carries requestId', () => {
    const e = new RequestAbortedError('rid-2');
    expect(e.requestId).toBe('rid-2');
  });

  it('20.9 RetryerConfigError carries optionName and optionValue', () => {
    const e = new RetryerConfigError('bad', 'retries', -3);
    expect(e.optionName).toBe('retries');
    expect(e.optionValue).toBe(-3);
  });

  it('20.10 AxiosRetryerError subclasses: RequestAbortedError, RetryerConfigError, PluginRegistrationError', () => {
    expect(new RequestAbortedError()).toBeInstanceOf(AxiosRetryerError);
    expect(new RetryerConfigError('x')).toBeInstanceOf(AxiosRetryerError);
    expect(new PluginRegistrationError('x', 'EPLUGIN_ALREADY_REGISTERED')).toBeInstanceOf(AxiosRetryerError);
  });

  it('20.10 OBSERVED: queue-related AxiosError subclasses are not instanceof AxiosRetryerError', () => {
    expect(new QueueFullError(cfg)).not.toBeInstanceOf(AxiosRetryerError);
    expect(new QueueClearedError(cfg)).not.toBeInstanceOf(AxiosRetryerError);
    expect(new QueueDestroyedError(cfg)).not.toBeInstanceOf(AxiosRetryerError);
    expect(new QueuedRequestCanceledError('id', cfg)).not.toBeInstanceOf(AxiosRetryerError);
  });

  it('20.11 distinct code values for representative errors', () => {
    const codes = new Set<string>();
    codes.add(new AxiosRetryerError('a', 'C1').code);
    codes.add(new RetryerConfigError('b').code);
    codes.add(new PluginRegistrationError('c', 'EPLUGIN_ALREADY_REGISTERED').code);
    codes.add(new RequestAbortedError().code);
    const qf = new QueueFullError(cfg).code;
    expect(qf).toBeDefined();
    codes.add(qf as string);
    expect(codes.size).toBeGreaterThanOrEqual(4);
  });

  it('20.12 toString() includes error name and message', () => {
    const e = new RetryerConfigError('bad opt');
    const s = e.toString();
    expect(s).toContain('RetryerConfigError');
    expect(s).toContain('bad opt');
  });

  it('20.1 constructor validation path still throws RetryerConfigError', () => {
    expect(() => new RetryManager({ retries: -1 })).toThrow(RetryerConfigError);
  });
});
