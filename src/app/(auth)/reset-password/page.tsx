import { permanentRedirect } from 'next/navigation'

/**
 * The old address of the link-based reset.
 *
 * Reset links are no longer sent — a code is, and it is typed into
 * /forgot-password/verify. A link from an email sent before the change
 * lands here; the only useful answer is the start of the new flow.
 */
export default function ResetPasswordPage() {
  permanentRedirect('/forgot-password')
}
