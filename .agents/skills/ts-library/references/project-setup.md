# Project Setup

## Single Package

```bash
# Clone starter template
cp -r ~/templates/antfu/starter-ts my-lib
cd my-lib && rm -rf .git && git init
pnpm install
```

Or manual setup:

```bash
mkdir my-lib && cd my-lib
pnpm init
pnpm add -D typescript rollup rollup-plugin-typescript2 rollup-plugin-dts @rollup/plugin-node-resolve @rollup/plugin-commonjs @rollup/plugin-terser vitest eslint @antfu/eslint-config
```

### Directory Structure

```
my-lib/
├── src/
│   ├── index.ts      # Main entry
│   └── types.ts      # Type definitions
├── test/
│   └── index.test.ts
├── dist/             # Build output (gitignored)
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── rollup.config.js
├── eslint.config.ts
└── vitest.config.ts
```

## Monorepo

```bash
cp -r ~/templates/antfu/starter-monorepo my-monorepo
cd my-monorepo && rm -rf .git && git init
pnpm install
```

### Structure

```
my-monorepo/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   ├── package.json
│   │   └── rollup.config.js
│   └── cli/
│       ├── src/
│       └── package.json
├── playground/          # Integration tests
├── pnpm-workspace.yaml
├── package.json         # Root scripts, devDeps
├── tsconfig.json        # Base config
└── eslint.config.ts
```

### pnpm-workspace.yaml

```yaml
packages:
  - packages/*
  - playground

catalogs:
  build:
    rollup: ^3.0.0
    rollup-plugin-typescript2: ^0.37.0
    rollup-plugin-dts: ^6.4.1
    '@rollup/plugin-node-resolve': ^15.0.0
    '@rollup/plugin-commonjs': ^24.0.0
    '@rollup/plugin-terser': ^0.4.4
  lint:
    eslint: ^9.0.0
    '@antfu/eslint-config': ^4.0.0
  test:
    vitest: ^3.0.0
  types:
    typescript: ^5.7.0
```

## pnpm Catalogs

Organize dependencies by purpose (from antfu's blog post):

| Category | Contents                             |
| -------- | ------------------------------------ |
| build    | rollup, rollup plugins, dts bundling |
| lint     | eslint, @antfu/eslint-config         |
| test     | vitest, @vue/test-utils              |
| types    | typescript, @types/\*                |
| prod     | Runtime deps: consola, defu, pathe   |

### Using Catalogs

```json
{
  "devDependencies": {
    "rollup": "catalog:build",
    "eslint": "catalog:lint",
    "vitest": "catalog:test",
    "typescript": "catalog:types"
  }
}
```

## ESLint Setup

```bash
pnpm add -D eslint @antfu/eslint-config
```

```typescript
// eslint.config.ts
import antfu from '@antfu/eslint-config';

export default antfu({
  type: 'lib',
  pnpm: true,
  formatters: true,
});
```

## Git Hooks

```bash
pnpm add -D simple-git-hooks lint-staged
```

```json
{
  "simple-git-hooks": { "pre-commit": "pnpm lint-staged" },
  "lint-staged": { "*": "eslint --fix" },
  "scripts": { "prepare": "simple-git-hooks" }
}
```

Run `pnpm prepare` after adding.

## Scripts

```json
{
  "scripts": {
    "build": "rollup -c --bundleConfigAsCjs",
    "dev": "rollup -c -w --bundleConfigAsCjs",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "release": "bumpp",
    "prepublishOnly": "pnpm build"
  }
}
```

For an existing published package, freeze the current public contract before changing the build:

- copy the existing `exports` map
- note all documented subpaths
- verify the packed tarball from a clean consumer install
