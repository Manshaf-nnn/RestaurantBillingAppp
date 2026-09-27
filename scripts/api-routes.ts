/**
 * How every API route is protected — the one registry, read by two suites.
 *
 * `api-surface-test` checks this against the source: that every route.ts is
 * classified here, that each declared mechanism is actually present in the
 * file, and that the middleware waves through nothing this does not cover.
 * `api-authorization-test` checks it against a running server: that every
 * route which claims to need a caller actually refuses one it does not have.
 *
 * Static and runtime must read the SAME list or the two drift, and a route
 * could be declared safe by one while the other never visits it. Adding a
 * route means adding a line here, and both suites then cover it.
 */

export type Mechanism = 'session' | 'api-key' | 'shared-secret' | 'guest-cookie' | 'open'

/** What each mechanism must be able to show for itself in the file. */
export const EVIDENCE: Record<Exclude<Mechanism, 'open'>, RegExp> = {
  session: /requireTenantUser|requireSuperAdmin|requirePermission|requireAnyPermission|requireUser|getCurrentUser/,
  'api-key': /withWebsiteCaller|authenticateWebsiteKey/,
  'shared-secret': /timingSafeEqual/,
  'guest-cookie': /getGuestSessionId|ForGuest|guestSession/,
}

export const POSTURE: Record<string, { how: Mechanism; why: string }> = {
  'admin/media/restore': {
    how: 'session',
    why: 'requireSuperAdmin — a platform operator restoring images across tenants',
  },
  'auth/refresh': {
    how: 'open',
    why: 'the refresh cookie IS the credential; there is no session yet to require',
  },
  docs: { how: 'open', why: 'the public API description, deliberately readable without a key' },
  health: { how: 'open', why: 'the liveness probe the platform calls; returns no tenant data' },
  'health/db': { how: 'session', why: 'requirePermission(SETTINGS_MANAGE) — reports migration state' },
  'health/errors': { how: 'session', why: 'requirePermission(SETTINGS_MANAGE) — reads recorded errors' },
  'health/pages': { how: 'session', why: 'requirePermission(SETTINGS_MANAGE) — renders every page to check it' },
  'invite/accept': {
    how: 'open',
    why: 'redirects a signed invite link to /join/<token> and returns no data; the token is checked there',
  },
  'jobs/run': {
    how: 'shared-secret',
    why: 'the caller is a scheduler with no user; compared with timingSafeEqual and refuses everything when unset',
  },
  'media/[key]': {
    how: 'open',
    why: 'content-addressed image bytes for menus and logos, which guests must load anonymously',
  },
  'menu/scan': { how: 'session', why: 'requirePermission(MENU_MANAGE) — parses an uploaded menu' },
  pulse: {
    how: 'session',
    why: 'getCurrentUser for staff, getGuestSessionId for a guest watching one order; scopes the token to whichever it finds',
  },
  'public/domain-allowed': { how: 'open', why: 'answers whether a hostname may embed the guest app' },
  'public/menu': { how: 'open', why: 'the guest menu; anonymous by definition' },
  'public/orders/[orderId]': {
    how: 'guest-cookie',
    why: 'the guest session cookie set when the order was placed is what proves it is theirs',
  },
  'public/whoami': { how: 'open', why: 'tells the guest app which tenant the hostname resolves to' },
  'reports/export': { how: 'session', why: 'requirePermission(REPORT_EXPORT) plus the permission behind each report' },
  uploads: { how: 'session', why: 'requireTenantUser — writes image bytes against the caller’s tenant' },
  'website/v1/connection': { how: 'api-key', why: 'bearer key through withWebsiteCaller' },
  'website/v1/menu': { how: 'api-key', why: 'bearer key through withWebsiteCaller' },
  'website/v1/orders': { how: 'api-key', why: 'bearer key through withWebsiteCaller' },
  'website/v1/orders/[orderId]': { how: 'api-key', why: 'bearer key through withWebsiteCaller' },
  'website/v1/restaurant': { how: 'api-key', why: 'bearer key through withWebsiteCaller' },
}
