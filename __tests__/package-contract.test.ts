import fs from 'node:fs';
import path from 'node:path';

type PackageJson = {
  type?: string;
  packageManager?: string;
  main?: string;
  module?: string;
  types?: string;
  files?: string[];
  exports?: Record<string, ExportTarget | string>;
};

type ExportCondition = {
  default: string;
  types?: string;
};

type ExportTarget = {
  default?: string;
  import?: ExportCondition;
  require?: ExportCondition;
};

const readPackageJson = (): PackageJson => {
  const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
};

describe('package contract', () => {
  it('publishes modern dual-module entry points for the root and plugin subpaths', () => {
    const packageJson = readPackageJson();

    expect(packageJson.type).toBe('module');
    expect(packageJson.packageManager).toMatch(/^pnpm@/);
    expect(packageJson.main).toBe('./dist/index.cjs');
    expect(packageJson.module).toBe('./dist/index.mjs');
    expect(packageJson.types).toBe('./dist/index.d.mts');
    expect(packageJson.files).toEqual(['dist']);

    expect(packageJson.exports).toMatchObject({
      '.': {
        default: './dist/index.mjs',
        import: {
          types: './dist/index.d.mts',
          default: './dist/index.mjs',
        },
        require: {
          types: './dist/index.d.cts',
          default: './dist/index.cjs',
        },
      },
      './plugins': {
        import: {
          types: './dist/plugins/index.d.mts',
          default: './dist/plugins/index.mjs',
        },
        require: {
          types: './dist/plugins/index.d.cts',
          default: './dist/plugins/index.cjs',
        },
      },
      './plugins/CachingPlugin': {
        import: {
          types: './dist/plugins/CachingPlugin/CachingPlugin.d.mts',
          default: './dist/plugins/CachingPlugin/CachingPlugin.mjs',
        },
        require: {
          types: './dist/plugins/CachingPlugin/CachingPlugin.d.cts',
          default: './dist/plugins/CachingPlugin/CachingPlugin.cjs',
        },
      },
      './plugins/CircuitBreakerPlugin': {
        import: {
          types: './dist/plugins/CircuitBreakerPlugin/CircuitBreakerPlugin.d.mts',
          default: './dist/plugins/CircuitBreakerPlugin/CircuitBreakerPlugin.mjs',
        },
        require: {
          types: './dist/plugins/CircuitBreakerPlugin/CircuitBreakerPlugin.d.cts',
          default: './dist/plugins/CircuitBreakerPlugin/CircuitBreakerPlugin.cjs',
        },
      },
      './plugins/DebugSanitizationPlugin': {
        import: {
          types: './dist/plugins/DebugSanitizationPlugin/DebugSanitizationPlugin.d.mts',
          default: './dist/plugins/DebugSanitizationPlugin/DebugSanitizationPlugin.mjs',
        },
        require: {
          types: './dist/plugins/DebugSanitizationPlugin/DebugSanitizationPlugin.d.cts',
          default: './dist/plugins/DebugSanitizationPlugin/DebugSanitizationPlugin.cjs',
        },
      },
      './plugins/ManualRetryPlugin': {
        import: {
          types: './dist/plugins/ManualRetryPlugin/ManualRetryPlugin.d.mts',
          default: './dist/plugins/ManualRetryPlugin/ManualRetryPlugin.mjs',
        },
        require: {
          types: './dist/plugins/ManualRetryPlugin/ManualRetryPlugin.d.cts',
          default: './dist/plugins/ManualRetryPlugin/ManualRetryPlugin.cjs',
        },
      },
      './plugins/MetricsPlugin': {
        import: {
          types: './dist/plugins/MetricsPlugin/MetricsPlugin.d.mts',
          default: './dist/plugins/MetricsPlugin/MetricsPlugin.mjs',
        },
        require: {
          types: './dist/plugins/MetricsPlugin/MetricsPlugin.d.cts',
          default: './dist/plugins/MetricsPlugin/MetricsPlugin.cjs',
        },
      },
      './plugins/TokenRefreshPlugin': {
        import: {
          types: './dist/plugins/TokenRefreshPlugin/TokenRefreshPlugin.d.mts',
          default: './dist/plugins/TokenRefreshPlugin/TokenRefreshPlugin.mjs',
        },
        require: {
          types: './dist/plugins/TokenRefreshPlugin/TokenRefreshPlugin.d.cts',
          default: './dist/plugins/TokenRefreshPlugin/TokenRefreshPlugin.cjs',
        },
      },
      './package.json': './package.json',
    });

  });
});
