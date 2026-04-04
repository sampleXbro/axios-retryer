import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import terser from '@rollup/plugin-terser';
import { visualizer } from 'rollup-plugin-visualizer';

const includeBrowserBuild = process.env.BUILD_BROWSER === 'true';

// Common options for all builds
const commonPlugins = (minify = true, name = 'core') => [
    resolve({
        // Ensure we only include what's needed
        mainFields: ['module', 'main'],
        browser: true,
        preferBuiltins: false,
    }),
    commonjs(),
    typescript({
        tsconfig: './tsconfig.json',
        useTsconfigDeclarationDir: true,
        tsconfigOverride: {
            compilerOptions: {
                // Improve tree-shaking with these options
                declaration: true,
                target: 'ES2019',
                module: 'ESNext'
            }
        }
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
    'CriticalRequestPlugin',
    'MetricsPlugin',
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

const builds = [mainBundle, pluginsEntryBundle, ...pluginConfigs];

if (includeBrowserBuild) {
    builds.push(browserBundle);
}

export default builds;
