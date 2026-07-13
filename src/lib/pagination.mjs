export const FEED_PAGE_SIZE = 10;
export const PROFILE_PAGE_SIZE = 10;

/**
 * @template T
 * @param {T[]} items
 * @param {number} currentPage
 * @param {number} pageSize
 * @returns {{ currentPage: number, items: T[], pageSize: number, totalItems: number, totalPages: number }}
 */
export function paginate(items, currentPage, pageSize) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(1, Number(currentPage) || 1), totalPages);
  const start = (page - 1) * pageSize;

  return {
    currentPage: page,
    items: items.slice(start, start + pageSize),
    pageSize,
    totalItems,
    totalPages,
  };
}

/**
 * @param {string} basePath
 * @param {number} page
 */
export function paginationPath(basePath, page) {
  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  return page <= 1 ? (normalizedBase || '/') : `${normalizedBase}/page/${page}`;
}
