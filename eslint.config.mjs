import js from '@eslint/js';

export default [
  {
    // Ignore generated data, dependency trees, and Postgres volume data
    ignores: [
      '**/node_modules/**',
      '**/data/synthetic.json',
      'data-output/**',
      'services/*/data/**',
    ],
  },
  {
    // Jest test files — expose globals so no-undef doesn't fire
    files: ['services/**/test/**/*.js', 'services/**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require:  'readonly',
        module:   'readonly',
        exports:  'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process:  'readonly',
        console:  'readonly',
        // Jest globals
        test:        'readonly',
        expect:      'readonly',
        describe:    'readonly',
        it:          'readonly',
        beforeEach:  'readonly',
        afterEach:   'readonly',
        beforeAll:   'readonly',
        afterAll:    'readonly',
        jest:        'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { vars: 'all', args: 'after-used', ignoreRestSiblings: true }],
      'no-undef':       'error',
      'no-console':     'off',
    },
  },
  {
    // All project JS files
    files: ['services/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require:  'readonly',
        module:   'readonly',
        exports:  'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process:  'readonly',
        console:  'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer:   'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { vars: 'all', args: 'after-used', ignoreRestSiblings: true }],
      'no-undef':       'error',
      'eqeqeq':         ['error', 'always', { null: 'ignore' }],
      'no-var':         'error',
      'prefer-const':   ['error', { destructuring: 'all' }],
      'no-console':     'off',   // ETL services legitimately log progress
    },
  },
];
