# Build Tooling

## Decision Rules

- Use Rollup by default for published libraries, stable public subpaths, or exact filename/layout requirements.
- Use tsdown only for greenfield packages that are happy with modern convention-driven outputs.
- Use unbuild only when you explicitly want its conventions and auto-externals, and package layout compatibility is not the priority.

## Tool Selection

| Tool        | Use case                                                               |
| ----------- | ---------------------------------------------------------------------- |
| **Rollup**  | Published libraries needing exact output names, flat subpaths, and dts |
| **tsdown**  | Greenfield packages with simple modern output conventions              |
| **unbuild** | Convention-first builds where compatibility constraints are loose      |

## Rollup (Recommended for published libraries)

```bash
pnpm add -D rollup rollup-plugin-typescript2 rollup-plugin-dts @rollup/plugin-node-resolve @rollup/plugin-commonjs @rollup/plugin-terser
```

### Basic Config

```javascript
// rollup.config.js
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import terser from '@rollup/plugin-terser';
import dts from 'rollup-plugin-dts';

const jsPlugins = [
  resolve({ mainFields: ['module', 'main'] }),
  commonjs(),
  typescript({
    tsconfig: './tsconfig.build.json',
    useTsconfigDeclarationDir: true,
    cacheRoot: '.cache/rpt2/main',
  }),
  terser(),
];

export default [
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/index.cjs.js', format: 'cjs', exports: 'named' },
      { file: 'dist/index.esm.js', format: 'es' },
    ],
    plugins: jsPlugins,
    external: ['axios'],
  },
  {
    input: 'dist/types/index.d.ts',
    output: { file: 'dist/index.d.ts', format: 'es' },
    plugins: [dts()],
    external: ['axios'],
  },
];
```

### Multiple Public Entry Points

```javascript
const createEntry = (input, outputName) => ({
  input,
  output: [
    { file: `dist/${outputName}.cjs.js`, format: 'cjs', exports: 'named' },
    { file: `dist/${outputName}.esm.js`, format: 'es' },
  ],
  plugins: jsPlugins,
});

export default [createEntry('src/index.ts', 'index'), createEntry('src/plugins/index.ts', 'plugins/index')];
```

### Why Rollup First

- Exact output names such as `index.esm.js`, `index.cjs.js`, or flat plugin files
- Separate control over JS bundling and declaration bundling
- Stable exports for root, barrels, and per-plugin subpaths
- Easy addition of browser/IIFE builds without changing the package contract

## tsdown (Optional for greenfield packages)

```bash
pnpm add -D tsdown
```

Use this when the package is new and you are happy with tool-driven file layout:

```typescript
// tsdown.config.ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});
```

## unbuild (Use only when its conventions are acceptable)

```bash
pnpm add -D unbuild
```

```typescript
// build.config.ts
import { defineBuildConfig } from 'unbuild';

export default defineBuildConfig({
  entries: ['src/index'],
  declaration: true,
  rollup: {
    emitCJS: true,
  },
});
```

## Output Formats

### Rollup dual CJS/ESM

```javascript
output: [
  { file: 'dist/index.cjs.js', format: 'cjs', exports: 'named' },
  { file: 'dist/index.esm.js', format: 'es' },
];
```

### Optional browser build

```javascript
{
  input: 'src/index.ts',
  output: {
    file: 'dist/browser/my-lib.min.js',
    format: 'umd',
    name: 'MyLib',
    inlineDynamicImports: true,
  },
  plugins: jsPlugins,
}
```

## Build Scripts

```json
{
  "scripts": {
    "build": "rollup -c --bundleConfigAsCjs",
    "dev": "rollup -c -w --bundleConfigAsCjs",
    "prepublishOnly": "pnpm build"
  }
}
```

## Verification

Always verify the built package, not just source imports:

```bash
pnpm build
npm pack --json --ignore-scripts
```

Then install the tarball into a temp consumer and check:

- CommonJS `require()` for all documented public subpaths
- ESM `import` for all documented public subpaths
- `tsc --noEmit` under `moduleResolution: "Bundler"`
- `tsc --noEmit` under `moduleResolution: "NodeNext"` when Node consumers matter

## Troubleshooting

### Declaration emit fails with mixed `dir`/`file` outputs

Prefer `rollup-plugin-typescript2` with `useTsconfigDeclarationDir: true`. `@rollup/plugin-typescript` is stricter about `declarationDir` when some bundles emit to a single `file`.

### Missing or overly deep types in output

Emit declarations to `dist/types` from TypeScript, then bundle only the public entry-point declarations with `rollup-plugin-dts`.

### External resolution not working

Check package is in `peerDependencies` and listed in `external`.
