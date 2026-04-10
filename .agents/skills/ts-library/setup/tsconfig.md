# TypeScript Configuration

## Library Base Config

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "strict": true,
    "strictNullChecks": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedDeclarations": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

## Key Options Explained

| Option                 | Value   | Why                                              |
| ---------------------- | ------- | ------------------------------------------------ |
| `target`               | ESNext  | Modern output, bundlers downgrade                |
| `module`               | ESNext  | ESM output                                       |
| `moduleResolution`     | Bundler | Works with modern bundlers, allows no extensions |
| `strict`               | true    | Catch errors early                               |
| `noEmit`               | true    | Build tool handles emit                          |
| `isolatedDeclarations` | true    | Faster DTS generation                            |
| `verbatimModuleSyntax` | true    | Explicit `import type` required                  |
| `skipLibCheck`         | true    | Faster builds                                    |

## Monorepo Config

### Root tsconfig.json

```json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "verbatimModuleSyntax": true
  }
}
```

### Package tsconfig.json

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../utils" }]
}
```

## Path Aliases

For internal imports in monorepos:

```json
{
  "compilerOptions": {
    "paths": {
      "@my-lib/core": ["./packages/core/src"],
      "@my-lib/utils": ["./packages/utils/src"],
      "#internal/*": ["./virtual-shared/*"]
    }
  }
}
```

## Bundler vs Node Resolution

**Use `Bundler`** for libraries consumed by bundlers (Vite, webpack, etc.):

- Allows importing without extensions
- Supports `exports` field in package.json
- Modern, simpler setup

**Use `Node16/NodeNext`** for Node.js-only libraries:

- Requires explicit extensions (`.js`)
- Stricter, matches Node.js behavior exactly

## Type Declarations

Use a dedicated build tsconfig for declaration emit:

```json
// tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "declarationDir": "dist/types",
    "outDir": "dist",
    "rootDir": "src",
    "module": "ESNext",
    "moduleResolution": "Node",
    "noEmit": false
  },
  "include": ["src/**/*"]
}
```

Then bundle only the public declaration entry points:

```javascript
// rollup.config.js
import dts from 'rollup-plugin-dts';

export default [
  {
    input: 'dist/types/index.d.ts',
    output: { file: 'dist/index.d.ts', format: 'es' },
    plugins: [dts()],
  },
];
```

This keeps internal source paths out of the published package and lets you preserve flat declaration files for public subpaths.

## Common Issues

### Module not found errors

Check `moduleResolution` matches your target:

- Bundler: `"Bundler"`
- Node.js: `"Node16"` or `"NodeNext"`

### Type imports not working

Enable `verbatimModuleSyntax` and use explicit:

```typescript
import type { Foo } from './types';
```

### Slow type checking

Enable `skipLibCheck: true` and `isolatedDeclarations: true`.
