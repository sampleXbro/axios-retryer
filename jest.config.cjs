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
