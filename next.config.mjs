import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

/*
 * Stamped at build time, not read at runtime.
 *
 * A serverless function can tell you when it woke up; it cannot tell you when
 * the code it is running was compiled, and the two can be weeks apart. This is
 * how `/api/health` reports the age of the deploy — see `lib/build-info.ts`.
 */
const BUILD_TIME = new Date().toISOString()

/**
 * The commit this build came from, stamped for the same reason as the time.
 *
 * `/api/health` reported `commit: null` on a live deploy, which made it useless
 * for the one question it exists to answer — "did my push reach the site". The
 * values are only in the environment of the BUILD; a serverless function
 * started later has no idea what they were, so reading `process.env.COMMIT_REF`
 * at runtime always came back empty.
 *
 * Every host names it differently, so all of the common ones are read and the
 * first that answers wins. Null locally, which is exactly what `local: true`
 * is for.
 */
const BUILD_COMMIT =
  process.env.COMMIT_REF ??            // Netlify
  process.env.RENDER_GIT_COMMIT ??     // Render
  process.env.VERCEL_GIT_COMMIT_SHA ?? // Vercel
  process.env.SOURCE_VERSION ??        // Heroku
  process.env.GIT_COMMIT ??
  ''

const BUILD_BRANCH =
  process.env.BRANCH ??
  process.env.RENDER_GIT_BRANCH ??
  process.env.VERCEL_GIT_COMMIT_REF ??
  ''

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_TIME: BUILD_TIME,
    NEXT_PUBLIC_BUILD_COMMIT: BUILD_COMMIT,
    NEXT_PUBLIC_BUILD_BRANCH: BUILD_BRANCH,
  },
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
    /*
     * No image optimizer, deliberately. The optimizer is an open proxy: with
     * `hostname: '**'` (which the paste-any-image-URL feature needs) anyone
     * could route arbitrary hosts through this site's bandwidth, and every
     * optimized image is a paid function invocation on the serverless host.
     * Our own images are stored pre-sized and served from /api/media with
     * immutable caching; pasted external URLs now load directly from their
     * source. Same pictures, no proxy, no per-image bill.
     */
    unoptimized: true,
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
