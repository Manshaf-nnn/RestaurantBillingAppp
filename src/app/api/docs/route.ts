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
    </style></head><body>
    <h1>${spec.name} <span class="muted">v${spec.version}</span></h1>
    <p class="muted">${spec.description}</p>
    <p class="muted">Base URL: <code>${spec.baseUrl}</code></p>
    <h2>REST endpoints</h2>
    <table><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr></thead><tbody>${restRows}</tbody></table>
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
    websocket: {
      url: '',
      transport: '',
      serverToClient: SERVER_EVENTS,
      clientToServer: CLIENT_EVENTS,
    },
  }
}
