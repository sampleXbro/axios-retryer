import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import terser from '@rollup/plugin-terser';

module.exports = [
    // Main library
    {
        input: 'src/index.ts',
        output: [
            { file: 'dist/index.cjs.js', format: 'cjs', sourcemap: false },
            { file: 'dist/index.esm.js', format: 'es', sourcemap: false }
        ],
        plugins: [
            resolve(),
            commonjs(),
            typescript({
                tsconfig: './tsconfig.json',
                useTsconfigDeclarationDir: true
            }),
            terser()
        ],
        external: ['axios']
    },
    // CircuitBreakerPlugin
    {
        input: './src/plugins/CircuitBreakerPlugin/index.ts',
        output: [
            { file: './dist/plugins/CircuitBreakerPlugin.cjs.js', format: 'cjs', sourcemap: false },
            { file: './dist/plugins/CircuitBreakerPlugin.esm.js', format: 'es', sourcemap: false }
        ],
        plugins: [
            resolve(),
            commonjs(),
            typescript({
                tsconfig: './tsconfig.json',
                useTsconfigDeclarationDir: true
            }),
            terser()
        ],
        external: ['axios']
    },
    // TokenRefreshPlugin
    {
        input: './src/plugins/TokenRefreshPlugin/index.ts',
        output: [
            { file: './dist/plugins/TokenRefreshPlugin.cjs.js', format: 'cjs', sourcemap: false },
            { file: './dist/plugins/TokenRefreshPlugin.esm.js', format: 'es', sourcemap: false }
        ],
        plugins: [
            resolve(),
            commonjs(),
            typescript({
                tsconfig: './tsconfig.json',
                useTsconfigDeclarationDir: true
            }),
            terser()
        ],
        external: ['axios']
    }
];