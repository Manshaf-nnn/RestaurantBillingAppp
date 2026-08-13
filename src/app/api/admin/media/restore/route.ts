import { NextResponse, type NextRequest } from 'next/server'

import { requireSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function uploadToCloudinaryFromUrl(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to fetch source')
  const arrayBuffer = await res.arrayBuffer()
  const bytes = Buffer.from(arrayBuffer)

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
        { folder: 'restaurantos-restores', resource_type: 'image', transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
        (error, result) => {
          if (error || !result) reject(error ?? new Error('Upload failed'))
          else resolve(result.secure_url)
        },
      )
      .end(bytes)
  })
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin()
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return NextResponse.json({ error: 'Cloudinary not configured' }, { status: 400 })
    }

    let restaurantId: string | undefined
    let dryRun = false
    const ct = request.headers.get('content-type') || ''
    if (ct.includes('application/json')) {
      const body = await request.json()
      restaurantId = body.restaurantId
      dryRun = Boolean(body.dryRun)
    } else {
      const form = await request.formData()
      restaurantId = form.get('restaurantId') as string | undefined
      dryRun = String(form.get('dryRun') ?? '') === 'true'
    }
    if (!restaurantId) return NextResponse.json({ error: 'restaurantId required' }, { status: 400 })

    const backups = await (prisma as any).mediaBackup.findMany({ where: { restaurantId } })
    const results: Array<{ id: string; original: string; restored?: string; updated: number; error?: string }> = []

    for (const b of backups) {
      try {
        const source = b.backupUrl ?? b.originalUrl
        const newUrl = await uploadToCloudinaryFromUrl(source)
        let updated = 0
        if (!dryRun) {
          const [f1, f2, r1, oi] = await Promise.all([
            prisma.food.updateMany({ where: { restaurantId, imageUrl: b.originalUrl }, data: { imageUrl: newUrl } }),
            prisma.category.updateMany({ where: { restaurantId, imageUrl: b.originalUrl }, data: { imageUrl: newUrl } }),
            prisma.restaurant.updateMany({ where: { id: restaurantId, logoUrl: b.originalUrl }, data: { logoUrl: newUrl } }),
            prisma.orderItem.updateMany({ where: { imageUrl: b.originalUrl }, data: { imageUrl: newUrl } }),
          ])
          updated = f1.count + f2.count + r1.count + oi.count
          // persist new backupUrl too
          await (prisma as any).mediaBackup.update({ where: { id: b.id }, data: { backupUrl: newUrl } })
        }
        results.push({ id: b.id, original: b.originalUrl, restored: newUrl, updated })
      } catch (err: any) {
        results.push({ id: b.id, original: b.originalUrl, updated: 0, error: String(err?.message ?? err) })
      }
    }

    return NextResponse.json({ count: backups.length, results })
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
