import { NextResponse, type NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { toAppError } from '@/lib/errors'
import { isCloudinaryConfigured } from '@/lib/env'
import { requireTenantUser } from '@/server/auth/guard'
import { enforceRateLimit } from '@/server/security/rate-limit'

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
 * Uploads to Cloudinary when configured; otherwise writes to
 * `public/uploads` on the server's disk. Returns `{ url }`.
 */
export async function POST(request: NextRequest) {
  try {
    // Only signed-in restaurant staff may upload.
    await requireTenantUser()
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

    if (isCloudinaryConfigured()) {
      const url = await uploadToCloudinary(bytes)
      return NextResponse.json({ url })
    }

    // Local disk fallback — persistent on a VPS, served by Next from /public.
    const filename = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`
    const dir = join(process.cwd(), 'public', 'uploads')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, filename), bytes)

    return NextResponse.json({ url: `/uploads/${filename}` })
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
