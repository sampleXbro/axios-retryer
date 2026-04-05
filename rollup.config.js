import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import terser from '@rollup/plugin-terser';
import { visualizer } from 'rollup-plugin-visualizer';
import dtsImport from 'rollup-plugin-dts';
// rollup-plugin-dts ships as ESM; when rollup transpiles this config as CJS
// the default export lands on `.default`.
const dts = dtsImport.default ?? dtsImport;

const includeBrowserBuild = process.env.BUILD_BROWSER === 'true';

// Common options for all JS builds
const commonPlugins = (minify = true, name = 'core') => [
    resolve({
        mainFields: ['module', 'main'],
        browser: true,
        preferBuiltins: false,
    }),
    commonjs(),
    typescript({
        tsconfig: './tsconfig.build.json',
        useTsconfigDeclarationDir: true,
        cacheRoot: `.cache/rts2/${name}`,
    }),
    minify && terser({
        format: {
            comments: false
        },
        compress: {
            pure_getters: true,
            passes: 3
        }
    }),
    visualizer({
        filename: `stats/bundle-stats-${name}.html`,
        gzipSize: true,
        brotliSize: true
    })
];

// Main library with minimal core functionality
const mainBundle = {
    input: 'src/index.ts',
    output: [
        {
            dir: 'dist',
            entryFileNames: '[name].cjs.js',
            chunkFileNames: 'chunks/[name]-[hash].cjs.js',
            format: 'cjs',
            sourcemap: false,
            exports: 'named'
        },
        {
            dir: 'dist',
            entryFileNames: '[name].esm.js',
            chunkFileNames: 'chunks/[name]-[hash].esm.js',
            format: 'es',
            sourcemap: false
        }
    ],
    plugins: commonPlugins(true, 'main'),
    external: ['axios'],
    treeshake: {
        moduleSideEffects: false,
        propertyReadSideEffects: false,
        tryCatchDeoptimization: false
    }
};

const createPluginBundle = (input, outputName, bundleName) => ({
    input,
    output: [
        {
            file: `./dist/plugins/${outputName}.cjs.js`,
            format: 'cjs',
            sourcemap: false,
            exports: 'named'
        },
        {
            file: `./dist/plugins/${outputName}.esm.js`,
            format: 'es',
            sourcemap: false
        }
    ],
    plugins: commonPlugins(true, bundleName),
    external: ['axios'],
    treeshake: {
        moduleSideEffects: false,
        propertyReadSideEffects: false,
        tryCatchDeoptimization: false
    }
});

// Generate plugin configurations
const generatePluginConfig = (pluginName) =>
    createPluginBundle(`./src/plugins/${pluginName}/index.ts`, pluginName, pluginName);

// Generate all plugin configurations
const pluginConfigs = [
    'CachingPlugin',
    'CircuitBreakerPlugin',
    'TokenRefreshPlugin',
    'ManualRetryPlugin',
    'DebugSanitizationPlugin',
    'MetricsPlugin',
    'RequestDependencyPlugin',
].map(generatePluginConfig);

const pluginsEntryBundle = createPluginBundle('./src/plugins/index.ts', 'index', 'plugins');

// Optional browser-optimized bundle with all functionality
const browserBundle = {
    input: 'src/index.ts',
    output: {
        file: 'dist/browser/axios-retryer.min.js',
        format: 'umd',
        name: 'AxiosRetryer',
        sourcemap: false,
        inlineDynamicImports: true,
        globals: {
            axios: 'axios'
        }
    },
    plugins: commonPlugins(true, 'browser'),
    external: ['axios']
};

// ─── Declaration bundles ──────────────────────────────────────────────────────
// Each documented public entry point gets a single bundled .d.ts file so that
// internal module paths (core/, store/, utils/) are never published.
// These configs run after the JS builds so that dist/types/ already exists.

const createDtsBundle = (input, output) => ({
    input,
    output: { file: output, format: 'es' },
    plugins: [dts()],
    external: ['axios'],
});

const dtsBundles = [
    createDtsBundle('dist/types/index.d.ts', 'dist/index.d.ts'),
    createDtsBundle('dist/types/plugins/index.d.ts', 'dist/plugins/index.d.ts'),
    createDtsBundle('dist/types/plugins/CachingPlugin/index.d.ts', 'dist/plugins/CachingPlugin.d.ts'),
    createDtsBundle('dist/types/plugins/CircuitBreakerPlugin/index.d.ts', 'dist/plugins/CircuitBreakerPlugin.d.ts'),
    createDtsBundle('dist/types/plugins/TokenRefreshPlugin/index.d.ts', 'dist/plugins/TokenRefreshPlugin.d.ts'),
    createDtsBundle('dist/types/plugins/ManualRetryPlugin/index.d.ts', 'dist/plugins/ManualRetryPlugin.d.ts'),
    createDtsBundle('dist/types/plugins/DebugSanitizationPlugin/index.d.ts', 'dist/plugins/DebugSanitizationPlugin.d.ts'),
    createDtsBundle('dist/types/plugins/MetricsPlugin/index.d.ts', 'dist/plugins/MetricsPlugin.d.ts'),
    createDtsBundle('dist/types/plugins/RequestDependencyPlugin/index.d.ts', 'dist/plugins/RequestDependencyPlugin.d.ts'),
];

const builds = [mainBundle, pluginsEntryBundle, ...pluginConfigs, ...dtsBundles];

if (includeBrowserBuild) {
    builds.push(browserBundle);
}

export default builds;
