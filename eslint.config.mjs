import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const readabilityRules = {
  curly: ['error', 'all'],
  eqeqeq: ['error', 'always'],
  'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
  '@stylistic/lines-between-class-members': ['error', 'always'],
  '@stylistic/padding-line-between-statements': [
    'error',
    { blankLine: 'always', prev: '*', next: 'return' },
    { blankLine: 'always', prev: 'import', next: '*' },
    { blankLine: 'any', prev: 'import', next: 'import' },
    { blankLine: 'always', prev: ['const', 'let'], next: '*' },
    { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
    { blankLine: 'always', prev: '*', next: ['class', 'function', 'multiline-export'] },
    { blankLine: 'always', prev: ['class', 'function', 'multiline-export'], next: '*' },
    { blankLine: 'always', prev: ['block-like', 'multiline-expression'], next: '*' },
  ],
};

const notYetAdopted = [
  'src/apps/',
  'src/packages/contracts/',
  'src/packages/runtime/',
  'src/packages/shared-types/',
  'src/services/driver-vehicle-location-service/',
  'src/services/matching-service/',
  'src/services/pricing-service/',
  'src/services/simulated-payment-service/',
  'src/services/notification-service/',
  'scripts/build-all.cjs',
  'webpack.config.js',
];

export default defineConfig(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'docs/', ...notYetAdopted],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      ...readabilityRules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['**/*.cjs', '**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
