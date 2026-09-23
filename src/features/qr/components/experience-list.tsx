'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Copy, Eye, Plus, QrCode, ScanLine } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { createQrExperience, setQrExperienceActive } from '../actions'
import { qrPath } from '../guest-path'
import type { ExperienceRow } from '../queries'

/**
 * The list, and the one-field way to make another (ar.md §18, §21).
 *
 * Creating asks for a name, a location and whether it takes orders — nothing
 * else. Everything an owner might want to change afterwards is on the code's
 * own page, and every one of those has a default that reproduces the existing
 * QR behaviour. That is the spec's "Create QR → choose branch → generate"
 * taken literally.
 */
export function ExperienceList({
  rows,
  branches,
  origin,
  currency,
  locale,
  canManage,
}: {
  rows: ExperienceRow[]
  branches: Array<{ id: string; name: string }>
  origin: string
  currency: string
  locale: string
  canManage: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [name, setName] = React.useState('')
  const [branchId, setBranchId] = React.useState(branches[0]?.id ?? '')
  const [type, setType] = React.useState<'ORDERING' | 'MENU_ONLY'>('ORDERING')

  const linkFor = (publicId: string) => `${origin}${qrPath(publicId)}`

  const copy = async (publicId: string) => {
    try {
      await navigator.clipboard.writeText(linkFor(publicId))
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy — long-press the link to copy it by hand')
    }
  }

  const create = async () => {
    if (!name.trim() || !branchId) return
    setBusy(true)
    const result = await callAction(() => createQrExperience({ name, branchId, type }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setOpen(false)
    setName('')
    toast.success('QR menu created — now choose what it shows')
    router.push(`/dashboard/qr/experiences/${result.data.id}`)
  }

  const toggle = async (row: ExperienceRow) => {
    const result = await callAction(() =>
      setQrExperienceActive({ experienceId: row.id, isActive: !row.isActive }),
    )
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.data.isActive
        ? `${row.name} is live again`
        : `${row.name} is switched off — the printed code stops working`,
    )
    router.refresh()
  }

  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex justify-end">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button disabled={branches.length === 0}>
                <Plus /> New QR menu
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New QR menu</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="qr-name">Name it</Label>
                  <Input
                    id="qr-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Student menu, Table cards, Window poster…"
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    Only you see this. Guests see your restaurant’s name.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qr-branch">Location</Label>
                  <select
                    id="qr-branch"
                    className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                    value={branchId}
                    onChange={(event) => setBranchId(event.target.value)}
                  >
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>{branch.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>What is it for?</Label>
                  <div className="grid gap-2">
                    <Choice
                      checked={type === 'ORDERING'}
                      onChange={() => setType('ORDERING')}
                      title="Taking orders"
                      hint="The normal table QR — browse, order, track."
                    />
                    <Choice
                      checked={type === 'MENU_ONLY'}
                      onChange={() => setType('MENU_ONLY')}
                      title="Menu only"
                      hint="For a window or a takeaway counter. Nothing can be ordered and no table is taken."
                    />
                  </div>
                </div>
                <Button className="w-full" onClick={create} disabled={!name.trim() || !branchId} loading={busy}>
                  Create
                </Button>
                <p className="text-xs text-muted-foreground">
                  It works straight away. You can change what it shows and what it asks afterwards.
                </p>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<ScanLine className="size-8" />}
          title="No QR menus yet"
          description="Your ordinary table QR codes still work. Make one of these when you want a code that shows a different menu, or asks a guest who they are."
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Opens</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} data-state={row.isActive ? 'active' : 'off'}>
                  <TableCell>
                    <Link href={`/dashboard/qr/experiences/${row.id}`} className="font-medium hover:underline">
                      {row.name}
                    </Link>
                    {row.description ? (
                      <span className="block text-xs text-muted-foreground">{row.description}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" size="sm">
                      {row.type === 'MENU_ONLY' ? 'Menu only' : 'Ordering'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.branchName}</TableCell>
                  <TableCell>
                    <Badge variant={row.isActive ? 'success' : 'secondary'} size="sm">
                      {row.isActive ? 'Live' : 'Off'}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    <LocalDateTime value={row.createdAt} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{row.openCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.orderCount}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.salesTotal, currency, locale)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => copy(row.publicId)} aria-label={`Copy the link for ${row.name}`}>
                        <Copy />
                      </Button>
                      <Button variant="ghost" size="icon-sm" asChild aria-label={`Preview ${row.name}`}>
                        <a href={`${qrPath(row.publicId)}?preview=1`} target="_blank" rel="noreferrer">
                          <Eye />
                        </a>
                      </Button>
                      <Button variant="ghost" size="icon-sm" asChild aria-label={`Open ${row.name}`}>
                        <Link href={`/dashboard/qr/experiences/${row.id}`}>
                          <QrCode />
                        </Link>
                      </Button>
                      {canManage ? (
                        <Button variant="outline" size="sm" onClick={() => toggle(row)}>
                          {row.isActive ? 'Switch off' : 'Switch on'}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function Choice({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean
  onChange: () => void
  title: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      aria-pressed={checked}
      className={`rounded-xl border p-3 text-left transition-colors ${
        checked ? 'border-primary bg-primary/5' : 'hover:bg-muted'
      }`}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
    </button>
  )
}
