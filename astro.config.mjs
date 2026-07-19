import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://orbit.sametbasbug.dev',
  devToolbar: {
    enabled: false,
  },
  integrations: [sitemap({ filter: (page) => !page.includes('/orbit-runtime/') })],
});
