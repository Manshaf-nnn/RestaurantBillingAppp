/**
 * A gateway that costs nothing to talk to.
 *
 * The whole SMS path — template, escaping, SSRF guard, success rule, delivery
 * log — can be exercised against this without an account, a credit or a real
 * phone. It is also the reason the SSRF guard permits `http:` outside
 * production: a localhost gateway is refused in prod and allowed here, which
 * is exactly the distinction the guard is drawing.
 *
 *   node scripts/fake-sms-gateway.mjs
 *
 * Then configure a tenant with provider `custom` and
 * url `http://localhost:4545/send`, success rule `status == success`.
 *
 * Routes:
 *   POST/GET /send     accepted, returns an id
 *   POST/GET /fail     HTTP 200 with an error in the body — the case that
 *                      catches a success rule set to "2xx is enough"
 *   POST/GET /slow     sleeps 20s, so the 8s timeout can be observed
 *   POST/GET /redirect 302 to the cloud metadata address, which the guard must
 *                      refuse to follow
 *   GET      /balance  a credit figure
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.FAKE_SMS_PORT ?? 4545)
let counter = 0

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('utf8')

  console.log(`\n[fake-sms] ${req.method} ${url.pathname}${url.search}`)
  if (body) console.log(`[fake-sms] body: ${body}`)

  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  switch (url.pathname) {
    case '/send':
      counter += 1
      return send(200, { status: 'success', data: { id: `fake-${counter}` } })

    case '/fail':
      /* HTTP 200 and a refusal in the body: what an out-of-credit account
       * really does, and what a naive 2xx success rule records as delivered. */
      return send(200, { status: 'error', message: 'insufficient credit' })

    case '/slow':
      await new Promise((resolve) => setTimeout(resolve, 20_000))
      return send(200, { status: 'success', data: { id: 'too-late' } })

    case '/redirect':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      return res.end()

    case '/balance':
      return send(200, { status: 'success', data: { acc_balance: 1234.5 } })

    default:
      return send(404, { status: 'error', message: `no route ${url.pathname}` })
  }
})

server.listen(PORT, () => {
  console.log(`[fake-sms] listening on http://localhost:${PORT}`)
  console.log('[fake-sms] routes: /send /fail /slow /redirect /balance')
})
