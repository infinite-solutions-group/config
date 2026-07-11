// Shared strict ESLint flat config for Infinite Solutions projects.
// Consume:  import base from '@infinite-solutions-group/config/eslint'
//           export default base                 // or spread + add overrides
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import globals from 'globals'

const SILENT_CATCH =
  'Silent catch swallows the error. Log the real error first, then recover.'
const silentCatchRules = [
  "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Literal']",
  "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
  "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='ArrayExpression']",
  "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='ObjectExpression']",
  "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
].map((selector) => ({ selector, message: SILENT_CATCH }))

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.config.{js,mjs,cjs,ts}',
      '**/next-env.d.ts',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  { languageOptions: { globals: { ...globals.node } } },

  // Type-aware error-handling rules. `projectService` uses the consumer's cwd —
  // do NOT pin tsconfigRootDir here (that would resolve to this package).
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'prefer-const': 'error',
      'no-restricted-syntax': ['error', ...silentCatchRules],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    files: ['apps/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
    },
    settings: { react: { version: 'detect' } },
  },

  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
)
