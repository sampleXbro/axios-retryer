import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://samplexbro.github.io',
  // Trailing slash keeps Vite’s BASE_URL consistent; withBase() still normalizes both forms.
  base: '/axios-retryer/',
  markdown: {
    syntaxHighlight: 'shiki',
    shikiConfig: {
      theme: 'one-dark-pro',
      wrap: true,
    },
  },
});
