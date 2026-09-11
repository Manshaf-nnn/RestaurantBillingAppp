import { NextResponse } from 'next/server'

import { appUrl } from '@/lib/env'
import { EVENTS } from '@/lib/realtime/events'

export const dynamic = 'force-dynamic'

/**
 * Self-describing API documentation.
 *   GET /api/docs           → JSON reference
 *   GET /api/docs?format=html → rendered page
 */
const REST_ENDPOINTS = [
  {
    method: 'GET',
    path: '/api/health',
    auth: 'none',
    description: 'Liveness and dependency status.',
  },
  {
    method: 'GET',
    path: '/api/public/menu?r={slug}',
    auth: 'none',
    description: 'Fully priced public menu for a restaurant (offers & happy hour resolved).',
  },
  {
    method: 'GET',
    path: '/api/public/orders/{orderId}',
    auth: 'guest cookie',
    description: 'Live status of a guest order. Requires the guest session cookie.',
  },
  {
    method: 'GET',
    path: '/api/reports/export?type={summary|orders}&format={csv|xlsx}&range={today|week|month|...}',
    auth: 'staff (report.export)',
    description: 'Download a sales report or order list.',
  },
  {
    method: 'GET|POST',
    path: '/api/auth/refresh',
    auth: 'refresh cookie',
    description: 'Rotate the session and issue a new access token.',
  },
]

/**
 * A restaurant's own website, connected by a key (websiteconnect.md).
 *
 * Documented here rather than on a page of its own because a second document
 * is a second thing to keep true. Everything below is answered from the key:
 * there is no restaurant or branch parameter to get wrong, and no way to ask
 * for another restaurant's data.
 */
const WEBSITE_ENDPOINTS = [
  {
    method: 'GET',
    path: '/api/website/v1/connection',
    auth: 'Bearer key',
    description: 'Who this key belongs to — restaurant, branches, default branch. The first call marks the site connected.',
  },
  {
    method: 'GET',
    path: '/api/website/v1/restaurant',
    auth: 'Bearer key',
    description: 'Name, tagline, logo and cover (absolute URLs), currency, tax rules, address, opening hours, theme, branches.',
  },
  {
    method: 'GET',
    path: '/api/website/v1/menu?branch={code|id}',
    auth: 'Bearer key',
    description: 'Categories and items priced for one branch — variants, add-ons, availability and offers resolved. Prices are minor units.',
  },
  {
    method: 'POST',
    path: '/api/website/v1/orders',
    auth: 'Bearer key',
    description: 'Place a TAKEAWAY or DELIVERY order. It lands in the kitchen display and till exactly like a QR order. Send idempotencyKey so a retry is safe.',
  },
  {
    method: 'GET',
    path: '/api/website/v1/orders/{orderId}',
    auth: 'Bearer key',
    description: 'Status, payment status, lines and totals of an order the website placed. Poll it; there is no webhook to host.',
  },
]

const WEBSITE_ORDER_EXAMPLE = {
  branch: 'MAIN',
  type: 'TAKEAWAY',
  customerName: 'Nimal Perera',
  customerPhone: '+94 77 123 4567',
  notes: 'No onions',
  items: [{ foodId: 'an id from /menu', quantity: 2, optionIds: [] }],
  idempotencyKey: 'checkout-3f9a1c0e',
}

const SERVER_EVENTS = [
  { event: EVENTS.ORDER_CREATED, description: 'A new order was placed.', audience: 'kitchen, management' },
  { event: EVENTS.ORDER_STATUS, description: 'An order changed status.', audience: 'all + order room' },
  { event: EVENTS.PAYMENT_RECEIVED, description: 'A payment was captured.', audience: 'cashier, management' },
  { event: EVENTS.SERVICE_REQUEST_CREATED, description: 'A guest asked for service.', audience: 'waiter' },
  { event: EVENTS.TABLE_UPDATED, description: 'A table changed status.', audience: 'floor staff' },
  { event: EVENTS.LOW_STOCK, description: 'An ingredient hit its reorder level.', audience: 'management' },
  { event: EVENTS.NOTIFICATION, description: 'A generic notification.', audience: 'targeted' },
]

const CLIENT_EVENTS = [
  { event: EVENTS.JOIN_ORDER, description: 'Subscribe to updates for one order id.' },
  { event: EVENTS.LEAVE_ORDER, description: 'Unsubscribe from an order id.' },
]

