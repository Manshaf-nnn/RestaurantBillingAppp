/**
 * The transport contract for Server Actions.
 *
 * Next's action client accepts exactly one kind of reply: an RSC Flight payload
 * with `content-type: text/x-component`. Give it anything else and it either
 * treats the reply as a page navigation (a redirect) or throws (a JSON body).
 * Both leave the calling promise unresolved or rejected, and because these
 * buttons are `disabled={busy}` with the reset placed after the `await`, both
 * end as a button stuck on "Adding…" with no error shown.
 *
 * This app shipped each of those in turn — first a 307 from the middleware, then
 * a 401 JSON body meant to fix it. The middleware must therefore never answer a
 * Server Action at all, and `callAction` must convert whatever does go wrong
 * into an ordinary result. Both halves are asserted here.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/action-transport-test.ts
 */
import { NextRequest } from 'next/server'

process.env.JWT_ACCESS_SECRET ||= 'test-access-secret-at-least-32-characters-long'
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-at-least-32-characters'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function actionRequest(path: string, cookie?: string) {
  return new NextRequest(`https://tableflow.markui.lk${path}`, {
    method: 'POST',
    headers: {
      'next-action': '00a1b2c3d4e5f60718293a4b5c6d7e8f90',
      'content-type': 'text/plain;charset=UTF-8',
      ...(cookie ? { cookie } : {}),
    },
  })
}

async function main() {
  const { middleware } = await import('../src/middleware')

  console.log('\nMiddleware must never answer a Server Action')

  // Signed out, expired, wrong role, admin area, auth pages: every branch that
  // used to return a redirect or a JSON body.
  const paths = [
    '/dashboard/locations',
    '/dashboard/transfers',
    '/dashboard/production',
    '/admin',
    '/admin/login',
    '/login',
    '/kitchen',
    '/cashier',
  ]

  for (const path of paths) {
    const response = await middleware(actionRequest(path))
    const status = response.status
    const type = response.headers.get('content-type') ?? ''
    const location = response.headers.get('location')

    check(
      `${path} — not a redirect`,
      !(status >= 300 && status < 400) && !location,
      `status ${status}${location ? ` → ${location}` : ''}`,
    )
    check(
      `${path} — no JSON body handed to the action client`,
      !type.includes('application/json'),
      `content-type ${type || '(none)'}`,
    )
  }

  // A stale cookie must behave the same as none: the guards decide, not here.
  const stale = await middleware(
    actionRequest('/dashboard/locations', 'ros_at=not-a-real-token; ros_rt=also-not-real'),
  )
  check(
    'expired session — still passes through to the action',
    stale.status < 300 && !stale.headers.get('location'),
    `status ${stale.status}`,
  )

  console.log('\nNavigation must keep redirecting (the fix must not open a hole)')

  const nav = await middleware(new NextRequest('https://tableflow.markui.lk/dashboard'))
  check(
    'signed-out page load still redirects to /login',
    nav.status >= 300 && nav.status < 400 && (nav.headers.get('location') ?? '').includes('/login'),
    `status ${nav.status} → ${nav.headers.get('location')}`,
  )

  const adminNav = await middleware(new NextRequest('https://tableflow.markui.lk/admin'))
  check(
    'signed-out admin page still redirects',
    adminNav.status >= 300 && adminNav.status < 400,
    `status ${adminNav.status}`,
  )

  console.log('\ncallAction turns a rejection into a result')

  const { callAction } = await import('../src/lib/use-action')

  const rejected = await callAction<{ id: string }>(async () => {
    throw new Error('An unexpected response was received from the server.')
  })
  check('a thrown error resolves instead of rejecting', rejected.ok === false)
  check(
    'and carries a message a person can act on',
    !rejected.ok && rejected.error.length > 10 && !rejected.error.includes('unexpected response'),
    !rejected.ok ? rejected.error : '',
  )

  const expired = await callAction(async () => {
    throw new Error('401 Unauthorized: your session expired')
  })
  check(
    'an expired session is named as such',
    !expired.ok && /session expired/i.test(expired.error),
    !expired.ok ? expired.error : '',
  )

  const fine = await callAction(async () => ({ ok: true as const, data: { id: 'x' } }))
  check('a successful call passes straight through', fine.ok === true)

  const business = await callAction(async () => ({
    ok: false as const,
    error: 'Branch code KAN is already used',
    code: 'BRANCH_CODE_TAKEN',
  }))
  check(
    'a business failure keeps its own message and code',
    !business.ok && business.code === 'BRANCH_CODE_TAKEN',
  )

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
