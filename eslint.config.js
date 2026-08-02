import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['scripts/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-constant-condition': 'error',
      'no-dupe-else-if': 'error',
      'no-else-return': ['error', { allowElseIf: false }],
      'no-lone-blocks': 'error',
      'no-unreachable': 'error',
      'no-useless-return': 'error',
      'max-depth': ['error', 4],
      'max-lines-per-function': ['error', {
        max: 600,
        skipBlankLines: true,
        skipComments: true,
      }],
      '@typescript-eslint/no-confusing-non-null-assertion': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-duplicate-type-constituents': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-unnecessary-condition': ['error', {
        allowConstantLoopConditions: 'always',
      }],
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-useless-empty-export': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      '@typescript-eslint/require-await': 'error',
    },
  },
  {
    // Durable keyring recovery is intentionally explicit: flattening these
    // transaction branches mechanically would make failure semantics harder to audit.
    files: [
      'src/credentials/provider-store.ts',
      'src/credentials/keyring/**/*.ts',
    ],
    rules: {
      'max-depth': ['error', 6],
    },
  },
  {
    // Existing stateful orchestration is tracked at its current ceiling while
    // new modules use the stricter global limit above.
    files: ['src/dashboard.tsx'],
    rules: {
      'max-lines-per-function': ['error', {
        max: 850,
        skipBlankLines: true,
        skipComments: true,
      }],
    },
  },
  {
    files: ['src/oauth/responses-websocket.ts'],
    rules: {
      'max-lines-per-function': ['error', {
        max: 1_100,
        skipBlankLines: true,
        skipComments: true,
      }],
    },
  },
);
