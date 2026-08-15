import { NextResponse, type NextRequest } from 'next/server'
import { createHash, randomBytes } from 'node:crypto'

import { toAppError } from '@/lib/errors'
import { isCloudinaryConfigured } from '@/lib/env'
import { requireTenantUser } from '@/server/auth/guard'
import { enforceRateLimit } from '@/server/security/rate-limit'
import { prisma } from '@/server/db/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const ALLOWED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

/**
 * Authenticated image upload for menu photos, logos and covers.
 *   POST /api/uploads  (multipart/form-data, field "file")
 *
 * The bytes are written to Postgres (`MediaAsset`) and the caller always gets
 * back a stable `/api/media/<key>` URL.
 *
 * Why the database and not the filesystem or Netlify Blobs: both of those are
 * scoped to a single Netlify site. Redeploying onto a different Netlify account
 * — which is exactly what happens when a free-tier build limit is hit — leaves
 * the database pointing at images that no longer exist anywhere. Postgres moves
 * with the data, so images uploaded once are never lost again.
 *
 * Cloudinary, when configured, is used as a pure CDN mirror. The returned URL
 * still points at us, so swapping or losing the CDN account changes delivery
 * speed and nothing else.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireTenantUser()
    await enforceRateLimit('upload')

    const form = await request.formData()
    const file = form.get('file')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file was uploaded', code: 'NO_FILE' }, { status: 400 })
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'The file is empty', code: 'EMPTY' }, { status: 400 })
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Image must be 5 MB or smaller', code: 'TOO_LARGE' }, { status: 400 })
    }

    const ext = ALLOWED[file.type]
    if (!ext) {
      return NextResponse.json(
        { error: 'Only JPG, PNG, WEBP, GIF or AVIF images are allowed', code: 'BAD_TYPE' },
        { status: 400 },
      )
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    const key = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const url = `/api/media/${key}`

    // The durable write. If this fails the upload fails — silently returning a
    // URL we cannot serve later is worse than asking the user to retry now.
    await prisma.mediaAsset.create({
      data: {
        restaurantId: user.restaurantId,
        key,
        contentType: file.type,
        size: bytes.byteLength,
        checksum,
        // Prisma's `Bytes` maps to Uint8Array.
        data: new Uint8Array(bytes),
      },
    })

    // Best-effort CDN mirror — never fatal, the image is already safe.
    if (isCloudinaryConfigured()) {
      try {
        const cdnUrl = await uploadToCloudinary(bytes)
        await prisma.mediaAsset.update({ where: { key }, data: { cdnUrl } })
      } catch {
        // Delivery falls back to serving the bytes straight from Postgres.
      }
    }

    // Keep the upload ledger the admin console reads.
    try {
      await prisma.mediaBackup.create({
        data: {
          restaurantId: user.restaurantId,
          key,
          originalUrl: url,
          backupUrl: url,
          contentType: file.type,
          size: bytes.byteLength,
        },
      })
    } catch {
      // Non-fatal: the ledger is a convenience, MediaAsset is the source of truth.
    }

    return NextResponse.json({ url })
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}

async function uploadToCloudinary(bytes: Buffer): Promise<string> {
  const { v2: cloudinary } = await import('cloudinary')
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  })

  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { folder: 'restaurantos', resource_type: 'image', transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
        (error, result) => {
          if (error || !result) reject(error ?? new Error('Upload failed'))
          else resolve(result.secure_url)
        },
      )
      .end(bytes)
  })
}
