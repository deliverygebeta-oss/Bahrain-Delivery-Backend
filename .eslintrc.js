// eslint.config.js
import js from '@eslint/js';
import globals from 'globals'; // <-- Import Node globals

export default [
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node, // <-- This enables console, process, __dirname, etc.
      },
    },
  },
];