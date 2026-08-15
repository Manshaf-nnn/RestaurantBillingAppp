import { NextResponse, type NextRequest } from 'next/server'
import { createHash, randomBytes } from 'node:crypto'

import { requireSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Image repair / import for one restaurant.
 *
 * Uploaded images now live in Postgres (`MediaAsset`), so nothing that is
 * uploaded from here on can be lost by moving Netlify accounts. This endpoint
 * handles the images that pre-date that: it walks every image reference the
 * restaurant owns, pulls each one that is still reachable into the database,
 * and re-points the record at the durable `/api/media/<key>` URL.
 *
 * An image is recoverable when its bytes can still be read from somewhere:
 *   - an absolute http(s) URL (Cloudinary, a pasted link, the old live site)
 *   - Netlify Blobs on the *current* site
 *   - an already-present MediaAsset row (nothing to do)
 *
 * Anything else is genuinely gone — the bytes only ever existed on a Netlify
 * site that no longer belongs to this account — and is reported as `missing`
 * so the owner knows exactly which photos to re-upload.
 *
 * `dryRun` reports what would happen without writing anything.
 */

interface Target {
  label: string
  url: string
  apply: (newUrl: string) => Promise<void>
}

type Outcome = 'ok' | 'imported' | 'missing' | 'skipped'

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin()

    // The admin console posts a plain HTML form; API clients send JSON. Accept both.
    const { restaurantId, dryRun, fromForm } = await readInput(request)

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true, logoUrl: true, coverUrl: true },
    })
    if (!restaurant) {
      return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
    }

    const [foods, categories] = await Promise.all([
      prisma.food.findMany({
        where: { restaurantId, imageUrl: { not: null } },
        select: { id: true, name: true, imageUrl: true },
      }),
      prisma.category.findMany({
        where: { restaurantId, imageUrl: { not: null } },
        select: { id: true, name: true, imageUrl: true },
      }),
    ])

    const targets: Target[] = []

    if (restaurant.logoUrl) {
      targets.push({
        label: 'Restaurant logo',
        url: restaurant.logoUrl,
        apply: async (url) => {
          await prisma.restaurant.update({ where: { id: restaurantId }, data: { logoUrl: url } })
        },
      })
    }
    if (restaurant.coverUrl) {
      targets.push({
        label: 'Restaurant cover',
        url: restaurant.coverUrl,
        apply: async (url) => {
          await prisma.restaurant.update({ where: { id: restaurantId }, data: { coverUrl: url } })
        },
      })
    }
    for (const food of foods) {
      targets.push({
        label: `Menu item — ${food.name}`,
        url: food.imageUrl as string,
        apply: async (url) => {
          await prisma.food.update({ where: { id: food.id }, data: { imageUrl: url } })
          await prisma.restaurantMenuSnapshot.updateMany({
            where: { restaurantId, entityType: 'FOOD', entityId: food.id },
            data: { imageUrl: url },
          })
        },
      })
    }
    for (const category of categories) {
      targets.push({
        label: `Category — ${category.name}`,
        url: category.imageUrl as string,
        apply: async (url) => {
          await prisma.category.update({ where: { id: category.id }, data: { imageUrl: url } })
          await prisma.restaurantMenuSnapshot.updateMany({
            where: { restaurantId, entityType: 'CATEGORY', entityId: category.id },
            data: { imageUrl: url },
          })
        },
      })
    }

    const origin = request.nextUrl.origin
    const results: Array<{ label: string; url: string; status: Outcome; newUrl?: string; error?: string }> = []

    for (const target of targets) {
      try {
        // Already durable — the bytes are in Postgres.
        const existingKey = keyFromMediaUrl(target.url)
        if (existingKey) {
          const present = await prisma.mediaAsset.findUnique({
            where: { key: existingKey },
            select: { id: true },
          })
          if (present) {
            results.push({ label: target.label, url: target.url, status: 'ok' })
            continue
          }
        }

        const bytes = await readBytes(target.url, origin)
        if (!bytes) {
          results.push({ label: target.label, url: target.url, status: 'missing' })
          continue
        }

        if (dryRun) {
          results.push({ label: target.label, url: target.url, status: 'imported' })
          continue
        }

        const newUrl = await storeAsset(restaurantId, bytes.data, bytes.contentType)
        await target.apply(newUrl)
        results.push({ label: target.label, url: target.url, status: 'imported', newUrl })
      } catch (error) {
        results.push({
          label: target.label,
          url: target.url,
          status: 'missing',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const summary = {
      scanned: results.length,
      alreadySafe: results.filter((r) => r.status === 'ok').length,
      imported: results.filter((r) => r.status === 'imported').length,
      missing: results.filter((r) => r.status === 'missing').length,
      dryRun,
    }

    // A browser form post should land back on a page, not on raw JSON.
    if (fromForm) {
      const back = new URL('/admin/media', origin)
      back.searchParams.set('scanned', String(summary.scanned))
      back.searchParams.set('safe', String(summary.alreadySafe))
      back.searchParams.set('imported', String(summary.imported))
      back.searchParams.set('missing', String(summary.missing))
      back.searchParams.set('dryRun', String(dryRun))
      return NextResponse.redirect(back, { status: 303 })
    }

    return NextResponse.json({ ...summary, results })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

async function readInput(
  request: NextRequest,
): Promise<{ restaurantId: string | null; dryRun: boolean; fromForm: boolean }> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('form')) {
    const form = await request.formData()
    return {
      restaurantId: (form.get('restaurantId') as string | null) ?? null,
      // Default to a dry run: a destructive default on a shared admin screen is
      // the wrong way round.
      dryRun: String(form.get('dryRun') ?? 'true') !== 'false',
      fromForm: true,
    }
  }

  const body = (await request.json().catch(() => ({}))) as {
    restaurantId?: string
    dryRun?: boolean
  }
  return {
    restaurantId: body.restaurantId ?? null,
    dryRun: body.dryRun ?? true,
    fromForm: false,
  }
}

/** `/api/media/<key>` → `<key>`, otherwise null. */
function keyFromMediaUrl(url: string): string | null {
  const match = /^\/api\/media\/([a-z0-9-]+\.[a-z0-9]+)$/i.exec(url)
  return match ? match[1] : null
}

/** Read an image's bytes from wherever it currently lives, or null if gone. */
async function readBytes(
  url: string,
  origin: string,
): Promise<{ data: Buffer; contentType: string } | null> {
  // Relative URLs are same-origin; resolve them so fetch() accepts them.
  const absolute = /^https?:\/\//i.test(url) ? url : new URL(url, origin).toString()

  try {
    const response = await fetch(absolute, { redirect: 'follow' })
    if (response.ok) {
      const data = Buffer.from(await response.arrayBuffer())
      const contentType = response.headers.get('content-type') ?? guessType(url)
      if (data.byteLength > 0 && contentType.startsWith('image/')) {
        return { data, contentType }
      }
    }
  } catch {
    // Fall through to the blob store.
  }

  // Netlify Blobs on the current site, for keys uploaded before DB storage.
  const key = keyFromMediaUrl(url)
  if (key) {
    try {
      const { getStore } = await import('@netlify/blobs')
      const store = getStore('menu-media')
      const blob = await store.get(key, { type: 'arrayBuffer' })
      if (blob) return { data: Buffer.from(blob), contentType: guessType(url) }
    } catch {
      // Not recoverable.
    }
  }

  return null
}

function guessType(url: string): string {
  const ext = url.split('.').pop()?.toLowerCase().split('?')[0] ?? ''
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
  }
  return map[ext] ?? 'image/jpeg'
}

/** Write bytes into Postgres and return the stable URL that serves them. */
async function storeAsset(
  restaurantId: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'
  const key = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`
  const checksum = createHash('sha256').update(data).digest('hex')

  await prisma.mediaAsset.create({
    data: {
      restaurantId,
      key,
      contentType,
      size: data.byteLength,
      checksum,
      // Prisma's `Bytes` maps to Uint8Array; a Node Buffer is a subclass whose
      // backing store is typed loosely enough that TypeScript rejects it.
      data: new Uint8Array(data),
    },
  })

  return `/api/media/${key}`
}
