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
      "script-src 'self' 'unsafe-inline'",
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
