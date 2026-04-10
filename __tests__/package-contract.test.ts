import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type PackageJson = {
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  files?: string[];
  exports?: Record<string, ExportTarget | string>;
  typesVersions?: Record<string, Record<string, string[]>>;
};

type DependencyPackageJson = {
  dependencies?: Record<string, string>;
};

type ExportTarget = {
  default?: string;
  import?: string;
  require?: string;
  types?: string;
};

type PackFile = {
  path: string;
};

type PackResult = {
  filename: string;
  files: PackFile[];
};

type PluginContract = {
  exportPath: string;
  flatCompatPrefix: string;
  expectedFactoryExport: string;
  typesPath: string;
};

const repoRoot = path.resolve(__dirname, '..');
const tempArtifacts = new Set<string>();
const expectedPackedFilePaths = [
  'README.md',
  'dist/index.cjs.js',
  'dist/index.d.ts',
  'dist/index.esm.js',
  'dist/plugins/CachingPlugin.cjs.js',
  'dist/plugins/CachingPlugin.d.ts',
  'dist/plugins/CachingPlugin.esm.js',
  'dist/plugins/CircuitBreakerPlugin.cjs.js',
  'dist/plugins/CircuitBreakerPlugin.d.ts',
  'dist/plugins/CircuitBreakerPlugin.esm.js',
  'dist/plugins/DebugSanitizationPlugin.cjs.js',
  'dist/plugins/DebugSanitizationPlugin.d.ts',
  'dist/plugins/DebugSanitizationPlugin.esm.js',
  'dist/plugins/index.cjs.js',
  'dist/plugins/index.d.ts',
  'dist/plugins/index.esm.js',
  'dist/plugins/ManualRetryPlugin.cjs.js',
  'dist/plugins/ManualRetryPlugin.d.ts',
  'dist/plugins/ManualRetryPlugin.esm.js',
  'dist/plugins/MetricsPlugin.cjs.js',
  'dist/plugins/MetricsPlugin.d.ts',
  'dist/plugins/MetricsPlugin.esm.js',
  'dist/plugins/TokenRefreshPlugin.cjs.js',
  'dist/plugins/TokenRefreshPlugin.d.ts',
  'dist/plugins/TokenRefreshPlugin.esm.js',
  'package.json',
];

const pluginContracts: PluginContract[] = [
  {
    exportPath: './plugins/CachingPlugin',
    flatCompatPrefix: './dist/plugins/CachingPlugin',
    expectedFactoryExport: 'createCachePlugin',
    typesPath: './dist/plugins/CachingPlugin.d.ts',
  },
  {
    exportPath: './plugins/CircuitBreakerPlugin',
    flatCompatPrefix: './dist/plugins/CircuitBreakerPlugin',
    expectedFactoryExport: 'createCircuitBreaker',
    typesPath: './dist/plugins/CircuitBreakerPlugin.d.ts',
  },
  {
    exportPath: './plugins/DebugSanitizationPlugin',
    flatCompatPrefix: './dist/plugins/DebugSanitizationPlugin',
    expectedFactoryExport: 'createDebugSanitizationPlugin',
    typesPath: './dist/plugins/DebugSanitizationPlugin.d.ts',
  },
  {
    exportPath: './plugins/ManualRetryPlugin',
    flatCompatPrefix: './dist/plugins/ManualRetryPlugin',
    expectedFactoryExport: 'createManualRetryPlugin',
    typesPath: './dist/plugins/ManualRetryPlugin.d.ts',
  },
  {
    exportPath: './plugins/MetricsPlugin',
    flatCompatPrefix: './dist/plugins/MetricsPlugin',
    expectedFactoryExport: 'createMetricsPlugin',
    typesPath: './dist/plugins/MetricsPlugin.d.ts',
  },
  {
    exportPath: './plugins/TokenRefreshPlugin',
    flatCompatPrefix: './dist/plugins/TokenRefreshPlugin',
    expectedFactoryExport: 'createTokenRefreshPlugin',
    typesPath: './dist/plugins/TokenRefreshPlugin.d.ts',
  },
];

