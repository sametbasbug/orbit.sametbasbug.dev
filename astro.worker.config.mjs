import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://orbit.sametbasbug.dev',
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
    // Static public pages are rendered by Astro at build time. The custom
    // Worker entrypoint owns /v1 and scheduled work, so workerd prerendering
    // must not try to boot that API router as Astro's prerender server.
    prerenderEnvironment: 'node',
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
