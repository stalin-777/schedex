import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.vscode-test/**', '.codex/**', '.kilo/**', '.agents/**'] },
  js.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }]
    }
  },
  {
    files: ['extension.js', 'src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  },
  {
    files: ['media/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, acquireVsCodeApi: 'readonly' }
    }
  }
];
