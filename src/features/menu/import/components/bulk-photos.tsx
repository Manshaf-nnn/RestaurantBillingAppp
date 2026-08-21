'use client'

import * as React from 'react'
import { ImagePlus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { attachMenuPhotos } from '../actions'
import { callAction } from '@/lib/use-action'

export interface PhotoTarget {
  id: string
  name: string
  categoryName: string
  imageUrl: string | null
}

/** Comparable form of a name: lowercase, no punctuation, no extension. */
function normalise(value: string): string {
  return value
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Match a filename to a menu item.
 *
 * Exact match first, then containment either way — a phone photo named
 * `chicken-kottu-2.jpg` should still find "Chicken Kottu". Anything ambiguous is
 * left unmatched for the owner to assign rather than guessed at, because a photo
 * attached to the wrong dish is worse than no photo.
 */
function guessTarget(filename: string, targets: PhotoTarget[]): PhotoTarget | null {
  const key = normalise(filename)
  if (!key) return null

  const exact = targets.filter((target) => normalise(target.name) === key)
  if (exact.length === 1) return exact[0]

  const partial = targets.filter((target) => {
    const name = normalise(target.name)
    return name.includes(key) || key.includes(name)
  })
  return partial.length === 1 ? partial[0] : null
}

interface Pending {
  file: File
  previewUrl: string
  targetId: string | null
  uploadedUrl?: string
}

export function BulkPhotos({ targets }: { targets: PhotoTarget[] }) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [pending, setPending] = React.useState<Pending[]>([])
  const [busy, setBusy] = React.useState(false)

  React.useEffect(
    () => () => pending.forEach((entry) => URL.revokeObjectURL(entry.previewUrl)),
    [pending],
  )

  const add = (files: FileList) => {
    const next = Array.from(files)
      .filter((file) => file.type.startsWith('image/'))
      .slice(0, 100)
      .map((file) => ({
        file,
        previewUrl: URL.createObjectURL(file),
        targetId: guessTarget(file.name, targets)?.id ?? null,
      }))

    setPending((current) => [...current, ...next])
    const matched = next.filter((entry) => entry.targetId).length
    toast.success(
      `${next.length} photo${next.length === 1 ? '' : 's'} added — ${matched} matched by filename`,
    )
  }

  const save = async () => {
    const ready = pending.filter((entry) => entry.targetId)
    if (!ready.length) {
      toast.error('Assign at least one photo to an item')
      return
    }

    setBusy(true)
    try {
      const matches: Array<{ foodId: string; imageUrl: string }> = []

      for (const entry of ready) {
        const body = new FormData()
        body.append('file', entry.file)
        const response = await fetch('/api/uploads', { method: 'POST', body })
        const data = (await response.json()) as { url?: string; error?: string }
        if (!response.ok || !data.url) {
          toast.error(`${entry.file.name}: ${data.error ?? 'upload failed'}`)
          continue
        }
        matches.push({ foodId: entry.targetId as string, imageUrl: data.url })
      }

      if (!matches.length) return

      const result = await callAction(() => attachMenuPhotos({ matches }))
      if (!result.ok) {
        toast.error(result.error)
        return
      }

      toast.success(`${result.data.attached} photo${result.data.attached === 1 ? '' : 's'} added to your menu`)
      setPending((current) => current.filter((entry) => !entry.targetId))
    } finally {
      setBusy(false)
    }
  }

  const matchedCount = pending.filter((entry) => entry.targetId).length

  return (
    <SectionCard
      title="Add photos in bulk"
      description="Drop in a whole folder. Photos named after the dish are matched for you — fix any that land wrong."
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) add(event.target.files)
          event.target.value = ''
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
          <ImagePlus /> Choose photos
        </Button>
        {pending.length > 0 ? (
          <Button onClick={save} loading={busy} disabled={matchedCount === 0}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Save {matchedCount} photo{matchedCount === 1 ? '' : 's'}
          </Button>
        ) : null}
      </div>

      {targets.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Add your menu items first — then come back and drop the photos in.
        </p>
      ) : null}

      {pending.length > 0 ? (
        <div className="mt-4 grid max-h-[50vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {pending.map((entry, index) => (
            <div key={index} className="flex items-center gap-3 rounded-lg border p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={entry.previewUrl}
                alt=""
                className="size-14 shrink-0 rounded-md object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-muted-foreground">{entry.file.name}</p>
                <Select
                  value={entry.targetId ?? ''}
                  onValueChange={(value) =>
                    setPending((current) =>
                      current.map((row, i) => (i === index ? { ...row, targetId: value } : row)),
                    )
                  }
                >
                  <SelectTrigger className="mt-1 h-8">
                    <SelectValue placeholder="Choose the dish…" />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((target) => (
                      <SelectItem key={target.id} value={target.id}>
                        {target.name}
                        <span className="text-muted-foreground"> · {target.categoryName}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </SectionCard>
  )
}
