'use client'

/**
 * Browser printing for kitchen tickets and thermal receipts.
 *
 * Rather than depend on a native driver, we render an isolated document in a
 * hidden iframe sized for 58 mm or 80 mm paper and hand it to the browser's
 * print pipeline. That works with every thermal printer exposed through the
 * operating system, and degrades to "save as PDF" anywhere else.
 */

export type PaperWidth = 58 | 80

interface TicketItem {
  name: string
  quantity: number
  optionsLabel?: string
  notes?: string | null
}

interface TicketInput {
  orderNumber: string
  tableNumber: string | null
  customerName: string
  placedAt: string
  notes?: string | null
  items: TicketItem[]
}

interface ReceiptLine {
  name: string
  optionsLabel?: string
  quantity: number
  lineTotal: string
}

interface ReceiptInput {
  restaurantName: string
  addressLine?: string | null
  phone?: string | null
  orderNumber: string
  invoiceNumber?: string | null
  tableNumber: string | null
  customerName: string
  placedAt: string
  lines: ReceiptLine[]
  totals: Array<{ label: string; value: string; strong?: boolean }>
  footer?: string
  paymentMethod?: string | null
}

const BASE_STYLES = (width: PaperWidth) => `
  @page { size: ${width}mm auto; margin: 3mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    width: ${width}mm;
    font-family: ui-monospace, 'Courier New', monospace;
    font-size: ${width === 58 ? 11 : 12}px;
    line-height: 1.4;
    color: #000;
    -webkit-print-color-adjust: exact;
  }
  h1 { font-size: ${width === 58 ? 15 : 17}px; margin: 0 0 2px; text-align: center; letter-spacing: -0.01em; }
  .muted { color: #444; }
  .center { text-align: center; }
  .right { text-align: right; }
  .bold { font-weight: 700; }
  .xl { font-size: ${width === 58 ? 18 : 22}px; font-weight: 700; }
  .rule { border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .item { display: flex; gap: 6px; margin: 4px 0; }
  .qty { min-width: 22px; font-weight: 700; }
  .note { margin-left: 28px; font-style: italic; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
`

function printDocument(title: string, width: PaperWidth, body: string) {
  if (typeof window === 'undefined') return

  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  document.body.appendChild(frame)

  const doc = frame.contentDocument
  if (!doc) {
    document.body.removeChild(frame)
    return
  }

  doc.open()
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${BASE_STYLES(width)}</style></head><body>${body}</body></html>`,
  )
  doc.close()

  const run = () => {
    try {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
    } finally {
      // Give the print dialog time to take ownership before tearing down.
      setTimeout(() => frame.parentNode && document.body.removeChild(frame), 1500)
    }
  }

  if (doc.readyState === 'complete') run()
  else frame.onload = run
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Kitchen ticket — large type, no prices, everything the line cook needs. */
export function printKitchenTicket(
  ticket: TicketInput,
  restaurantName: string,
  width: PaperWidth = 80,
) {
  const time = new Date(ticket.placedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  const items = ticket.items
    .map(
      (item) => `
        <div class="item">
          <span class="qty">${item.quantity}×</span>
          <span>
            <span class="bold">${escapeHtml(item.name)}</span>
            ${item.optionsLabel ? `<br><span class="muted">${escapeHtml(item.optionsLabel)}</span>` : ''}
            ${item.notes ? `<br><span class="bold">** ${escapeHtml(item.notes)} **</span>` : ''}
          </span>
        </div>`,
    )
    .join('')

  printDocument(
    `Ticket ${ticket.orderNumber}`,
    width,
    `
      <div class="center">
        <h1>${escapeHtml(restaurantName)}</h1>
        <div class="muted">KITCHEN TICKET</div>
      </div>
      <div class="rule"></div>
      <div class="center xl">${ticket.tableNumber ? `TABLE ${escapeHtml(ticket.tableNumber)}` : 'TAKEAWAY'}</div>
      <div class="center">Order #${escapeHtml(ticket.orderNumber)} · ${time}</div>
      <div class="center muted">${escapeHtml(ticket.customerName)}</div>
      <div class="rule"></div>
      ${items}
      ${ticket.notes ? `<div class="rule"></div><div class="bold">NOTE: ${escapeHtml(ticket.notes)}</div>` : ''}
      <div class="rule"></div>
      <div class="center muted">Printed ${new Date().toLocaleTimeString()}</div>
    `,
  )
}

/** Customer receipt — itemised, with totals and a payment line. */
export function printReceipt(receipt: ReceiptInput, width: PaperWidth = 58) {
  const lines = receipt.lines
    .map(
      (line) => `
        <tr>
          <td>${line.quantity} × ${escapeHtml(line.name)}${
            line.optionsLabel ? `<br><span class="muted">&nbsp;&nbsp;${escapeHtml(line.optionsLabel)}</span>` : ''
          }</td>
          <td class="right">${escapeHtml(line.lineTotal)}</td>
        </tr>`,
    )
    .join('')

  const totals = receipt.totals
    .map(
      (total) =>
        `<div class="row ${total.strong ? 'bold' : ''}"><span>${escapeHtml(total.label)}</span><span>${escapeHtml(total.value)}</span></div>`,
    )
    .join('')

  printDocument(
    `Receipt ${receipt.orderNumber}`,
    width,
    `
      <div class="center">
        <h1>${escapeHtml(receipt.restaurantName)}</h1>
        ${receipt.addressLine ? `<div class="muted">${escapeHtml(receipt.addressLine)}</div>` : ''}
        ${receipt.phone ? `<div class="muted">${escapeHtml(receipt.phone)}</div>` : ''}
      </div>
      <div class="rule"></div>
      <div class="row"><span>Order</span><span class="bold">#${escapeHtml(receipt.orderNumber)}</span></div>
      ${receipt.invoiceNumber ? `<div class="row"><span>Invoice</span><span>${escapeHtml(receipt.invoiceNumber)}</span></div>` : ''}
      ${receipt.tableNumber ? `<div class="row"><span>Table</span><span>${escapeHtml(receipt.tableNumber)}</span></div>` : ''}
      <div class="row"><span>Guest</span><span>${escapeHtml(receipt.customerName)}</span></div>
      <div class="row"><span>Date</span><span>${new Date(receipt.placedAt).toLocaleString()}</span></div>
      <div class="rule"></div>
      <table>${lines}</table>
      <div class="rule"></div>
      ${totals}
      ${receipt.paymentMethod ? `<div class="rule"></div><div class="row"><span>Paid via</span><span class="bold">${escapeHtml(receipt.paymentMethod)}</span></div>` : ''}
      <div class="rule"></div>
      <div class="center">${escapeHtml(receipt.footer ?? 'Thank you — please come again!')}</div>
      <div class="center muted">Powered by RestaurantOS</div>
    `,
  )
}
