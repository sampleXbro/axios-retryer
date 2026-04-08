import { defineConfig } from 'astro/config';
import { SITE_BASE } from './site-base.mjs';

export default defineConfig({
  site: 'https://samplexbro.github.io',
  // Trailing slash keeps Vite’s BASE_URL consistent; withBase() still normalizes both forms.
  base: SITE_BASE,
  markdown: {
    syntaxHighlight: 'shiki',
    shikiConfig: {
      theme: 'one-dark-pro',
      wrap: true,
    },
  },
});
