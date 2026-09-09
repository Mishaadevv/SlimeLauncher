// ESLint flat config (ESLint 9).
// The main process (electron/), the renderer (src/) and the shared contract
// (shared/) are all TypeScript; lint everything except build artifacts and the
// standalone Node servers/scripts, which are plain JS outside this config's scope.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-electron/**',
      '**/release/**',
      '**/build/**',
      '**/node_modules/**',
      'server/**',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // This codebase deliberately favours explicit `any` for JSON-shaped rows
      // coming out of SQLite / version manifests.
      '@typescript-eslint/no-explicit-any': 'off',
      // Underscore-prefixed names mark intentionally-unused bindings
      // (e.g. registerFsHandlers(_deps)).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Callbacks like `catch { /* best effort */ }` are idiomatic here.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The two intentionally-broad effects carry eslint-disable comments.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  }
);
