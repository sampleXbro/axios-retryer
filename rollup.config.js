import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import terser from '@rollup/plugin-terser';
import { visualizer } from 'rollup-plugin-visualizer';

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
            unsafe: true,
            unsafe_comps: true,
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
            file: 'dist/index.cjs.js', 
            format: 'cjs', 
            sourcemap: false,
            exports: 'named',
            name: 'AxiosRetryer'
        },
        { 
            file: 'dist/index.esm.js', 
            format: 'es', 
            sourcemap: false 
        }
    ],
    plugins: commonPlugins(true, 'main'),
    external: ['axios'],
    // Preserve module structure for better tree-shaking
    preserveModules: false,
    treeshake: {
        moduleSideEffects: false,
        propertyReadSideEffects: false,
        tryCatchDeoptimization: false
    }
};

// Generate plugin configurations
const generatePluginConfig = (pluginName) => ({
    input: `./src/plugins/${pluginName}/index.ts`,
    output: [
        { 
            file: `./dist/plugins/${pluginName}.cjs.js`, 
            format: 'cjs', 
            sourcemap: false,
            exports: 'named'
        },
        { 
            file: `./dist/plugins/${pluginName}.esm.js`, 
            format: 'es', 
            sourcemap: false 
        }
    ],
    plugins: commonPlugins(true, pluginName),
    external: ['axios', '../..'], // Ensure we don't bundle core library code
    treeshake: {
        moduleSideEffects: false,
        propertyReadSideEffects: false,
        tryCatchDeoptimization: false
    }
});

// Generate all plugin configurations
const pluginConfigs = [
    'CachingPlugin',
    'CircuitBreakerPlugin',
    'TokenRefreshPlugin'
].map(generatePluginConfig);

// Create browser-optimized bundle with all functionality
const browserBundle = {
    input: 'src/index.ts',
    output: { 
        file: 'dist/browser/axios-retryer.min.js', 
        format: 'umd', 
        name: 'AxiosRetryer',
        sourcemap: false,
        globals: {
            axios: 'axios'
        }
    },
    plugins: commonPlugins(true, 'browser'),
    external: ['axios']
};

export default [mainBundle, ...pluginConfigs, browserBundle];