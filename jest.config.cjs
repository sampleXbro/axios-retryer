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
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testMatch: ['**/__tests__/**/*.test.ts'],
};
