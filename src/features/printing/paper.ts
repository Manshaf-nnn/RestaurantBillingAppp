/**
 * Thermal paper sizing — shared by server and client.
 *
 * Deliberately not in `print.ts`: that module is `'use client'` because it
 * drives the browser's print pipeline, and a server component calling into it
 * throws ("attempted to call ... from the server"). Pages need to read the
 * configured width while rendering on the server, so the pure data lives here.
 */

/** The two standard thermal roll widths, in millimetres. */
export type PaperWidth = 58 | 80

/** Used when a restaurant has not chosen a paper size yet. */
export const DEFAULT_PAPER: { receipt: PaperWidth; kitchen: PaperWidth } = {
  receipt: 58,
  kitchen: 80,
}

/**
 * Reads the widths a restaurant configured in Settings.
 *
 * `Restaurant.printerConfig` is free-form JSON, so anything unrecognised falls
 * back to the defaults rather than printing at a nonsense size.
 */
export function readPaperWidths(config: unknown): { receipt: PaperWidth; kitchen: PaperWidth } {
  const parse = (value: unknown, fallback: PaperWidth): PaperWidth =>
    value === 58 || value === 80 ? value : fallback

  if (!config || typeof config !== 'object') return DEFAULT_PAPER
  const record = config as Record<string, { width?: unknown } | undefined>

  return {
    receipt: parse(record.receipt?.width, DEFAULT_PAPER.receipt),
    kitchen: parse(record.kitchen?.width, DEFAULT_PAPER.kitchen),
  }
}
