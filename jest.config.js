module.exports = {
    testEnvironment: 'node',
    preset: 'ts-jest',
    transform: {
        '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
    },
    testMatch: ['**/*.test.ts'],
    watchPathIgnorePatterns: ['<rootDir>/node_modules', '<rootDir>/volume'],
}
