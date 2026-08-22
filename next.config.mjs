import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // Pin the file-tracing root to this project so serverless bundling on hosts
  // like Netlify includes the right files (avoids the multi-lockfile warning).
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // Force the Prisma query-engine binary into every serverless function bundle
  // (it's loaded via a computed path that file-tracing can otherwise miss).
  outputFileTracingIncludes: {
    '/**': ['./node_modules/.prisma/client/**/*', './node_modules/@prisma/client/**/*'],
  },
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'exceljs', 'nodemailer', 'ioredis'],
  experimental: {
    /*
     * `dynamic: 0` is Next's own default, and it is stated here rather than
     * deleted so that nobody raises it again.
     *
     * It was 30, added to stop the app feeling like it reloaded on every
     * sidebar click. That bought a smoother back button and paid for it with
     * wrong figures on screen, which is never a trade worth making.
     *
     * The mechanism, because it is not obvious: a `router.push` runs as
     * `PrefetchKind.TEMPORARY`, and Next builds the prefetch cache key from the
     * pathname with the **search string dropped** for anything short of
     * `PrefetchKind.FULL`. So `/dashboard?branch=A` and `/dashboard?branch=B`
     * are one entry keyed `/dashboard`, and picking a second branch was
     * answered with the first one's tree while the URL bar updated anyway.
     * Worse, the staleness window slides on every use, so toggling between two
     * branches kept the wrong entry alive instead of ageing it out. It is a
     * per-tab cache and the aliasing is guarded to production, which is exactly
     * why the same URL pasted into a second browser looked fine.
     *
     * What actually fixed the reload feel was `src/app/dashboard/loading.tsx`,
     * added in the same pass and still doing the job.
     *
     * `static` stays: a static page serving a slightly old copy of itself
     * cannot show anyone another branch's money.
     */
    staleTimes: { dynamic: 0, static: 180 },
  },
  images: {
    // Allow any HTTPS image URL owners paste for menu photos/logos.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
    formats: ['image/avif', 'image/webp'],
  },
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    // Content-Security-Policy. 'unsafe-inline' is required for Next's inline
    // hydration/RSC scripts (no nonce pipeline here); the remaining directives
    // still shut down the common XSS/clickjacking/data-exfil vectors. Images
    // allow https + data/blob so pasted URLs and upload previews render.
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "form-action 'self'",
      "img-src 'self' data: blob: https:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "connect-src 'self' https: wss: ws:",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "media-src 'self' data: blob:",
    ].join('; ')

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ]
  },
}

export default nextConfig
