import type { PurchasePriority, PurchaseStatus } from '@prisma/client'

/**
 * How a purchase request reads on screen — one vocabulary for the list, the
 * request page, the receiving screen and the approvals desk. Pure, so a
 * client component and a server page import the same table.
 */
export type StatusVariant = 'secondary' | 'warning' | 'success' | 'destructive' | 'info'

export const PO_STATUS: Record<PurchaseStatus, { label: string; variant: StatusVariant }> = {
  DRAFT: { label: 'Draft', variant: 'secondary' },
  PENDING_APPROVAL: { label: 'Pending approval', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  RETURNED: { label: 'Returned for edit', variant: 'warning' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  ORDERED: { label: 'Ordered', variant: 'info' },
  PARTIALLY_RECEIVED: { label: 'Partially received', variant: 'warning' },
  RECEIVED: { label: 'Fully received', variant: 'success' },
  CLOSED: { label: 'Closed', variant: 'secondary' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
}

export const PO_PRIORITY: Record<PurchasePriority, { label: string; variant: StatusVariant }> = {
  LOW: { label: 'Low', variant: 'secondary' },
  NORMAL: { label: 'Normal', variant: 'secondary' },
  URGENT: { label: 'Urgent', variant: 'destructive' },
}

export interface StatusView {
  key: string
  label: string
  statuses: PurchaseStatus[]
}

/** The request queue: what is being decided, and what was decided. */
export const REQUEST_VIEWS: StatusView[] = [
  { key: 'requests', label: 'All requests', statuses: ['DRAFT', 'PENDING_APPROVAL', 'RETURNED', 'REJECTED'] },
  { key: 'draft', label: 'Draft', statuses: ['DRAFT'] },
  { key: 'pending', label: 'Pending approval', statuses: ['PENDING_APPROVAL'] },
  { key: 'returned', label: 'Returned', statuses: ['RETURNED'] },
  { key: 'rejected', label: 'Rejected', statuses: ['REJECTED'] },
]

/** The order book: approved requests through to closed. */
export const ORDER_VIEWS: StatusView[] = [
  { key: 'orders', label: 'All orders', statuses: ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] },
  { key: 'open', label: 'Open', statuses: ['APPROVED', 'ORDERED'] },
  { key: 'partial', label: 'Partially received', statuses: ['PARTIALLY_RECEIVED'] },
  { key: 'received', label: 'Fully received', statuses: ['RECEIVED'] },
  { key: 'closed', label: 'Closed', statuses: ['CLOSED', 'CANCELLED'] },
]

export function viewByKey(key: string | undefined): StatusView | null {
  if (!key || key === 'all') return null
  return [...REQUEST_VIEWS, ...ORDER_VIEWS].find((view) => view.key === key) ?? null
}

/** A short "2 weeks ago" for a price panel; dates elsewhere use LocalDateTime. */
export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime())
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return 'today'
  const days = Math.floor(diff / day)
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  return `${Math.floor(days / 365)} years ago`
}

/** Signed change from `from` to `to` as a fraction; 0 when there is nothing to compare. */
export function priceChange(from: number, to: number): number {
  if (!(from > 0)) return 0
  return (to - from) / from
}

export function formatPercent(fraction: number): string {
  const pct = Math.round(fraction * 1000) / 10
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct}%`
}
