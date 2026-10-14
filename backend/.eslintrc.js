module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  // Spec files are excluded from tsconfig (project) and are typechecked +
  // executed by ts-jest, so type-aware linting doesn't apply to them here.
  // The quote render graph is mirrored byte-for-byte into frontend/lib/quotes
  // and quote-model.ts is pinned to an approved source hash
  // (quotes-render/mirror.spec.ts, quotes/compute-quote.spec.ts), so these files
  // are never reformatted by lint --fix; change them only together with their mirror.
  ignorePatterns: [
    '.eslintrc.js',
    '**/*.spec.ts',
    'src/brand-ops/brand-ops.types.ts',
    'src/brand-ops/brand-tokens.ts',
    'src/quotes-render/quote-model.ts',
    'src/quotes-render/quote-view.ts',
    'src/quotes-render/fixtures/orderpad.fixture.ts',
    'src/quotes-render/template/*.ts',
  ],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    // Underscore-prefixed names are intentionally unused (port signatures,
    // destructured omissions); rest siblings drop fields from a copy.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
};
