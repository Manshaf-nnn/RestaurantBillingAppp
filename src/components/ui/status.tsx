import * as React from 'react'
import type {
  OrderStatus,
  PaymentStatus,
  ReservationStatus,
  TableStatus,
  UserRole,
} from '@prisma/client'
import {
  ChefHat,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Flame,
  Hand,
  UtensilsCrossed,
  XCircle,
} from 'lucide-react'

import { Badge, type BadgeProps } from './badge'
import { ROLE_LABELS } from '@/lib/rbac'
import { cn } from '@/lib/utils'

type Variant = NonNullable<BadgeProps['variant']>

export const ORDER_STATUS_META: Record<
  OrderStatus,
  { label: string; variant: Variant; icon: React.ElementType; dot: string }
> = {
  PENDING: { label: 'New', variant: 'warning', icon: Clock, dot: 'bg-warning' },
  ACCEPTED: { label: 'Accepted', variant: 'info', icon: Hand, dot: 'bg-chart-2' },
  PREPARING: { label: 'Preparing', variant: 'default', icon: Flame, dot: 'bg-primary' },
  READY: { label: 'Ready', variant: 'success', icon: ChefHat, dot: 'bg-success' },
  SERVED: { label: 'Served', variant: 'success', icon: UtensilsCrossed, dot: 'bg-success' },
  COMPLETED: { label: 'Completed', variant: 'secondary', icon: CheckCircle2, dot: 'bg-muted-foreground' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive', icon: XCircle, dot: 'bg-destructive' },
}

export const PAYMENT_STATUS_META: Record<PaymentStatus, { label: string; variant: Variant }> = {
  UNPAID: { label: 'Unpaid', variant: 'destructive' },
  PARTIAL: { label: 'Partial', variant: 'warning' },
  PAID: { label: 'Paid', variant: 'success' },
  REFUNDED: { label: 'Refunded', variant: 'secondary' },
  FAILED: { label: 'Failed', variant: 'destructive' },
}

export const TABLE_STATUS_META: Record<TableStatus, { label: string; variant: Variant; dot: string }> = {
  AVAILABLE: { label: 'Available', variant: 'success', dot: 'bg-success' },
  OCCUPIED: { label: 'Occupied', variant: 'default', dot: 'bg-primary' },
  RESERVED: { label: 'Reserved', variant: 'info', dot: 'bg-chart-2' },
  CLEANING: { label: 'Cleaning', variant: 'warning', dot: 'bg-warning' },
  OUT_OF_SERVICE: { label: 'Out of service', variant: 'secondary', dot: 'bg-muted-foreground' },
}

export const RESERVATION_STATUS_META: Record<ReservationStatus, { label: string; variant: Variant }> = {
  PENDING: { label: 'Pending', variant: 'warning' },
  CONFIRMED: { label: 'Confirmed', variant: 'info' },
  SEATED: { label: 'Seated', variant: 'default' },
  COMPLETED: { label: 'Completed', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'secondary' },
  NO_SHOW: { label: 'No show', variant: 'destructive' },
}

export function OrderStatusBadge({
  status,
  className,
  showIcon = true,
}: {
  status: OrderStatus
  className?: string
  showIcon?: boolean
}) {
  const meta = ORDER_STATUS_META[status]
  const Icon = meta.icon
  return (
    <Badge variant={meta.variant} className={className}>
      {showIcon ? <Icon /> : null}
      {meta.label}
    </Badge>
  )
}

export function PaymentStatusBadge({ status, className }: { status: PaymentStatus; className?: string }) {
  const meta = PAYMENT_STATUS_META[status]
  return (
    <Badge variant={meta.variant} className={className}>
      <CircleDollarSign />
      {meta.label}
    </Badge>
  )
}

export function TableStatusBadge({ status, className }: { status: TableStatus; className?: string }) {
  const meta = TABLE_STATUS_META[status]
  return (
    <Badge variant={meta.variant} className={className}>
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </Badge>
  )
}

export function RoleBadge({ role, className }: { role: UserRole; className?: string }) {
  const variant: Variant =
    role === 'OWNER' || role === 'SUPER_ADMIN'
      ? 'default'
      : role === 'MANAGER'
        ? 'info'
        : 'secondary'
  return (
    <Badge variant={variant} className={className}>
      {ROLE_LABELS[role]}
    </Badge>
  )
}

/** Veg / non-veg indicator used across the menu, following FSSAI marking. */
export function VegIndicator({ isVeg, className }: { isVeg: boolean; className?: string }) {
  return (
    <span
      title={isVeg ? 'Vegetarian' : 'Non-vegetarian'}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-2',
        isVeg ? 'border-success' : 'border-destructive',
        className,
      )}
    >
      <span
        className={cn('size-1.5 rounded-full', isVeg ? 'bg-success' : 'bg-destructive')}
      />
      <span className="sr-only">{isVeg ? 'Vegetarian' : 'Non-vegetarian'}</span>
    </span>
  )
}

export function SpiceLevelIndicator({
  level,
  className,
}: {
  level: 'NONE' | 'MILD' | 'MEDIUM' | 'HOT' | 'EXTRA_HOT'
  className?: string
}) {
  const count = { NONE: 0, MILD: 1, MEDIUM: 2, HOT: 3, EXTRA_HOT: 4 }[level]
  if (!count) return null
  return (
    <span className={cn('inline-flex items-center gap-px', className)} title={`Spice: ${level}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Flame key={i} className="size-3 fill-destructive/20 text-destructive" />
      ))}
    </span>
  )
}
