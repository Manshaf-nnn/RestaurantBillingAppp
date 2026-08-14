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
}

/**
 * The QR landing screen.
 */
export function TableEntry(props: TableEntryProps) {
  return <CoverPage {...props} />
}
