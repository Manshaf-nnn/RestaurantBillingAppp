import { NextResponse, type NextRequest } from 'next/server'

import { prisma } from '@/server/db/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
}

/**
 * Serves an uploaded image.
 *   GET /api/media/<key>
 *
 * Bytes come from Postgres (`MediaAsset`), which is what makes an image survive
 * a redeploy onto a different Netlify account. Keys are content-addressed by
 * upload time and never reused, so the response is marked `immutable` and the
 * CDN serves almost every hit without touching the database.
 *
 * Legacy keys uploaded before images moved into the database are still looked
 * up in Netlify Blobs, so anything that survived on the original site keeps
 * working.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params

  // Keys are `<timestamp>-<hex>.<ext>` — reject anything else before it reaches
  // the database or the blob store.
  if (!/^[a-z0-9-]+\.[a-z0-9]+$/i.test(key)) {
    return new NextResponse('Not found', { status: 404 })
  }

  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  const fallbackType = CONTENT_TYPES[ext] ?? 'application/octet-stream'

  try {
    const asset = await prisma.mediaAsset.findUnique({
      where: { key },
      select: { data: true, contentType: true, checksum: true },
    })

    if (asset) {
      const etag = `"${asset.checksum}"`
      // Conditional request — the browser already holds this exact image.
      if (request.headers.get('if-none-match') === etag) {
        return new NextResponse(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' },
        })
      }

      const body = new Uint8Array(asset.data)
      return new NextResponse(body, {
        headers: {
          'Content-Type': asset.contentType || fallbackType,
          'Content-Length': String(body.byteLength),
          ETag: etag,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }
  } catch {
    // Fall through to the legacy blob lookup rather than failing the request.
  }

  // Legacy: images uploaded to Netlify Blobs before database storage existed.
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('menu-media')
    const blob = await store.get(key, { type: 'arrayBuffer' })
    if (!blob) return new NextResponse('Not found', { status: 404 })

    return new NextResponse(blob, {
      headers: {
        'Content-Type': fallbackType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }
}
