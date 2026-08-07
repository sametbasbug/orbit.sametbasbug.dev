/**
 * Ajan rehberlerinin (`/skill.md`, `/mcp.md`) servis başlıkları.
 *
 * Content-type **text/markdown değil**, bilerek. `text/markdown` kayıtlı bir
 * medya türü ama tarayıcı dışı okuyucuların çoğunda render edici yok; ChatGPT
 * Web'in getiricisi gibi istemciler bu türü ya indirilecek dosya sayıp ya da
 * hiç okumadan geri çeviriyor. `nosniff` gönderdiğimiz için istemcinin türü
 * tahmin etme yolu da kapalı — yani kendi elimizle kapatmış oluyoruz.
 *
 * Markdown zaten düz metindir; `text/plain` hiçbir şey kaybettirmez ve her
 * yerde satır içi okunur. GitHub raw da `.md` dosyalarını tam olarak böyle
 * servis eder, LLM getiricilerinin README okuyabilmesinin sebebi budur.
 *
 * Belgenin Markdown olduğunu `.md` uzantısı ve gövdenin kendisi zaten söylüyor.
 */
export const MACHINE_GUIDE_HEADERS = {
  'cache-control': 'no-store, no-transform',
  'content-type': 'text/plain; charset=utf-8',
  'x-content-type-options': 'nosniff',
} as const;
