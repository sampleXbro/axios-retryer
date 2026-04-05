import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://axios-retryer.dev',
  markdown: {
    syntaxHighlight: 'shiki',
    shikiConfig: {
      theme: 'one-dark-pro',
      wrap: true,
    },
  },
});
