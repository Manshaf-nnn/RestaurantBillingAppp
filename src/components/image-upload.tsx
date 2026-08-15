'use client'

import * as React from 'react'
import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** Longest edge kept after compression — plenty for a full-width phone photo. */
const MAX_EDGE = 1600
const WEBP_QUALITY = 0.82

/**
 * Shrink a photo in the browser before it is uploaded.
 *
 * Menu photos come straight from a phone camera at 3–8 MB, which is slow to
 * upload on restaurant wifi, heavy to store, and slow for guests to download
 * over mobile data. Re-encoding to WebP at a sane size typically cuts that to
 * 80–200 KB with no visible difference at the sizes we actually render.
 *
 * Anything unexpected (an unsupported codec, a browser without WebP encoding,
 * a result that came out *larger*) falls back to the original file — the upload
 * must not fail just because the optimisation did.
 */
async function compressImage(file: File): Promise<File> {
  // Animated GIFs lose their animation through a canvas, so leave them alone.
  if (file.type === 'image/gif') return file

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return file
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY),
    )
    if (!blob || blob.size >= file.size) return file

    const name = file.name.replace(/\.[^.]+$/, '') || 'image'
    return new File([blob], `${name}.webp`, { type: 'image/webp' })
  } catch {
    return file
  }
}

/**
 * Uploads an image to `/api/uploads` and returns the resulting URL. Falls back
 * to pasting a URL directly, so it works whether or not Cloudinary is set up.
 */
export function ImageUpload({
  value,
  onChange,
  className,
  aspect = 'video',
  allowUrl = true,
}: {
  value: string
  onChange: (url: string) => void
  className?: string
  aspect?: 'video' | 'square'
  allowUrl?: boolean
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)

  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file')
      return
    }
    setUploading(true)
    try {
      const optimised = await compressImage(file)
      const body = new FormData()
      body.append('file', optimised)
      const response = await fetch('/api/uploads', { method: 'POST', body })
      const data = (await response.json()) as { url?: string; error?: string }
      if (!response.ok || !data.url) {
        toast.error(data.error ?? 'Upload failed')
        return
      }
      onChange(data.url)
      toast.success('Image uploaded')
    } catch {
      toast.error('Upload failed — check your connection')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files?.[0]
          if (file) void upload(file)
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        className={cn(
          'relative flex cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed transition-colors',
          aspect === 'video' ? 'aspect-video' : 'aspect-square',
          dragging ? 'border-primary bg-primary/5' : 'hover:border-primary/50 hover:bg-muted/40',
        )}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="Uploaded preview" className="size-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-1.5 p-4 text-center text-muted-foreground">
            <ImagePlus className="size-7" />
            <span className="text-sm font-medium">Click or drag an image here</span>
            <span className="text-xs">JPG, PNG or WEBP · up to 5 MB</span>
          </div>
        )}

        {uploading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : null}

        {value && !uploading ? (
          <Button
            type="button"
            variant="destructive"
            size="icon-sm"
            className="absolute right-2 top-2"
            onClick={(event) => {
              event.stopPropagation()
              onChange('')
            }}
            aria-label="Remove image"
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void upload(file)
            event.target.value = ''
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={uploading}>
          <Upload /> {value ? 'Replace' : 'Upload'}
        </Button>
        {allowUrl ? (
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="…or paste an image URL"
            className="flex-1"
          />
        ) : null}
      </div>
    </div>
  )
}
