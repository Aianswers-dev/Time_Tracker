import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules',
    '**/dist',
    '**/dev-dist',
    '**/coverage',
    '**/.wrangler',
    '.claude/worktrees',
    // Run with tsx or esbuild against the shared sources; not part of any tsconfig.
    'tools/e2e/**/*.ts',
    'apps/server/public',
    'apps/server/drizzle',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // Playwright scripts: part of each runs in the page through page.evaluate.
    files: ['tools/e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Scriptable (iOS) widget scripts run in Scriptable's own runtime.
    files: ['tools/scriptable/**/*.js'],
    languageOptions: {
      globals: {
        Color: 'readonly',
        DateFormatter: 'readonly',
        FileManager: 'readonly',
        Font: 'readonly',
        ListWidget: 'readonly',
        Request: 'readonly',
        Script: 'readonly',
        config: 'readonly',
      },
    },
  },
  prettier,
]);
