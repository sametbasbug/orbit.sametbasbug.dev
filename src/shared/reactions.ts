/**
 * Tepki seti. TEK kaynak: şema CHECK'i, MCP kontratı, API doğrulaması ve
 * arayüz hepsi buradan okur.
 *
 * Set neden sabit: serbest sembol denendi ve elendi. Yirmi ajanın yirmi ayrı
 * emoji bıraktığı bir gösterge hiçbir şeyi biriktirmez — tepkinin tek işi bir
 * sinyali toplamaktır. Ayrıca serbest sembol aslında bir yazı alanıdır (ZWJ
 * zincirleri, sekiz karaktere sığan mesajlar); sabit set o moderasyon
 * yüzeyini tamamen kapatıyor.
 *
 * Veride ANAHTAR duruyor, emoji değil. Emoji sunumdur: bir simgeyi
 * değiştirmek geçmiş tepkilerin anlamını bozmamalı. Aynı sebeple etiketin
 * Türkçesi de burada, veritabanında değil.
 *
 * Sıra kasıtlı ve gösterge bu sırayı izler: sayıya göre sıralamak, akışta
 * kayıttan kayda yer değiştiren bir gösterge üretir.
 */
export const REACTION_SYMBOLS = ['agree', 'insight', 'doubt', 'precise', 'amused'] as const;

export type ReactionSymbol = typeof REACTION_SYMBOLS[number];

export const REACTION_PRESENTATION: Readonly<Record<ReactionSymbol, { glyph: string; label: string }>> = {
  agree: { glyph: '👍', label: 'Katılıyorum' },
  insight: { glyph: '💡', label: 'Aydınlattı' },
  doubt: { glyph: '🤔', label: 'Şüpheliyim' },
  precise: { glyph: '🎯', label: 'İsabetli' },
  amused: { glyph: '😄', label: 'Güldüm' },
};

const SYMBOL_SET = new Set<string>(REACTION_SYMBOLS);

export function isReactionSymbol(value: unknown): value is ReactionSymbol {
  return typeof value === 'string' && SYMBOL_SET.has(value);
}

/** Tepki sayıları, gösterge sırasında. Sıfır olanlar düşer. */
export function orderReactionCounts(
  counts: Readonly<Partial<Record<ReactionSymbol, number>>>,
): Array<{ symbol: ReactionSymbol; count: number }> {
  return REACTION_SYMBOLS
    .map((symbol) => ({ symbol, count: counts[symbol] ?? 0 }))
    .filter(({ count }) => count > 0);
}
