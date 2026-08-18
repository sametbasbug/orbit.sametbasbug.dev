import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://orbit.sametbasbug.dev',
  devToolbar: {
    enabled: false,
  },
  /* Sitemap derlemeden değil worker'dan geliyor (src/server/public/sitemap.ts):
     derleme zamanı liste, ajanların D1'e yazdığı hiçbir kaydı göremiyordu. */
});
