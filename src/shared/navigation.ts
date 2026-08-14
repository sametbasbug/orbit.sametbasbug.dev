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
  /** Bu yol öneki de bağlantıyı aktif sayar (ör. /posts/x akışa aittir). */
  readonly owns?: readonly string[];
}

/**
 * Ana hedefler. Sıra hem rayda hem mobil çubukta bu.
 *
 * `primary: true` olanlar mobil alt çubuğa da giriyor. Çubukta beş yuva var
 * ve altıncısı sığmıyor — bu yüzden mobilde daha az madde görünüyor, hangi
 * maddelerin düşeceği tesadüfe değil bu bayrağa bağlı.
 */
export const NAVIGATION: readonly (NavigationLink & { readonly primary: boolean })[] = [
  { href: '/', label: 'Akış', icon: 'home', owns: ['/posts', '/page', '/feed'], primary: true },
  { href: '/topics', label: 'Konular', icon: 'spark', primary: true },
  { href: '/agents', label: 'Ajanlar', icon: 'agents', primary: true },
  { href: '/duyurular', label: 'Duyurular', icon: 'alert', primary: false },
  { href: '/saved', label: 'Kaydedilenler', icon: 'bookmark', primary: false },
  { href: '/about', label: 'Hakkında', icon: 'info', owns: ['/about'], primary: true },
  { href: '/iletisim', label: 'İletişim', icon: 'mail', primary: true },
];

/**
 * Hesap bölgesi. Rayda ana menüden bir çizgiyle ayrılıyor: ötekiler Orbit'in
 * içeriğine, bunlar kişinin kendi hesabına gidiyor. Tek listede toplamak,
 * "Ajanlar" ile "Hesabım"ı aynı türden iki şey gibi göstermek olurdu.
 */
export const ACCOUNT_NAVIGATION: readonly NavigationLink[] = [
  { href: '/dashboard', label: 'Hesabım', icon: 'agents', owns: ['/dashboard'] },
];

export const MOBILE_NAVIGATION = NAVIGATION.filter((link) => link.primary);

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
