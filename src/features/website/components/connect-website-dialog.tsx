'use client'

import * as React from 'react'
import { Check, Copy, KeyRound } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import type { PlatformRestaurant } from '@/features/platform/queries'
import { callAction } from '@/lib/use-action'
import {
  checkWebsiteConnectionAction,
  connectWebsiteAction,
  disconnectWebsiteAction,
  setWebsiteUrlAction,
} from '../actions'

/**
 * Connecting a restaurant's own website (websiteconnect.md).
 *
 * ── Written for an owner, not a developer ───────────────────────────────────
 *
 * The person opening this is a platform operator sitting next to — or on the
 * phone with — a restaurant owner who has a web developer somewhere. So the
 * dialog does three things and says which one it is doing: it tells you the
 * state in a sentence, it hands you one block to paste to the developer, and
 * it lets you check whether the developer has done their part. Every id and
 * URL is filled in from the restaurant; there is nothing to type but the
 * website's address, and that is optional.
 *
 * ── The key is shown once ───────────────────────────────────────────────────
 *
 * TableFlow keeps only the hash, so the key appears in this dialog at the
 * moment it is generated and never again. The dialog says so, loudly, and
 * puts the copy button next to it. Closing the dialog is the end of it.
 */
export function ConnectWebsiteDialog({
  restaurant,
  apiUrl,
  docsUrl,
  onClose,
}: {
  restaurant: PlatformRestaurant
  /** `${appUrl}/api/website/v1` — the base every endpoint hangs off. */
  apiUrl: string
  docsUrl: string
  onClose: () => void
}) {
  const website = restaurant.website
  const defaultBranch =
    restaurant.branches.find((branch) => branch.isDefault) ?? restaurant.branches[0] ?? null

  const [websiteUrl, setWebsiteUrl] = React.useState(website?.websiteUrl ?? '')
  const [freshKey, setFreshKey] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null)
  const [confirm, setConfirm] = React.useState<'regenerate' | 'disconnect' | null>(null)
  const [showGuide, setShowGuide] = React.useState(false)

  const state: 'none' | 'waiting' | 'connected' = !website
    ? 'none'
    : website.connectedAt
      ? 'connected'
      : 'waiting'

  const generate = async () => {
    setBusy('generate')
    setResult(null)
    const outcome = await callAction(() =>
      connectWebsiteAction({ restaurantId: restaurant.id, websiteUrl }),
    )
    setBusy(null)
    setConfirm(null)
    if (!outcome.ok) {
      setResult({ ok: false, message: outcome.error })
      return
    }
    setFreshKey(outcome.data.key)
    toast.success(outcome.data.regenerated ? 'New key issued — the old one no longer works' : 'Key issued')
  }

  const saveUrl = async () => {
    setBusy('url')
    setResult(null)
    const outcome = await callAction(() =>
      setWebsiteUrlAction({ restaurantId: restaurant.id, websiteUrl }),
    )
    setBusy(null)
    if (!outcome.ok) setResult({ ok: false, message: outcome.error })
    else toast.success('Website address saved')
  }

  const check = async () => {
    setBusy('check')
    setResult(null)
    const outcome = await callAction(() =>
      checkWebsiteConnectionAction({ restaurantId: restaurant.id }),
    )
    setBusy(null)
    if (!outcome.ok) {
      setResult({ ok: false, message: outcome.error })
      return
    }
    setResult({ ok: outcome.data.connected, message: outcome.data.detail })
  }

  const disconnect = async () => {
    setBusy('disconnect')
    setResult(null)
    const outcome = await callAction(() =>
      disconnectWebsiteAction({ restaurantId: restaurant.id }),
    )
    setBusy(null)
    setConfirm(null)
    if (!outcome.ok) {
      setResult({ ok: false, message: outcome.error })
      return
    }
    setFreshKey(null)
    toast.success('Website disconnected')
  }

  /*
   * The block the developer pastes into their server's environment. Every
   * value is derived from the restaurant; the key is the real one while it is
   * on screen and a placeholder afterwards, because after that TableFlow does
   * not have it either.
   */
  const details = [
    `# TableFlow connection — ${restaurant.name}`,
    `TABLEFLOW_API_URL=${apiUrl}`,
    `TABLEFLOW_RESTAURANT_ID=${restaurant.id}`,
    `TABLEFLOW_BRANCH_ID=${defaultBranch?.id ?? ''}`,
    `TABLEFLOW_API_KEY=${freshKey ?? '<the key shown when it was generated>'}`,
    `# Guide: ${docsUrl}`,
  ].join('\n')

  return (
    <>
      <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{restaurant.name} · connect website</DialogTitle>
            <DialogDescription>
              Their own website shows this restaurant&rsquo;s menu and sends orders straight into
              its kitchen and till. Nothing is typed by hand — everything below is generated from
              the restaurant.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <StatusLine state={state} website={website} />

            {freshKey ? (
              <div className="rounded-lg border border-warning/50 bg-warning/10 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  <KeyRound className="size-3.5" /> Copy this key now — it is not shown again
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  TableFlow keeps only a fingerprint of it. If it is lost, generate a new one; the
                  old one stops working the moment you do.
                </p>
                <CopyRow value={freshKey} label="API key" mono />
              </div>
            ) : null}

            <Field
              label="Website address"
              hint="Optional. Recorded so Test Connection can also check the site is up."
            >
              <div className="flex gap-2">
                <Input
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  placeholder="https://mrchai.lk"
                />
                {website ? (
                  <Button
                    variant="outline"
                    onClick={saveUrl}
                    loading={busy === 'url'}
                    disabled={busy !== null || websiteUrl.trim() === (website.websiteUrl ?? '')}
                  >
                    Save
                  </Button>
                ) : null}
              </div>
            </Field>

            {website ? (
              <div className="rounded-lg border bg-muted/40 p-3">
                <p className="mb-2 text-xs font-medium">Connection details</p>
                <dl className="space-y-1.5 text-xs">
                  <CopyRow label="TableFlow API URL" value={apiUrl} mono />
                  <CopyRow label="Restaurant ID" value={restaurant.id} mono />
                  <CopyRow
                    label="Branch ID"
                    value={defaultBranch?.id ?? ''}
                    mono
                    note={
                      restaurant.branches.length > 1
                        ? `Default branch (${defaultBranch?.name}). The others are listed by GET /connection.`
                        : defaultBranch
                          ? defaultBranch.name
                          : 'No branch yet — add one under Branches first'
                    }
                  />
                  <Row
                    label="API key"
                    value={freshKey ? 'shown above' : `tfk_…${website.keyHint}`}
                    note={
                      freshKey
                        ? undefined
                        : `Issued ${new Date(website.keyIssuedAt).toLocaleDateString()}. Not retrievable — regenerate if lost.`
                    }
                  />
                  <Row
                    label="Webhook URL"
                    value="Not needed"
                    note="The website reads order status from GET /orders/{id}. Nothing has to be reachable on their side."
                  />
                </dl>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                No website is connected. Generate a key, hand the details to their developer, and
                press Test Connection once they have added them.
              </p>
            )}

            <button
              type="button"
              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => setShowGuide((current) => !current)}
            >
              {showGuide ? 'Hide' : 'Show'} what to tell the developer
            </button>
            {showGuide ? <Guide apiUrl={apiUrl} docsUrl={docsUrl} /> : null}

            {result ? (
              <p className={`text-sm ${result.ok ? 'text-success' : 'text-destructive'}`}>
                {result.message}
              </p>
            ) : null}
          </div>

          <DialogFooter className="flex-wrap gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
              Close
            </Button>
            {website ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => copyText(details, 'Details copied — paste them to the developer')}
                  disabled={busy !== null}
                >
                  <Copy className="size-3.5" /> Copy details
                </Button>
                <Button variant="outline" onClick={check} loading={busy === 'check'} disabled={busy !== null && busy !== 'check'}>
                  Test connection
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setConfirm('regenerate')}
                  disabled={busy !== null}
                >
                  Regenerate key
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setConfirm('disconnect')}
                  disabled={busy !== null}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button onClick={generate} loading={busy === 'generate'} disabled={!defaultBranch}>
                <KeyRound className="size-3.5" /> Generate key
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm === 'regenerate'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Issue a new key?"
        description="The website's current key stops working immediately. Their developer will need the new one before the site can show the menu or take orders again."
        confirmLabel="Regenerate"
        destructive
        onConfirm={generate}
      />
      <ConfirmDialog
        open={confirm === 'disconnect'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Disconnect ${restaurant.name}'s website?`}
        description="Its key stops working on the next request. Orders already placed stay exactly where they are. You can connect it again any time with a new key."
        confirmLabel="Disconnect"
        destructive
        onConfirm={disconnect}
      />
    </>
  )
}

