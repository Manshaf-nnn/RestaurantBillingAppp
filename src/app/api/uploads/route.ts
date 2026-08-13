import { NextResponse, type NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
 * Storage, in order of preference:
 *   1. Cloudinary            (if CLOUDINARY_* env is set)
 *   2. Netlify Blobs         (when running on Netlify — its disk is read-only)
 *   3. Local disk /public    (local dev / a normal VPS)
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

    const arrayBuffer = await file.arrayBuffer()
    const bytes = Buffer.from(arrayBuffer)
    const key = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`

    if (isCloudinaryConfigured()) {
      const url = await uploadToCloudinary(bytes)
      try {
        await (prisma as any).mediaBackup.create({
          data: {
            restaurantId: user.restaurantId,
            key,
            originalUrl: url,
            backupUrl: url,
            contentType: file.type,
            size: file.size,
          },
        })
      } catch (e) {
        // non-fatal: do not break uploads if backup record fails
      }
      return NextResponse.json({ url })
    }

    if (isNetlify()) {
      const { getStore } = await import('@netlify/blobs')
      const store = getStore('menu-media')
      await store.set(key, arrayBuffer, { metadata: { contentType: file.type } })
      // Served back by /api/media/[key].
      try {
        await (prisma as any).mediaBackup.create({
          data: {
            restaurantId: user.restaurantId,
            key,
            originalUrl: `/api/media/${key}`,
            contentType: file.type,
            size: file.size,
          },
        })
      } catch (e) {
        // ignore
      }
      return NextResponse.json({ url: `/api/media/${key}` })
    }

    // Local disk fallback (dev / VPS).
    const dir = join(process.cwd(), 'public', 'uploads')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, key), bytes)
    try {
      await (prisma as any).mediaBackup.create({
        data: {
          restaurantId: user.restaurantId,
          key,
          originalUrl: `/uploads/${key}`,
          contentType: file.type,
          size: file.size,
        },
      })
    } catch (e) {
      // ignore
    }
    return NextResponse.json({ url: `/uploads/${key}` })
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}

function isNetlify(): boolean {
  return Boolean(process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.NETLIFY_DEV)
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
