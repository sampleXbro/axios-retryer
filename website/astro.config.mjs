import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://samplexbro.github.io',
  base: '/axios-retryer',
  markdown: {
    syntaxHighlight: 'shiki',
    shikiConfig: {
      theme: 'one-dark-pro',
      wrap: true,
    },
  },
});
