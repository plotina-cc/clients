// ESLint for the Plotina patch scope: the rules from the lint card, type-aware where they need to be.
//
// Loaded by scripts/lint-patches.sh with --no-config-lookup, so this file is the *only* config in
// play: upstream's own .eslintrc belongs to upstream's plugin set and would fail on plugins that
// are not installed next to a patched checkout.
//
// `typescript-eslint` is imported through an absolute path when the gate hands one over
// (PLOTINA_TS_ESLINT_MODULE), because this file lives in this repository while the package is
// installed wherever the runner put it. Without the variable it resolves normally, which is what
// happens on a machine that has the packages inside the checkout.
import { createRequire } from 'node:module';
import path from 'node:path';

// The package is resolved by name through require(), from the node_modules directory the gate points
// at (PLOTINA_TS_ESLINT_MODULE): this file lives in this repository, the package is installed
// wherever the runner put eslint, and a directory path cannot be require()d either — the package
// declares only `exports`, no `main`, so a path require misses dist/index.js.
const modules = process.env.PLOTINA_TS_ESLINT_MODULE;
const requireFrom = modules
  ? createRequire(path.join(path.resolve(modules), 'noop.js'))
  : createRequire(import.meta.url);
const tseslint = requireFrom('typescript-eslint');
const typed = Boolean(process.env.PLOTINA_TS_PROJECT);

export default tseslint.config({
  files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  linterOptions: {
    // Upstream files carry inline disables naming plugins this config does not load. Honouring them,
    // or reporting them as unused, produces findings about the config rather than about the code.
    noInlineConfig: true,
    reportUnusedDisableDirectives: false,
  },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: typed
      ? { project: process.env.PLOTINA_TS_PROJECT, tsconfigRootDir: process.env.PLOTINA_TS_ROOT }
      : { ecmaVersion: 'latest', sourceType: 'module' },
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    // An empty block, with allowEmptyCatch deliberately off: `catch {}` is the shape of every error
    // we have swallowed, and it is the one case the default allows.
    'no-empty': ['error', {}],
    // A Promise nobody awaits or catches: the request that never reports its failure.
    '@typescript-eslint/no-floating-promises': typed ? 'error' : 'off',
    // checksVoidReturn.attributes off: on React JSX an async handler is a legitimate attribute
    // value, and without that the rule reports every {async () => …} onClick in our overlays.
    '@typescript-eslint/no-misused-promises': typed
      ? ['error', { checksVoidReturn: { attributes: false } }]
      : 'off',
  },
});
