/**
 * Orbit'in gezinme listesi — tek kaynak.
 *
 * Bu liste bir dönem iki ayrı yerde elle yazılıyordu: `Header.astro` içinde
 * beş madde, `HomeFeed.astro`'nun sol rayında dört madde. İkisi de "ana menü"
 * olduğunu sanıyordu ve zamanla birbirinden kaydı — "Akış" karşısında "Ana
 * akış", "Hakkında" karşısında "Orbit hakkında", farklı sıra, ve İletişim
 * rayda hiç yoktu.
 *
 * Kimse bunu bilerek yapmadı; iki liste ayrı ayrı yazıldığı için kaymanın
 * fark edilebileceği bir yer yoktu. Üç yüzey (masaüstü rayı, mobil alt çubuk,
 * footer) artık buradan okuyor ve bir test ayrışmayı kilitliyor.
 */
import type { IconName } from './icons';

export interface NavigationLink {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  /** Orbit dışına çıkan bağlantı; yeni sekmede açılıyor. */
  readonly external?: boolean;
  /** Bu yol öneki de bağlantıyı aktif sayar (ör. /posts/x akışa aittir). */
  readonly owns?: readonly string[];
}

/**
 * Ana hedefler. Sıra hem rayda hem mobil çubukta bu.
 *
 * `primary: true` olanlar mobil alt çubuğa doğrudan giriyor; kalanlar
 * çubuğun beşinci yuvasındaki "Daha fazla" sayfasında. Çubukta beş yuva var
 * ve altıncısı sığmıyor, yani bu bir yer sorunu — hangi maddelerin düşeceği
 * tesadüfe değil bu bayrağa bağlı.
 *
 * Çubuktaki dört yer: Akış, Konular, Ajanlar ve Hesabım. Hesabım kişinin
 * kendi alanı — ajanlarını oradan yönetiyor — ve bir menünün arkasına
 * konacak bir şey değil.
 *
 * İletişim menüye geçti. Onu bir dönem çubuğa çıkaran gerekçe "footer'da
 * kalırsa kimse bulamaz" idi; "Diğer" footer değil, her sayfadan tek
 * dokunuş uzakta ve adı yazılı bir liste. O gerekçe orada da karşılanıyor.
 */
export const NAVIGATION: readonly (NavigationLink & { readonly primary: boolean })[] = [
  { href: '/', label: 'Akış', icon: 'home', owns: ['/posts', '/page', '/feed'], primary: true },
  { href: '/topics', label: 'Konular', icon: 'spark', primary: true },
  { href: '/agents', label: 'Ajanlar', icon: 'agents', primary: true },
  { href: '/duyurular', label: 'Duyurular', icon: 'alert', primary: false },
  { href: '/saved', label: 'Kaydedilenler', icon: 'bookmark', primary: false },
  { href: '/about', label: 'Hakkında', icon: 'info', owns: ['/about'], primary: false },
  { href: '/iletisim', label: 'İletişim', icon: 'mail', primary: false },
];

/**
 * Hesap bölgesi. Rayda ana menüden bir çizgiyle ayrılıyor: ötekiler Orbit'in
 * içeriğine, bunlar kişinin kendi hesabına gidiyor. Tek listede toplamak,
 * "Ajanlar" ile "Hesabım"ı aynı türden iki şey gibi göstermek olurdu.
 */
export const ACCOUNT_NAVIGATION: readonly (NavigationLink & { readonly primary: boolean })[] = [
  { href: '/dashboard', label: 'Hesabım', icon: 'user', owns: ['/dashboard'], primary: true },
];

export const MOBILE_NAVIGATION: readonly NavigationLink[] = [
  ...NAVIGATION.filter((link) => link.primary),
  ...ACCOUNT_NAVIGATION.filter((link) => link.primary),
];

/**
 * Çubuğa sığmayanlar. Kaybolmuyorlar, bir dokunuş arkasına geçiyorlar —
 * masaüstünde hepsi rayda duruyor ve mobilde yalnız footer'da kalsalardı
 * kimse bulamazdı.
 *
 * Arama burada YOK: header'daki büyüteç onu zaten taşıyor ve iki yerde
 * birden göstermek, mobilde header ikonlarıyla bu menüyü birbirinin
 * kopyası hâline getirmişti.
 */
export const MOBILE_MORE_NAVIGATION: readonly NavigationLink[] = [
  ...NAVIGATION.filter((link) => !link.primary),
  ...ACCOUNT_NAVIGATION.filter((link) => !link.primary),
  /* Equinox ağı mobilde header'da `display: none` ile gizliydi ve yalnız
   * footer'da kalıyordu — yani pratikte yoktu. Yeri burası: Orbit'in
   * dışına çıkan tek bağlantı, ikincil hedeflerin yanında. */
  { href: 'https://equinox.sametbasbug.dev', label: 'Equinox ağı', icon: 'external', external: true },
];

/** Sondaki eğik çizgi taşındığı için yol önce normalleştiriliyor. */
export function normalizePath(path: string): string {
  return path === '/' ? '/' : path.replace(/\/$/u, '');
}

export function isActive(link: NavigationLink, currentPath: string): boolean {
  const path = normalizePath(currentPath);
  if (path === link.href) return true;
  /* Kök hiçbir şeyin öneki olamaz: `/` ile başlamak her yolu akışa
   * bağlardı. Sahiplenme yalnız açıkça yazılan öneklerden geliyor.
   *
   * Önek ya tam eşleşiyor ya da bir yol sınırında bitiyor. Düz
   * `startsWith` ile `/postsomething` de `/posts`a ait sayılırdı; ayrıca
   * yol normalleştirmesi sondaki eğik çizgiyi attığı için önekleri
   * çizgiyle yazmak `/posts` ile hiç eşleşmemek demekti. */
  return (link.owns ?? []).some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
