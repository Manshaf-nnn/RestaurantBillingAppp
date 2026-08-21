'use client'

import * as React from 'react'
import Image from 'next/image'
import { Copy, Download, ExternalLink, Printer, QrCode } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'

export interface BranchQr {
  id: string
  name: string
  code: string
  isDefault: boolean
  url: string
  qr: string
  tables: Array<{ id: string; number: string; label: string | null; url: string; qr: string }>
}

/**
 * The codes guests scan.
 *
 * The restaurant-wide code is kept — it still works, still resolves to the
 * default branch, and for a single-site restaurant it is the only one that
 * matters. What is new is a code per branch and per table beneath it.
 *
 * A table code is worth the printing because it settles two facts at once,
 * which the old "scan, then type your table number" flow left to the guest:
 * which branch, and which table. Get either wrong and the order reaches the
 * wrong kitchen or the bill reaches the wrong table.
 */
export function QrPoster({
  restaurantName,
  orderUrl,
  qrDataUrl,
  branches = [],
}: {
  restaurantName: string
  orderUrl: string
  qrDataUrl: string
  branches?: BranchQr[]
}) {
  const printRef = React.useRef<HTMLDivElement>(null)

  const printPoster = () => {
    const win = window.open('', '_blank', 'width=800,height=1000')
    if (!win) return
    win.document.write(`<!doctype html><html><head><title>${restaurantName} — Scan to order</title>
      <style>
        body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
        .poster{text-align:center;padding:48px;max-width:520px}
        .poster h1{font-size:34px;margin:0 0 4px}
        .poster p{color:#555;font-size:18px;margin:0 0 28px}
        .poster img{width:340px;height:340px;border:1px solid #eee;border-radius:20px;padding:16px}
        .steps{margin-top:28px;font-size:17px;color:#333;line-height:2}
        .brand{margin-top:32px;color:#999;font-size:13px}
      </style></head><body>
      <div class="poster">
        <h1>${restaurantName}</h1>
        <p>Scan to view the menu & order</p>
        <img src="${qrDataUrl}" alt="QR code" />
        <div class="steps">1. Scan this code &nbsp;·&nbsp; 2. Enter your table number &nbsp;·&nbsp; 3. Order</div>
        <div class="brand">Powered by TableFlow</div>
      </div>
      <script>window.onload=function(){window.print()}</script>
      </body></html>`)
    win.document.close()
  }

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success('Link copied')
    } catch {
      // Clipboard access is refused over plain http and in some embedded
      // browsers; saying so beats a button that appears to do nothing.
      toast.error('Could not copy — select the link and copy it by hand')
    }
  }

  /**
   * A print sheet of table cards for one branch.
   *
   * Opened as its own window with self-contained markup, matching how
   * `printPoster` already works — a print stylesheet on the dashboard would
   * have to fight the sidebar, the header and the glass chrome for the page.
   */
  const printBranch = (branch: BranchQr) => {
    const win = window.open('', '_blank', 'width=900,height=1100')
    if (!win) return

    const cards = branch.tables.length
      ? branch.tables
          .map(
            (table) => `
              <figure class="card">
                <img src="${table.qr}" alt="" />
                <figcaption>
                  <strong>${table.label ?? `Table ${table.number}`}</strong>
                  <span>${branch.name}</span>
                </figcaption>
              </figure>`,
          )
          .join('')
      : `<figure class="card">
           <img src="${branch.qr}" alt="" />
           <figcaption><strong>${branch.name}</strong><span>Scan to order</span></figcaption>
         </figure>`

    win.document.write(`
      <html>
        <head>
          <title>${restaurantName} — ${branch.name}</title>
          <style>
            @page { margin: 12mm; }
            body { font-family: system-ui, sans-serif; margin: 0; }
            h1 { font-size: 18px; margin: 0 0 4px; }
            p.sub { margin: 0 0 16px; color: #666; font-size: 12px; }
            .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
            .card {
              margin: 0; border: 1px solid #ddd; border-radius: 10px;
              padding: 10px; text-align: center; break-inside: avoid;
            }
            .card img { width: 100%; height: auto; }
            figcaption { margin-top: 6px; font-size: 12px; }
            figcaption strong { display: block; }
            figcaption span { color: #666; font-size: 10px; }
          </style>
        </head>
        <body>
          <h1>${restaurantName} — ${branch.name}</h1>
          <p class="sub">Scan to see this location's menu and order. The table is already set.</p>
          <div class="grid">${cards}</div>
        </body>
      </html>
    `)
    win.document.close()
    win.focus()
    win.print()
  }

  const download = () => {
    const link = document.createElement('a')
    link.href = qrDataUrl
    link.download = `${restaurantName.toLowerCase().replace(/\s+/g, '-')}-qr.png`
    link.click()
  }

  return (
    <>
      <PageHeader
        title={branches.length > 1 ? 'QR codes' : 'QR code'}
        description={
          branches.length > 1
            ? 'One code per location, and one per table. A table code opens that location’s menu with the table already set.'
            : 'One code for the whole restaurant — guests enter their table number after scanning'
        }
        actions={
          <>
            <Button variant="outline" onClick={download}>
              <Download /> PNG
            </Button>
            <Button onClick={printPoster}>
              <Printer /> Print poster
            </Button>
          </>
        }
      />

      {/*
        `min-w-0` on both columns.
        A grid item defaults to `min-width: auto`, meaning it refuses to shrink
        below its content's intrinsic width. The ordering URL is one long
        unbreakable token, so it set the column's minimum — and therefore the
        page's — well past a phone's width, no matter that the <code> element
        itself truncates. Every card on the page inherited that width and the
        whole page scrolled sideways.
      */}
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Your QR code" className="min-w-0">
          <div ref={printRef} className="flex flex-col items-center gap-4 py-4">
            {/*
              The QR renders at 280 px, but that plus the card padding is wider
              than a phone, and a fixed-width child sets the grid column's
              min-content width — which pushed the whole page sideways. Cap it to
              the available width and let it scale down instead.
            */}
            <div className="w-full max-w-[312px] rounded-2xl border bg-white p-4 shadow-soft">
              <Image
                src={qrDataUrl}
                alt="Restaurant QR code"
                width={280}
                height={280}
                unoptimized
                className="h-auto w-full"
              />
            </div>
            <p className="text-center text-sm font-medium">{restaurantName}</p>
          </div>
        </SectionCard>

        <div className="min-w-0 space-y-5">
          <SectionCard title="Ordering link">
            <p className="mb-2 text-sm text-muted-foreground">
              This is the address the QR code opens. Print it, or share it directly.
            </p>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-sm">{orderUrl}</code>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  void navigator.clipboard.writeText(orderUrl)
                  toast.success('Link copied')
                }}
                aria-label="Copy link"
              >
                <Copy />
              </Button>
              <Button variant="ghost" size="icon-sm" asChild aria-label="Open link">
                <a href={orderUrl} target="_blank" rel="noreferrer">
                  <ExternalLink />
                </a>
              </Button>
            </div>
          </SectionCard>

          <SectionCard title="How it works">
            <ol className="space-y-3 text-sm">
              {[
                'Print the poster and place it on every table (or at the entrance).',
                'A guest scans the code with their phone camera — no app needed.',
                'They enter their table number, which the system validates.',
                'They browse the menu, order, and track it live. You get it in the kitchen instantly.',
              ].map((step, index) => (
                <li key={index} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                    {index + 1}
                  </span>
                  <span className="text-muted-foreground">{step}</span>
                </li>
              ))}
            </ol>
          </SectionCard>
        </div>
      </div>

      {/* ── one code per location, and per table ─────────────────── */}
      {branches.length > 1 ? (
        <div className="mt-6 space-y-5">
          {branches.map((branch) => (
            <SectionCard
              key={branch.id}
              title={branch.name}
              description={`Scanning any of these opens ${branch.name}'s menu at ${branch.name}'s prices.`}
              actions={
                <Button variant="outline" size="sm" onClick={() => printBranch(branch)}>
                  <Printer /> Print {branch.tables.length ? 'table cards' : 'poster'}
                </Button>
              }
            >
              <div className="flex flex-wrap items-start gap-4">
                <figure className="w-40 shrink-0 text-center">
                  <Image
                    src={branch.qr}
                    alt={`QR code for ${branch.name}`}
                    width={160}
                    height={160}
                    className="rounded-lg border border-border bg-white p-2"
                    unoptimized
                  />
                  <figcaption className="mt-1.5 text-xs font-medium">
                    {branch.name}
                    {branch.isDefault ? ' · default' : ''}
                  </figcaption>
                  <button
                    type="button"
                    onClick={() => copy(branch.url)}
                    className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Copy link
                  </button>
                </figure>

                {branch.tables.length === 0 ? (
                  <p className="flex-1 text-sm text-muted-foreground">
                    No tables here yet. Add some on the Tables screen and each gets its own code,
                    so guests never have to type a number.
                  </p>
                ) : (
                  <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-3">
                    {branch.tables.map((table) => (
                      <figure key={table.id} className="text-center">
                        <Image
                          src={table.qr}
                          alt={`QR code for table ${table.number}`}
                          width={104}
                          height={104}
                          className="w-full rounded-lg border border-border bg-white p-1.5"
                          unoptimized
                        />
                        <figcaption className="mt-1 truncate text-xs">
                          {table.label ?? `Table ${table.number}`}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                )}
              </div>
            </SectionCard>
          ))}
        </div>
      ) : null}
    </>
  )
}
