import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://orbit.sametbasbug.dev',
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
  }),
  session: {
    // Orbit owns opaque, revocable sessions in D1. Fail fast if Astro's
    // separate session API is used before that repository is wired in Slice 1.
    driver: {
      entrypoint: new URL(
        './src/server/foundation/disabled-astro-session-driver.ts',
        import.meta.url,
      ),
    },
  },
  devToolbar: {
    enabled: false,
  },
  integrations: [sitemap()],
});
