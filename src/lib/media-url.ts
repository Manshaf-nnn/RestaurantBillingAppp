import { z } from 'zod'

/**
 * Zod field for an image reference. Accepts:
 *   - an absolute http(s) URL (pasted by the user), or
 *   - a same-origin relative path from our own uploader
 *     (`/api/media/…` on serverless, `/uploads/…` on disk), or
 *   - an empty string.
 *
 * `z.string().url()` rejects relative paths, which broke saving any image that
 * was uploaded (rather than pasted) — this is the shared fix.
 */
export const imageUrlField = () =>
  z
    .string()
    .max(2048)
    .refine(
      (value) => value === '' || /^https?:\/\//i.test(value) || value.startsWith('/'),
      'Enter a valid image URL',
    )
    .optional()
    .or(z.literal(''))
