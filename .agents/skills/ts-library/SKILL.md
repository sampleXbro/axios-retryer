---
name: ts-library
description: Use when authoring TypeScript libraries or npm packages - covers project setup, package.json exports, Rollup-first build tooling, API design patterns, type inference tricks, testing, and publishing to npm. Use when bundling, preserving published package contracts, configuring dual CJS/ESM output, or setting up release workflows.
---

# TypeScript Library Development

Patterns for authoring high-quality TypeScript libraries, extracted from studying unocss, shiki, unplugin, vite, vitest, vueuse, zod, trpc, drizzle-orm, and more.

## When to Use

- Starting a new TypeScript library (single or monorepo)
- Setting up package.json exports for dual CJS/ESM
- Configuring tsconfig for library development
- Choosing build tools, especially Rollup for stable published packages
- Designing type-safe APIs (builder, factory, plugin patterns)
- Writing advanced TypeScript types
- Setting up vitest for library testing
- Configuring release workflow and CI

**For Nuxt module development:** use `nuxt-modules` skill

## Quick Reference

| Working on...         | Load file                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| New project setup     | [.agents/skills/ts-library/references/project-setup.md](.agents/skills/ts-library/references/project-setup.md)         |
| Package exports       | [.agents/skills/ts-library/references/package-exports.md](.agents/skills/ts-library/references/package-exports.md)     |
| tsconfig options      | [.agents/skills/ts-library/references/typescript-config.md](.agents/skills/ts-library/references/typescript-config.md) |
| Build configuration   | [.agents/skills/ts-library/references/build-tooling.md](.agents/skills/ts-library/references/build-tooling.md)         |
| ESLint config         | [.agents/skills/ts-library/references/eslint-config.md](.agents/skills/ts-library/references/eslint-config.md)         |
| API design patterns   | [.agents/skills/ts-library/references/api-design.md](.agents/skills/ts-library/references/api-design.md)               |
| Type inference tricks | [.agents/skills/ts-library/references/type-patterns.md](.agents/skills/ts-library/references/type-patterns.md)         |
| Testing setup         | [.agents/skills/ts-library/references/testing.md](.agents/skills/ts-library/references/testing.md)                     |
| Release workflow      | [.agents/skills/ts-library/references/release.md](.agents/skills/ts-library/references/release.md)                     |
| CI/CD setup           | [.agents/skills/ts-library/references/ci-workflows.md](.agents/skills/ts-library/references/ci-workflows.md)           |

## Loading Files

**Consider loading these reference files based on your task:**

- [ ] [.agents/skills/ts-library/references/project-setup.md](.agents/skills/ts-library/references/project-setup.md) - if starting a new TypeScript library project
- [ ] [.agents/skills/ts-library/references/package-exports.md](.agents/skills/ts-library/references/package-exports.md) - if configuring package.json exports or dual CJS/ESM
- [ ] [.agents/skills/ts-library/references/typescript-config.md](.agents/skills/ts-library/references/typescript-config.md) - if setting up or modifying tsconfig.json
- [ ] [.agents/skills/ts-library/references/build-tooling.md](.agents/skills/ts-library/references/build-tooling.md) - if configuring Rollup, tsdown, unbuild, or build scripts
- [ ] [.agents/skills/ts-library/references/eslint-config.md](.agents/skills/ts-library/references/eslint-config.md) - if setting up ESLint for library development
- [ ] [.agents/skills/ts-library/references/api-design.md](.agents/skills/ts-library/references/api-design.md) - if designing public APIs, builder patterns, or plugin systems
- [ ] [.agents/skills/ts-library/references/type-patterns.md](.agents/skills/ts-library/references/type-patterns.md) - if working with advanced TypeScript types or type inference
- [ ] [.agents/skills/ts-library/references/testing.md](.agents/skills/ts-library/references/testing.md) - if setting up vitest or writing tests for library code
- [ ] [.agents/skills/ts-library/references/release.md](.agents/skills/ts-library/references/release.md) - if configuring release workflow or versioning
- [ ] [.agents/skills/ts-library/references/ci-workflows.md](.agents/skills/ts-library/references/ci-workflows.md) - if setting up GitHub Actions or CI/CD pipelines

**DO NOT load all files at once.** Load only what's relevant to your current task.

## Published Package Rule

- For an existing published library, inspect the current `package.json` exports, `npm pack` output, and all documented subpaths before changing the builder.
- If exact filenames, flat subpaths, or legacy typings must remain stable, prefer Rollup over convention-driven builders.
- Treat changes to entry filenames, export-map ordering, or declaration layout as package-contract changes that must be verified from a packed consumer install.

## New Library Workflow

1. Create project structure → load [.agents/skills/ts-library/references/project-setup.md](.agents/skills/ts-library/references/project-setup.md)
2. For published packages, inspect the current export map and packed tarball before changing builders
3. Configure `package.json` exports → load [.agents/skills/ts-library/references/package-exports.md](.agents/skills/ts-library/references/package-exports.md)
4. Set up build with Rollup by default → load [.agents/skills/ts-library/references/build-tooling.md](.agents/skills/ts-library/references/build-tooling.md)
5. Verify build: `pnpm build && npm pack --json --ignore-scripts` — check output includes the exact expected `.esm.js`, `.cjs.js`, and `.d.ts` public entry points
6. Add package-contract tests and clean-consumer checks → load [.agents/skills/ts-library/references/testing.md](.agents/skills/ts-library/references/testing.md)
7. Configure release → load [.agents/skills/ts-library/references/release.md](.agents/skills/ts-library/references/release.md)

## Quick Start

```json
// package.json (minimal)
{
  "name": "my-lib",
  "main": "./dist/index.cjs.js",
  "module": "./dist/index.esm.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.esm.js",
      "require": "./dist/index.cjs.js"
    }
  },
  "files": ["dist"]
}
```

```js
// rollup.config.js
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import dts from 'rollup-plugin-dts';

export default [
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/index.cjs.js', format: 'cjs', exports: 'named' },
      { file: 'dist/index.esm.js', format: 'es' },
    ],
    plugins: [
      resolve({ mainFields: ['module', 'main'] }),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.build.json',
        useTsconfigDeclarationDir: true,
      }),
    ],
  },
  {
    input: 'dist/types/index.d.ts',
    output: { file: 'dist/index.d.ts', format: 'es' },
    plugins: [dts()],
  },
];
```

## Key Principles

- Preserve existing published paths and typings unless the user explicitly wants a package-contract migration
- Dual format: always support both CJS and ESM consumers
- Prefer Rollup when exact filenames, flat subpaths, or multiple public entry points must stay stable
- Use a dedicated build tsconfig when declaration emit needs different compiler settings than local typechecking
- Smart defaults: detect environment, don't force config
- Verify from a packed tarball and a clean consumer install, not just from repo-local imports
- Tree-shakeable: lazy getters, proper `sideEffects: false`

_Token efficiency: Main skill ~300 tokens, each reference ~800-1200 tokens_
