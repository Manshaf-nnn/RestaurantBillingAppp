'use client'

import * as React from 'react'
import Image from 'next/image'
import { Copy, Download, ExternalLink, Printer, QrCode } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'

/**
 * The one QR code for the whole restaurant.
 *
 * A single code deep-links to `/order?r=<slug>`; guests enter their table
 * number on the landing screen. No per-table codes to print or reprint.
 */
export function QrPoster({
  restaurantName,
  orderUrl,
  qrDataUrl,
}: {
  restaurantName: string
  orderUrl: string
  qrDataUrl: string
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
        <div class="brand">Powered by RestaurantOS</div>
      </div>
      <script>window.onload=function(){window.print()}</script>
      </body></html>`)
    win.document.close()
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
        title="QR code"
        description="One code for the whole restaurant — guests enter their table number after scanning"
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

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Your QR code">
          <div ref={printRef} className="flex flex-col items-center gap-4 py-4">
            <div className="rounded-2xl border bg-white p-4 shadow-soft">
              <Image src={qrDataUrl} alt="Restaurant QR code" width={280} height={280} unoptimized />
            </div>
            <p className="text-center text-sm font-medium">{restaurantName}</p>
          </div>
        </SectionCard>

        <div className="space-y-5">
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
    </>
  )
}
