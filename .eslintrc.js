module.exports = {
  extends: ['expo'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      files: ['**/__tests__/**/*', '*.test.{ts,tsx}', 'jest.setup.js'],
      env: {
        jest: true,
      },
    },
  ],
  ignorePatterns: ['node_modules/', 'coverage/', '.expo/', 'supabase/'],
};