jest.setTimeout(180_000);

const runCommand = (command: string, args: string[], cwd: string): string => {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
  }).trim();
};

const runNode = (args: string[], cwd = repoRoot): string => runCommand(process.execPath, args, cwd);

const readPackageJson = (): PackageJson => {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
};

const readSandboxPackageJson = (): DependencyPackageJson => {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'sandbox', 'package.json'), 'utf8')) as DependencyPackageJson;
};

const assertFileExists = (relativePath: string): void => {
  expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(true);
};

const createTempDir = (): string => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axios-retryer-package-contract-'));
  tempArtifacts.add(tempDir);
  return tempDir;
};

const writeFile = (targetPath: string, contents: string): void => {
  fs.writeFileSync(targetPath, contents, 'utf8');
};

const parseJsonSuffix = <T>(rawOutput: string): T => {
  const jsonStart = rawOutput.lastIndexOf('\n[');
  const normalized = jsonStart >= 0 ? rawOutput.slice(jsonStart + 1) : rawOutput;
  return JSON.parse(normalized) as T;
};

const packPublishedTarball = (): { tarballPath: string; files: PackFile[] } => {
  const packOutput = runCommand('npm', ['pack', '--json', '--ignore-scripts'], repoRoot);
  const [packResult] = parseJsonSuffix<PackResult[]>(packOutput);
  const tarballPath = path.join(repoRoot, packResult.filename);
  tempArtifacts.add(tarballPath);
  return { tarballPath, files: packResult.files };
};

const installPackedConsumer = (): string => {
  const consumerDir = createTempDir();
  const { tarballPath } = packPublishedTarball();

  runCommand('npm', ['init', '-y'], consumerDir);
  runCommand(
    'npm',
    [
      'install',
      tarballPath,
      path.join(repoRoot, 'node_modules', 'axios'),
      path.join(repoRoot, 'node_modules', 'typescript'),
      path.join(repoRoot, 'node_modules', '@types', 'node'),
    ],
    consumerDir,
  );

  return consumerDir;
};

beforeAll(() => {
  runCommand('pnpm', ['build'], repoRoot);
});

afterAll(() => {
  for (const artifactPath of tempArtifacts) {
    fs.rmSync(artifactPath, { recursive: true, force: true });
  }
});

