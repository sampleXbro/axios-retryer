import { validateExcludeUrls } from '../src/utils/validateExcludeUrls';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin';

describe('validateExcludeUrls', () => {
  describe('safe patterns — no errors returned', () => {
    it('returns empty array for empty input', () => {
      expect(validateExcludeUrls([])).toEqual([]);
    });

    it('accepts string patterns (always safe)', () => {
      expect(validateExcludeUrls(['/health', '/metrics'])).toEqual([]);
    });

    it('accepts simple literal regex', () => {
      expect(validateExcludeUrls([/\/health/])).toEqual([]);
    });

    it('accepts character class with quantifier (not nested)', () => {
      expect(validateExcludeUrls([/\/api\/[a-z]+/])).toEqual([]);
    });

    it('accepts anchored regex without nested quantifiers', () => {
      expect(validateExcludeUrls([/^\/health$/])).toEqual([]);
    });

    it('accepts mixed string and safe regex', () => {
      expect(validateExcludeUrls(['/health', /\/metrics\/[a-z]+/])).toEqual([]);
    });
  });

  describe('dangerous patterns — errors returned', () => {
    it('flags nested quantifier (a+)+', () => {
      const errors = validateExcludeUrls([/(a+)+$/]);
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(0);
      expect(errors[0].pattern).toEqual(/(a+)+$/);
      expect(errors[0].reason).toMatch('nested quantifier');
    });

    it('flags nested quantifier (a*)*', () => {
      const errors = validateExcludeUrls([/(a*)*/]);
      expect(errors).toHaveLength(1);
      expect(errors[0].reason).toMatch('nested quantifier');
    });

    it('flags nested quantifier (a+)*', () => {
      const errors = validateExcludeUrls([/(a+)*/]);
      expect(errors).toHaveLength(1);
      expect(errors[0].reason).toMatch('nested quantifier');
    });

    it('flags alternation with quantifier (a|ab)+', () => {
      const errors = validateExcludeUrls([/(a|ab)+/]);
      expect(errors).toHaveLength(1);
      expect(errors[0].reason).toMatch('alternation with quantifier');
    });

    it('flags alternation with quantifier (foo|foobar)*', () => {
      const errors = validateExcludeUrls([/(foo|foobar)*/]);
      expect(errors).toHaveLength(1);
      expect(errors[0].reason).toMatch('alternation with quantifier');
    });

    it('reports correct index when dangerous pattern is not first', () => {
      const errors = validateExcludeUrls(['/health', /^\/safe$/, /(a+)+$/]);
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(2);
    });

    it('reports multiple errors for multiple dangerous patterns', () => {
      const errors = validateExcludeUrls([/(a+)+$/, /^ok$/, /(x|xx)+/]);
      expect(errors).toHaveLength(2);
      expect(errors[0].index).toBe(0);
      expect(errors[1].index).toBe(2);
    });

    it('reports at most one error per pattern even if multiple heuristics match', () => {
      // (a+|b+)+ would match both nested quantifier and alternation with quantifier
      const errors = validateExcludeUrls([/(a+|b+)+/]);
      expect(errors).toHaveLength(1);
    });
  });

  describe('CircuitBreakerPlugin constructor — rejects dangerous excludeUrls', () => {
    it('throws RetryerConfigError for a nested-quantifier pattern', () => {
      expect(
        () =>
          new CircuitBreakerPlugin({
            failureThreshold: 3,
            openTimeout: 1000,
            halfOpenMax: 1,
            excludeUrls: [/(a+)+$/],
          }),
      ).toThrow(/nested quantifier/);
    });

    it('does not throw for safe string and regex patterns', () => {
      expect(
        () =>
          new CircuitBreakerPlugin({
            failureThreshold: 3,
            openTimeout: 1000,
            halfOpenMax: 1,
            excludeUrls: ['/health', /^\/metrics$/],
          }),
      ).not.toThrow();
    });
  });
});
