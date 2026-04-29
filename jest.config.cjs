/** @see package.json: `test:run` (parallel), `test:quick` (skip heavy dirs), `test:ci` (--runInBand). */
module.exports = {
  testEnvironment: 'node',
  verbose: false,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: './tsconfig.test.json',
      },
    ],
  },
  coveragePathIgnorePatterns: [
    '<rootDir>/benchmark/',
    '<rootDir>/__tests__/performance/utils/',
    '<rootDir>/__tests__/helpers/',
  ],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 92,
      lines: 95,
      statements: 95,
    },
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testMatch: ['**/__tests__/**/*.test.ts'],
};
