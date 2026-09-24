import { permanentRedirect } from 'next/navigation'

/**
 * Guest experience moved inside Settings, as a tab (owner request).
 *
 * Kept as a redirect rather than deleted: this path was live, and a link
 * somebody saved or bookmarked should land where the screen went rather than
 * on a 404.
 */
export default function GuestExperienceRedirect() {
  permanentRedirect('/dashboard/settings?tab=guest')
}
