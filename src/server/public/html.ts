/**
 * Worker'ın public kayıt render girişi. Markup'ın kendisi
 * src/shared/record-markup.ts içinde; burası yalnız yeniden dışa aktarır ki
 * statik Astro yolu ile aynı fonksiyonlar çalışsın.
 */
export {
  renderPublicRecordCard,
  renderPublicFeed,
  renderPublicRecordPage,
} from '../../shared/record-markup';
