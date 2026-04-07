module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    verbose: false,
    coveragePathIgnorePatterns: [
        '<rootDir>/benchmark/',
        '<rootDir>/__tests__/performance/utils/',
        '<rootDir>/__tests__/helpers/'
    ],
    moduleFileExtensions: ['ts', 'js', 'json', 'node'],
    testMatch: ['**/__tests__/**/*.test.ts']
};