describe('package contract', () => {
  it('matches the Rollup-era package metadata for root and plugin subpaths', () => {
    const packageJson = readPackageJson();

    expect(packageJson.type).toBeUndefined();
    expect(packageJson.main).toBe('dist/index.cjs.js');
    expect(packageJson.module).toBe('dist/index.esm.js');
    expect(packageJson.types).toBe('dist/index.d.ts');
    expect(packageJson.files).toEqual([
      'dist/index.cjs.js',
      'dist/index.esm.js',
      'dist/index.d.ts',
      'dist/chunks',
      'dist/plugins',
    ]);

    expect(packageJson.exports).toMatchObject({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.esm.js',
        require: './dist/index.cjs.js',
        default: './dist/index.esm.js',
      },
      './plugins': {
        types: './dist/plugins/index.d.ts',
        import: './dist/plugins/index.esm.js',
        require: './dist/plugins/index.cjs.js',
      },
      './package.json': './package.json',
    });

    for (const pluginContract of pluginContracts) {
      expect(packageJson.exports?.[pluginContract.exportPath]).toMatchObject({
        types: pluginContract.typesPath,
        import: `${pluginContract.flatCompatPrefix}.esm.js`,
        require: `${pluginContract.flatCompatPrefix}.cjs.js`,
      });
    }

    expect(packageJson.typesVersions).toBeUndefined();
  });

  it('packs exactly the historical Rollup-era public file set', () => {
    const { files } = packPublishedTarball();

    expect(files.map((file) => file.path)).toEqual(expectedPackedFilePaths);
  });

  it('ships the flat Rollup outputs for the root, barrel, and each plugin subpath', () => {
    assertFileExists('dist/index.cjs.js');
    assertFileExists('dist/index.esm.js');
    assertFileExists('dist/index.d.ts');
    assertFileExists('dist/plugins/index.cjs.js');
    assertFileExists('dist/plugins/index.esm.js');
    assertFileExists('dist/plugins/index.d.ts');

    for (const pluginContract of pluginContracts) {
      assertFileExists(`${pluginContract.flatCompatPrefix}.cjs.js`);
      assertFileExists(`${pluginContract.flatCompatPrefix}.esm.js`);
      assertFileExists(pluginContract.typesPath);
    }
  });

  it('keeps the sandbox wired to the live workspace package instead of an install-time file snapshot', () => {
    const sandboxPackageJson = readSandboxPackageJson();
    const workspaceConfig = fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');

    expect(sandboxPackageJson.dependencies?.['axios-retryer']).toBe('workspace:*');
    expect(workspaceConfig).toContain('  - .');
  });

  it('keeps CommonJS package self-requires working for the root, barrel, and plugin subpaths', () => {
    expect(
      runNode([
        '-e',
        "const mod = require('axios-retryer'); if (typeof mod.createRetryer !== 'function') throw new Error('missing createRetryer'); console.log('ok');",
      ]),
    ).toBe('ok');

    expect(
      runNode([
        '-e',
        "const mod = require('axios-retryer/plugins'); if (typeof mod.createTokenRefreshPlugin !== 'function') throw new Error('missing createTokenRefreshPlugin'); console.log('ok');",
      ]),
    ).toBe('ok');

    for (const pluginContract of pluginContracts) {
      const packageName = pluginContract.exportPath.replace('./', 'axios-retryer/');
      const exportName = pluginContract.expectedFactoryExport;
      expect(
        runNode([
          '-e',
          `const mod = require('${packageName}'); if (typeof mod['${exportName}'] !== 'function') throw new Error('missing ${exportName}'); console.log('ok');`,
        ]),
      ).toBe('ok');
    }
  });

  it('keeps the packed tarball compatible for NodeNext and Bundler TypeScript consumers', () => {
    const consumerDir = installPackedConsumer();
    const tscPath = path.join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc');

    writeFile(
      path.join(consumerDir, 'consumer.mts'),
      [
        "import { createRetryer, type RetryManagerOptions } from 'axios-retryer';",
        "import { createTokenRefreshPlugin as createFromBarrel, type TokenRefreshPluginEvents as BarrelTokenRefreshPluginEvents } from 'axios-retryer/plugins';",
        "import { createCachePlugin, type CachingPluginOptions } from 'axios-retryer/plugins/CachingPlugin';",
        "import { createCircuitBreaker, type CircuitBreakerPluginEvents } from 'axios-retryer/plugins/CircuitBreakerPlugin';",
        "import { createDebugSanitizationPlugin } from 'axios-retryer/plugins/DebugSanitizationPlugin';",
        "import { createManualRetryPlugin, type ManualRetryPluginEvents } from 'axios-retryer/plugins/ManualRetryPlugin';",
        "import { createMetricsPlugin, type MetricsPluginEvents } from 'axios-retryer/plugins/MetricsPlugin';",
        "import { createTokenRefreshPlugin, type TokenRefreshPluginEvents } from 'axios-retryer/plugins/TokenRefreshPlugin';",
        '',
        'const retryManagerOptions: RetryManagerOptions = {};',
        'const cachingOptions = {} as CachingPluginOptions;',
        'const barrelEvents = {} as BarrelTokenRefreshPluginEvents;',
        'const tokenRefreshEvents = {} as TokenRefreshPluginEvents;',
        'const circuitBreakerEvents = {} as CircuitBreakerPluginEvents;',
        'const manualRetryEvents = {} as ManualRetryPluginEvents;',
        'const metricsEvents = {} as MetricsPluginEvents;',
        '',
        'void retryManagerOptions;',
        'void cachingOptions;',
        'void barrelEvents;',
        'void tokenRefreshEvents;',
        'void circuitBreakerEvents;',
        'void manualRetryEvents;',
        'void metricsEvents;',
        'void createRetryer;',
        'void createFromBarrel;',
        'void createCachePlugin;',
        'void createCircuitBreaker;',
        'void createDebugSanitizationPlugin;',
        'void createManualRetryPlugin;',
        'void createMetricsPlugin;',
        'void createTokenRefreshPlugin;',
        '',
      ].join('\n'),
    );

    writeFile(
      path.join(consumerDir, 'consumer.cts'),
      [
        "const { createRetryer } = require('axios-retryer');",
        "const { createTokenRefreshPlugin: createFromBarrel } = require('axios-retryer/plugins');",
        "const { createCachePlugin } = require('axios-retryer/plugins/CachingPlugin');",
        "const { createCircuitBreaker } = require('axios-retryer/plugins/CircuitBreakerPlugin');",
        "const { createDebugSanitizationPlugin } = require('axios-retryer/plugins/DebugSanitizationPlugin');",
        "const { createManualRetryPlugin } = require('axios-retryer/plugins/ManualRetryPlugin');",
        "const { createMetricsPlugin } = require('axios-retryer/plugins/MetricsPlugin');",
        "const { createTokenRefreshPlugin } = require('axios-retryer/plugins/TokenRefreshPlugin');",
        '',
        'void createRetryer;',
        'void createFromBarrel;',
        'void createCachePlugin;',
        'void createCircuitBreaker;',
        'void createDebugSanitizationPlugin;',
        'void createManualRetryPlugin;',
        'void createMetricsPlugin;',
        'void createTokenRefreshPlugin;',
        '',
      ].join('\n'),
    );

    writeFile(
      path.join(consumerDir, 'tsconfig.nodenext.json'),
      JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2020',
            strict: true,
            skipLibCheck: true,
            types: ['node'],
            noEmit: true,
          },
          include: ['consumer.mts', 'consumer.cts'],
        },
        null,
        2,
      ),
    );

    writeFile(
      path.join(consumerDir, 'tsconfig.bundler.json'),
      JSON.stringify(
        {
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            target: 'ES2020',
            strict: true,
            skipLibCheck: true,
            types: ['node'],
            noEmit: true,
          },
          include: ['consumer.mts'],
        },
        null,
        2,
      ),
    );

    expect(runCommand(process.execPath, [tscPath, '--project', 'tsconfig.nodenext.json'], consumerDir)).toBe('');
    expect(runCommand(process.execPath, [tscPath, '--project', 'tsconfig.bundler.json'], consumerDir)).toBe('');
  });

  it('keeps the packed tarball compatible for CommonJS runtime consumers', () => {
    const consumerDir = installPackedConsumer();

    expect(
      runNode(
        [
          '-e',
          "const checks=[['axios-retryer','createRetryer'],['axios-retryer/plugins','createTokenRefreshPlugin'],['axios-retryer/plugins/CachingPlugin','createCachePlugin'],['axios-retryer/plugins/CircuitBreakerPlugin','createCircuitBreaker'],['axios-retryer/plugins/TokenRefreshPlugin','createTokenRefreshPlugin'],['axios-retryer/plugins/ManualRetryPlugin','createManualRetryPlugin'],['axios-retryer/plugins/DebugSanitizationPlugin','createDebugSanitizationPlugin'],['axios-retryer/plugins/MetricsPlugin','createMetricsPlugin']]; for (const [specifier,name] of checks){ const mod=require(specifier); if (typeof mod[name] !== 'function') throw new Error(specifier + ' missing ' + name); } console.log('cjs-ok');",
        ],
        consumerDir,
      ),
    ).toBe('cjs-ok');
  });
});
