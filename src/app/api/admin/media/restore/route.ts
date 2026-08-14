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
    // only super-admins may run restores
    await requireSuperAdmin()

    const body = await request.json().catch(() => ({})) as { restaurantId?: string; dryRun?: boolean }
    const restaurantId = body.restaurantId
    const dryRun = body.dryRun ?? true

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }

    const backups = await prisma.mediaBackup.findMany({ where: { restaurantId } })
    const results: Array<Record<string, any>> = []

    for (const b of backups) {
      try {
        const source = b.backupUrl ?? b.originalUrl
        let newUrl: string | null = null

        // find any synced snapshots that reference this original URL
        const snaps = await prisma.restaurantMenuSnapshot.findMany({ where: { restaurantId: b.restaurantId, imageUrl: b.originalUrl } })

        // Dry-run: do not upload; just report what would be done
        if (dryRun) {
          newUrl = b.backupUrl ?? b.originalUrl
          const wouldUpdate = snaps.length
          results.push({ id: b.id, original: b.originalUrl, restored: newUrl, updated: wouldUpdate })
          continue
        }

        // Real restore: upload source to Cloudinary and update tenant rows using snapshots
        newUrl = await uploadToCloudinaryFromUrl(source)

        let updated = 0
        // Update by snapshot entity mapping — more reliable than matching by URL only
        for (const s of snaps) {
          if (s.entityType === 'FOOD') {
            const res = await prisma.food.updateMany({ where: { id: s.entityId }, data: { imageUrl: newUrl } })
            updated += res.count
          } else if (s.entityType === 'CATEGORY') {
            const res = await prisma.category.updateMany({ where: { id: s.entityId }, data: { imageUrl: newUrl } })
            updated += res.count
          }
        }

        // Also update any restaurant logo that matches the original URL
        const r = await prisma.restaurant.updateMany({ where: { id: b.restaurantId, logoUrl: b.originalUrl }, data: { logoUrl: newUrl } })
        updated += r.count

        // As a fallback, update order items that still reference the exact URL
        const oi = await prisma.orderItem.updateMany({ where: { imageUrl: b.originalUrl }, data: { imageUrl: newUrl } })
        updated += oi.count

        // Refresh the snapshot rows so admin UI reflects the new image URL
        await prisma.restaurantMenuSnapshot.updateMany({ where: { restaurantId: b.restaurantId, imageUrl: b.originalUrl }, data: { imageUrl: newUrl } })

        // persist new backupUrl
        await prisma.mediaBackup.update({ where: { id: b.id }, data: { backupUrl: newUrl } })

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
