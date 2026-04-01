import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'no-debugger': 'error',
    },
  },
  {
    ignores: ['node_modules/', 'dist/', 'test/fixtures/'],
  },
);
