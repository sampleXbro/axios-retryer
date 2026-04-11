/**
 * Patterns whose presence in a RegExp source is a strong indicator of
 * catastrophic backtracking (ReDoS). Each entry is a human-readable name
 * paired with a plain-string heuristic applied to the regex `.source`.
 *
 * These are structural checks, not execution probes — they flag patterns that
 * are known to cause exponential backtracking in JavaScript's regex engine
 * when matched against long non-matching strings:
 *
 *  - Nested quantifiers:   `(a+)+`, `(a*)*`, `(a+)*`
 *  - Alternation with overlap inside a quantifier: `(a|aa)+`
 *  - Possessive quantifiers do not exist in JS, so all nested quantifiers
 *    are potentially catastrophic.
 */
const REDOS_HEURISTICS: ReadonlyArray<{ name: string; test: (source: string) => boolean }> = [
  {
    // Nested quantifier: a repeated group that itself contains a quantifier.
    // Matches constructs like: (a+)+  (a*)+  (a+)*  (a+){2,}  ([a-z]+)+
    name: 'nested quantifier',
    test: (src) => /\([^)]*[+*][^)]*\)[+*{]/.test(src),
  },
  {
    // Overlapping alternation inside a quantifier: (a|ab)+  (a|a)+
    // Simplified heuristic: a group containing `|` followed by a quantifier.
    name: 'alternation with quantifier',
    test: (src) => /\([^)]*\|[^)]*\)[+*{]/.test(src),
  },
];

export interface ExcludeUrlValidationError {
  index: number;
  pattern: RegExp;
  reason: string;
}

/**
 * Validates an `excludeUrls` array for RegExp patterns that may cause ReDoS.
 *
 * Strings are always safe (exact equality check). Only RegExp entries are
 * inspected.
 *
 * @returns An array of validation errors. Empty means all patterns are safe.
 */
export function validateExcludeUrls(excludeUrls: readonly (string | RegExp)[]): ExcludeUrlValidationError[] {
  const errors: ExcludeUrlValidationError[] = [];

  for (let i = 0; i < excludeUrls.length; i++) {
    const pattern = excludeUrls[i];
    if (!(pattern instanceof RegExp)) {
      continue;
    }

    for (const heuristic of REDOS_HEURISTICS) {
      if (heuristic.test(pattern.source)) {
        errors.push({
          index: i,
          pattern,
          reason:
            `Potentially catastrophic backtracking detected (${heuristic.name}): ${pattern}. ` +
            'Use a string for exact-match exclusions, or simplify the pattern to avoid nested quantifiers.',
        });
        break; // one error per pattern is enough
      }
    }
  }

  return errors;
}
