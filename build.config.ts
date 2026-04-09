import { defineBuildConfig } from 'unbuild';

export default defineBuildConfig({
  clean: true,
  declaration: 'node16',
  externals: ['axios'],
  rollup: {
    emitCJS: true,
    dts: {
      respectExternal: true,
    },
    esbuild: {
      minify: true,
      target: 'es2019',
    },
  },
});
