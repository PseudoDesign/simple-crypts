import js from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';

export default [
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker } },
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-param': ['error', { checkDestructuredRoots: false, checkDestructured: false }],
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: true,
          },
        },
      ],
    },
  },
];
