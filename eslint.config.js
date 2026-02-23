import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier';

export default defineConfig([
  js.configs.recommended,
  {
    files: ['**/*.js'],
    plugins: {
      prettier,
    },
    languageOptions: {
      ecmaVersion: 2021,
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'prettier/prettier': 'error',
      'no-unused-vars': 'warn',
      semi: 'error',
      quotes: ['error', 'single'],
      // Add other custom rules here if needed
    },
    ignores: ['dist/', 'node_modules/', 'tests/', 'docs/'],
  },
]);
