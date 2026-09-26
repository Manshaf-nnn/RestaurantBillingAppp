import 'server-only'

/**
 * The bits every inventory drill-down page repeats: read the window, read
 * the location, read the page number.
 *
 * Its own module rather than four copies, because the four pages must agree
 * on what `?page=` and `?perPage=` mean or a link from one lands somewhere
 * else in another.
 */

export const DEFAULT_PER_PAGE = 10

export function readPaging(
  params: Record<string, string | string[] | undefined>,
): { page: number; perPage: number } {
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  const rawPer = Number(str('perPage'))
  // Bounded: an unbounded `?perPage=` from the address bar is a way to ask
  // the database for every row in the restaurant.
  const perPage = Number.isFinite(rawPer) && rawPer > 0 ? Math.min(200, Math.floor(rawPer)) : DEFAULT_PER_PAGE
  const rawPage = Number(str('page'))
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1
  return { page, perPage }
}

/** One page of an already-read list, with the page clamped to what exists. */
export function paginate<T>(rows: T[], page: number, perPage: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / perPage))
  const current = Math.min(page, pageCount)
  return {
    page: current,
    pageCount,
    total: rows.length,
    rows: rows.slice((current - 1) * perPage, current * perPage),
  }
}

/** A link to another page of the same report, keeping every other filter. */
export function pageHref(
  base: string,
  params: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value !== '' && key !== 'page') next.set(key, value)
  }
  if (page > 1) next.set('page', String(page))
  const query = next.toString()
  return query ? `${base}?${query}` : base
}
