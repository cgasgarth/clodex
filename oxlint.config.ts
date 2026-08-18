import { defineConfig } from 'oxlint';

export default defineConfig({
  categories: {
    correctness: 'error',
    perf: 'error',
    suspicious: 'error',
  },
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: 'error',
    typeAware: true,
  },
  ignorePatterns: [
    '.agent/**',
    '.agents/**',
    '.claude/**',
    '.codex/**',
    '.continue/**',
    '.cursor/**',
    '.gemini/**',
    '.opencode/**',
    '.pi/**',
    '.roo/**',
    '.windsurf/**',
    'dist/**',
    'coverage/**',
    'node_modules/**',
    'tools/oxlint/anti-slop/**',
  ],
  jsPlugins: [
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
  ],
  rules: {
    'max-depth': ['error', 4],
    'max-lines-per-function': [
      'error',
      { max: 600, skipBlankLines: true, skipComments: true },
    ],
    'no-constant-condition': 'error',
    'no-dupe-else-if': 'error',
    'no-else-return': ['error', { allowElseIf: false }],
    'no-lone-blocks': 'error',
    // Clodex uses ordered retry, stream, patch, and filesystem loops where
    // concurrent iteration would change behavior.
    'no-await-in-loop': 'off',
    'no-unreachable': 'error',
    'no-useless-return': 'error',
    'typescript/await-thenable': 'error',
    'typescript/no-confusing-non-null-assertion': 'error',
    'typescript/no-duplicate-type-constituents': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/no-non-null-asserted-optional-chain': 'error',
    'typescript/no-redundant-type-constituents': 'error',
    'typescript/no-unnecessary-boolean-literal-compare': 'error',
    'typescript/no-unnecessary-condition': [
      'error',
      { allowConstantLoopConditions: 'always' },
    ],
    'typescript/no-unnecessary-qualifier': 'error',
    'typescript/no-unnecessary-type-arguments': 'error',
    'typescript/no-unnecessary-type-assertion': 'error',
    // Anti-slop supplies narrower assertion checks and requires a safety
    // justification at each assertion boundary.
    'typescript/no-unsafe-type-assertion': 'off',
    // Generic type guards preserve the caller's owner type and avoid raw
    // unknown parameters, as required by anti-slop.
    'typescript/no-unnecessary-type-parameters': 'off',
    'typescript/no-useless-empty-export': 'error',
    'typescript/no-wrapper-object-types': 'error',
    'typescript/require-await': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-runtime-typeof': ['error', { allowInTypeGuards: true }],
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
  },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      rules: {
        'typescript/await-thenable': 'off',
        'typescript/no-base-to-string': 'off',
        'typescript/no-confusing-non-null-assertion': 'off',
        'typescript/no-duplicate-type-constituents': 'off',
        'typescript/no-explicit-any': 'off',
        'typescript/no-floating-promises': 'off',
        'typescript/no-implied-eval': 'off',
        'typescript/no-misused-promises': 'off',
        'typescript/no-non-null-asserted-optional-chain': 'off',
        'typescript/no-redundant-type-constituents': 'off',
        'typescript/no-unnecessary-boolean-literal-compare': 'off',
        'typescript/no-unnecessary-condition': 'off',
        'typescript/no-unnecessary-qualifier': 'off',
        'typescript/no-unnecessary-type-arguments': 'off',
        'typescript/no-unnecessary-type-assertion': 'off',
        'typescript/no-unnecessary-type-conversion': 'off',
        'typescript/no-unnecessary-type-parameters': 'off',
        'typescript/no-unsafe-type-assertion': 'off',
        'typescript/no-useless-default-assignment': 'off',
        'typescript/no-useless-empty-export': 'off',
        'typescript/no-wrapper-object-types': 'off',
        'typescript/require-array-sort-compare': 'off',
        'typescript/require-await': 'off',
        'typescript/unbound-method': 'off',
      },
    },
    {
      files: [
        'src/credentials/provider-store.ts',
        'src/credentials/keyring/**/*.ts',
      ],
      rules: {
        'max-depth': ['error', 6],
      },
    },
    {
      files: ['src/ui/dashboard.tsx'],
      rules: {
        'max-lines-per-function': [
          'error',
          { max: 850, skipBlankLines: true, skipComments: true },
        ],
      },
    },
    {
      files: ['src/oauth/responses-websocket.ts'],
      rules: {
        'max-lines-per-function': [
          'error',
          { max: 1_100, skipBlankLines: true, skipComments: true },
        ],
      },
    },
  ],
});
