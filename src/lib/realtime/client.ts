/**
 * Client-side realtime configuration.
 *
 * On serverless hosts (Netlify) there is no always-on Socket.IO server, so
 * realtime push is turned off and the UI falls back to fast polling. This flag
 * is inlined at build time from NEXT_PUBLIC_REALTIME_DISABLED.
 */
export function isRealtimeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_REALTIME_DISABLED !== 'true'
}

/** How often polling screens re-sync when realtime push is unavailable. */
export const REALTIME_POLL_MS = 7000
