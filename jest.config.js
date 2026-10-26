module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['<rootDir>/tests/ui/**/*.test.tsx'],
  clearMocks: true,
  restoreMocks: true,
  setupFilesAfterEnv: ['<rootDir>/tests/ui/setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-safe-area-context)/)',
  ],
};