export async function GET(request: Request) {
  const url = new URL(request.url)
  const spec = {
    name: 'TableFlow API',
    version: '1.0.0',
    baseUrl: appUrl(),
    description:
      'REST + WebSocket API for the TableFlow platform. Staff endpoints authenticate with the httpOnly session cookie; the websocket authenticates from the same cookie.',
    rest: REST_ENDPOINTS,
    website: {
      baseUrl: `${appUrl()}/api/website/v1`,
      auth:
        'Authorization: Bearer <key> — one key per restaurant, issued under Super Admin → Restaurants → Connect website. Call it from your server only; the key must never be in browser code.',
      endpoints: WEBSITE_ENDPOINTS,
      orderExample: WEBSITE_ORDER_EXAMPLE,
    },
    websocket: {
      url: `${appUrl().replace(/^http/, 'ws')}/socket.io`,
      transport: 'socket.io (websocket, polling fallback)',
      serverToClient: SERVER_EVENTS,
      clientToServer: CLIENT_EVENTS,
    },
  }

  if (url.searchParams.get('format') === 'html') {
    return new NextResponse(renderHtml(spec), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  return NextResponse.json(spec)
}

function renderHtml(spec: ReturnType<typeof buildSpecShape>): string {
  const restRows = spec.rest
    .map(
      (endpoint) =>
        `<tr><td><code>${endpoint.method}</code></td><td><code>${endpoint.path}</code></td><td>${endpoint.auth}</td><td>${endpoint.description}</td></tr>`,
    )
    .join('')

  const websiteRows = spec.website.endpoints
    .map(
      (endpoint) =>
        `<tr><td><code>${endpoint.method}</code></td><td><code>${endpoint.path}</code></td><td>${endpoint.auth}</td><td>${endpoint.description}</td></tr>`,
    )
    .join('')

  const wsRows = spec.websocket.serverToClient
    .map((event) => `<tr><td><code>${event.event}</code></td><td>${event.audience}</td><td>${event.description}</td></tr>`)
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>TableFlow API</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:920px;margin:0 auto;padding:40px 24px;color:#18181b;line-height:1.6}
      h1{font-size:30px;letter-spacing:-.02em;margin-bottom:4px}
      .muted{color:#71717a}
      h2{margin-top:40px;font-size:20px;border-bottom:1px solid #eee;padding-bottom:8px}
      table{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}
      th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top}
      th{color:#71717a;font-weight:600;font-size:12px;text-transform:uppercase}
      code{background:#f4f4f5;padding:2px 6px;border-radius:6px;font-size:13px}
      .ws{background:#fafafa;border:1px solid #eee;border-radius:10px;padding:12px;margin-top:12px}
      pre.ws{overflow:auto;font-size:13px;line-height:1.5}
      h3{margin-top:24px;font-size:16px}
      ol li{margin:4px 0}
    </style></head><body>
    <h1>${spec.name} <span class="muted">v${spec.version}</span></h1>
    <p class="muted">${spec.description}</p>
    <p class="muted">Base URL: <code>${spec.baseUrl}</code></p>
    <h2>REST endpoints</h2>
    <table><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr></thead><tbody>${restRows}</tbody></table>
    <h2 id="website">Website integration</h2>
    <p class="muted">For a restaurant's own website. One key per restaurant, issued in the super-admin console under <strong>Connect website</strong>. <strong>Server-to-server only</strong> — the key is a password and must never be in page JavaScript; a call carrying a browser <code>Origin</code> header is refused with <code>BROWSER_CALL</code>.</p>
    <ol>
      <li>Put the details from Connect website in your server's <code>.env</code>: <code>TABLEFLOW_API_URL</code> and <code>TABLEFLOW_API_KEY</code>. The restaurant and branch ids are there for reference — every endpoint already knows them from the key.</li>
      <li>Call <code>GET /connection</code> with <code>Authorization: Bearer &lt;key&gt;</code>. That one call marks the site connected in TableFlow.</li>
      <li>Read <code>/restaurant</code> for branding and <code>/menu</code> for what is for sale; send <code>POST /orders</code>; poll <code>GET /orders/{id}</code> for progress.</li>
    </ol>
    <table><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr></thead><tbody>${websiteRows}</tbody></table>
    <p class="muted">Base URL: <code>${spec.website.baseUrl}</code> · Money is in minor units (cents) in the restaurant's currency · Errors are <code>{ error, code }</code>; a bad order body is <code>422</code> with <code>fieldErrors</code> · Orders arrive <code>UNPAID</code> and are settled at the till.</p>
    <h3>Placing an order</h3>
    <pre class="ws">POST ${spec.website.baseUrl}/orders
Authorization: Bearer tfk_…
Content-Type: application/json

${JSON.stringify(spec.website.orderExample, null, 2)}</pre>
    <h3>From Node</h3>
    <pre class="ws">const res = await fetch(process.env.TABLEFLOW_API_URL + '/menu?branch=MAIN', {
  headers: { Authorization: 'Bearer ' + process.env.TABLEFLOW_API_KEY },
})
const { items } = await res.json()</pre>
    <h2>WebSocket</h2>
    <div class="ws"><code>${spec.websocket.url}</code> · ${spec.websocket.transport}</div>
    <table><thead><tr><th>Event (server → client)</th><th>Audience</th><th>Description</th></tr></thead><tbody>${wsRows}</tbody></table>
    </body></html>`
}

// Helper only for the return type above.
function buildSpecShape() {
  return {
    name: '',
    version: '',
    baseUrl: '',
    description: '',
    rest: REST_ENDPOINTS,
    website: { baseUrl: '', auth: '', endpoints: WEBSITE_ENDPOINTS, orderExample: WEBSITE_ORDER_EXAMPLE },
    websocket: {
      url: '',
      transport: '',
      serverToClient: SERVER_EVENTS,
      clientToServer: CLIENT_EVENTS,
    },
  }
}