function StatusLine({
  state,
  website,
}: {
  state: 'none' | 'waiting' | 'connected'
  website: PlatformRestaurant['website']
}) {
  if (state === 'none') {
    return (
      <p className="flex items-center gap-2 text-sm">
        <Badge variant="outline">Not connected</Badge>
        <span className="text-muted-foreground">No key has been issued for this restaurant.</span>
      </p>
    )
  }
  if (state === 'waiting') {
    return (
      <p className="flex items-center gap-2 text-sm">
        <Badge variant="warning">Waiting for the website</Badge>
        <span className="text-muted-foreground">
          A key exists, but the site has not called TableFlow with it yet.
        </span>
      </p>
    )
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant="success">Connected</Badge>
      <span className="text-muted-foreground">
        Last connected {website?.lastSeenAt ? new Date(website.lastSeenAt).toLocaleString() : '—'}
        {' · '}
        {website?.orderCount ?? 0} order{website?.orderCount === 1 ? '' : 's'} from the website
      </span>
    </p>
  )
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">
        <span className="break-all">{value}</span>
        {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
      </dd>
    </div>
  )
}

function CopyRow({
  label,
  value,
  mono,
  note,
}: {
  label: string
  value: string
  mono?: boolean
  note?: string
}) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-start gap-2">
        <span className={`min-w-0 break-all ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
        {value ? (
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`Copy ${label}`}
            onClick={async () => {
              await copyText(value, `${label} copied`)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        ) : null}
      </dd>
      {note ? <p className="w-full pl-[8.75rem] text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  )
}

/**
 * The instructions, in the order the developer does them. Short on purpose:
 * the full reference is one link away, and a wall of text in a dialog is a
 * wall nobody reads.
 */
function Guide({ apiUrl, docsUrl }: { apiUrl: string; docsUrl: string }) {
  return (
    <ol className="list-decimal space-y-1.5 rounded-lg border bg-muted/30 p-3 pl-7 text-xs">
      <li>
        Put the copied details in the website&rsquo;s <span className="font-mono">.env</span> on the
        server. <strong>Never in browser code</strong> — the key is a password.
      </li>
      <li>
        From the server, call <span className="font-mono">GET {apiUrl}/connection</span> with the
        header <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>. That call is
        what turns this dialog green.
      </li>
      <li>
        Menu: <span className="font-mono">GET /menu?branch=&lt;code&gt;</span> · Orders:{' '}
        <span className="font-mono">POST /orders</span> · Status:{' '}
        <span className="font-mono">GET /orders/&#123;id&#125;</span>. Orders land in the kitchen
        and the till exactly like a QR order.
      </li>
      <li>
        Full reference with examples:{' '}
        <a href={docsUrl} target="_blank" rel="noreferrer" className="text-primary underline">
          {docsUrl}
        </a>
      </li>
    </ol>
  )
}

async function copyText(value: string, message: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(message)
  } catch {
    toast.error('Could not copy — select the text and copy it manually')
  }
}
