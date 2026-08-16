import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

const eslintConfig = [
  {
    // Ignore generated output, deps, and the standalone worker package (it has
    // its own tsconfig/build). The hand-written browser scripts in public/ are
    // shipped as-is and aren't part of the linted Next.js source tree.
    ignores: [
      'worker/**',
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'public/**/*.js',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // The React Compiler-era hooks rules (shipped error-level in
      // eslint-config-next 16) are performance/style advisories that flag many
      // intentional patterns (resetting state when a dialog opens, measuring
      // the DOM, etc.). Keep them visible as warnings instead of hard failures.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      // Respect the underscore convention for deliberately unused bindings.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
]

export default eslintConfig
