'use client'

import * as React from 'react'
import CoverPage from '@/components/CoverPage'

interface TableEntryProps {
  restaurantName: string
  tagline: string | null
  logoUrl: string | null
  coverUrl: string | null
  city: string | null
  isOpen: boolean
  openingLabel: string | null
  /** Pre-filled from a table QR. */
  initialTable?: string
  /** The `?b=` from the QR, so the table is looked up at the right branch. */
  branchCode?: string | null
  /** Shown when the code was a branch's, so the guest can confirm the place. */
  branchName?: string | null
}

/**
 * The QR landing screen.
 */
export function TableEntry(props: TableEntryProps) {
  return <CoverPage {...props} />
}
