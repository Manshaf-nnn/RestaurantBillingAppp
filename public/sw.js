/* TableFlow service worker
 * -------------------------------------------------------------------------
 * Gives staff dashboards a working offline shell and fast repeat loads.
 * Strategy:
 *   • navigations  → network-first, fall back to cache, then /offline
 *   • static assets → stale-while-revalidate
 *   • API / socket  → never cached (always live)
 *
 * Bump VERSION whenever cached assets (icons, offline shell) change — the
 * activate handler purges every cache that doesn't match, so stale favicons
 * and pages are dropped on the next visit.
 */
// Bumped to tf-v3 so the activate handler drops `tf-v2-pages`, which had been
// hoarding rendered dashboard HTML since it was written.
const VERSION = 'tf-v3'
const STATIC_CACHE = `${VERSION}-static`
const PAGE_CACHE = `${VERSION}-pages`
const OFFLINE_URL = '/offline'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll([OFFLINE_URL, '/manifest.webmanifest'])),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Never cache live data or the websocket.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io') ||
    url.pathname.startsWith('/order') // guest ordering must always be fresh
  ) {
    return
  }

  if (request.mode === 'navigate') {
    /*
     * Signed-in pages are fetched but never stored.
     *
     * The offline shell is for guests and for the stations; a dashboard page is
     * somebody's takings, staff list and supplier balances rendered into HTML.
     * Keeping that in a cache with no TTL and no size cap — purged only when a
     * human edits VERSION above — means it can be replayed on any network
     * hiccup, to whoever is holding the device by then. An offline copy of last
     * Tuesday's revenue is worth less than not storing it.
     */
    const isPrivate = url.pathname.startsWith('/dashboard') || url.pathname.startsWith('/admin')

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!isPrivate) {
            const copy = response.clone()
            caches.open(PAGE_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() =>
          isPrivate
            ? caches.match(OFFLINE_URL)
            : caches.match(request).then((cached) => cached || caches.match(OFFLINE_URL)),
        ),
    )
    return
  }

  if (url.pathname.startsWith('/_next/static') || /\.(?:js|css|woff2?|png|jpg|svg|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request)
        const network = fetch(request)
          .then((response) => {
            cache.put(request, response.clone())
            return response
          })
          .catch(() => cached)
        return cached || network
      }),
    )
  }
})

// Toast the client when a new version is ready.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})
