import { NextResponse, type NextRequest } from 'next/server'

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
 * Serves an uploaded image stored in Netlify Blobs (see /api/uploads).
 *   GET /api/media/<key>
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params

  // Basic guard: keys are `<timestamp>-<hex>.<ext>`.
  if (!/^[a-z0-9-]+\.[a-z0-9]+$/i.test(key)) {
    return new NextResponse('Not found', { status: 404 })
  }

  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('menu-media')
    const blob = await store.get(key, { type: 'arrayBuffer' })
    if (!blob) return new NextResponse('Not found', { status: 404 })

    const ext = key.split('.').pop()?.toLowerCase() ?? ''
    return new NextResponse(blob, {
      headers: {
        'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }
}
