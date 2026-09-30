'use client'

import { useMemo, useState } from 'react'
import {
  Bike,
  CheckCircle2,
  Home,
  MapPin,
  Phone,
  Receipt,
  Store,
  Timer,
  Utensils,
} from 'lucide-react'

import { cn } from '@/lib/utils'

import { DELIVERIES, DELIVERY_STAGES, rs } from './data'
import { Card, CardTitle, Meter, Pill, Stat, useNotify, useTick, type Tone } from './ui'

// ── Delivery ────────────────────────────────────────────────────────────────

const ROUTE: [number, number][] = [
  [42, 168],
  [42, 118],
  [118, 118],
  [118, 66],
  [204, 66],
  [204, 34],
  [262, 34],
]

function pointOnRoute(t: number): [number, number] {
  const lengths = ROUTE.slice(1).map(([x, y], i) => Math.hypot(x - ROUTE[i][0], y - ROUTE[i][1]))
  let left = Math.max(0, Math.min(1, t)) * lengths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i]) {
      const f = lengths[i] === 0 ? 0 : left / lengths[i]
      return [ROUTE[i][0] + (ROUTE[i + 1][0] - ROUTE[i][0]) * f, ROUTE[i][1] + (ROUTE[i + 1][1] - ROUTE[i][1]) * f]
    }
    left -= lengths[i]
  }
  return ROUTE[ROUTE.length - 1]
}

function stageOf(progress: number) {
  if (progress >= 100) return 3
  if (progress >= 38) return 2
  if (progress >= 14) return 1
  return 0
}

const STAGE_TONE: Tone[] = ['info', 'warn', 'violet', 'ok']
const STAGE_ICON = [Receipt, Utensils, Bike, Home]

export function Delivery() {
  const tick = useTick()
  const notify = useNotify()
  const [selectedNo, setSelectedNo] = useState(DELIVERIES[0].no)

  // Each order creeps forward, pauses at "Delivered", then the round starts again.
  const orders = useMemo(
    () =>
      DELIVERIES.map((d) => {
        const moving = d.progress >= 100 ? 100 : Math.min(100, (d.progress + tick * 0.9) % 125)
        return { ...d, progress: moving, stage: stageOf(moving) }
      }),
    [tick],
  )
  const selected = orders.find((o) => o.no === selectedNo)!
  const ride = Math.max(0, Math.min(1, (selected.progress - 38) / 62))
  const [rx, ry] = pointOnRoute(ride)
  const eta = Math.max(0, Math.ceil(((100 - selected.progress) / 100) * 28))
  const routeD = ROUTE.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Bike} label="Out for delivery" value={String(orders.filter((o) => o.stage === 2).length)} tone="violet" />
        <Stat icon={Utensils} label="Being prepared" value={String(orders.filter((o) => o.stage < 2).length)} tone="warn" />
        <Stat icon={CheckCircle2} label="Delivered today" value="37" delta={15.6} tone="ok" />
        <Stat icon={Timer} label="Average delivery time" value="26 min" delta={-8.4} lowerIsBetter hint="Faster than last week" tone="info" />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-2 lg:col-span-2">
          {orders.map((o) => (
            <button
              key={o.no}
              type="button"
              onClick={() => setSelectedNo(o.no)}
              aria-pressed={o.no === selectedNo}
              className={cn('tfd-card block w-full rounded-2xl p-3 text-left', o.no === selectedNo && 'tfd-selected')}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold">
                  #{o.no} · {o.customer}
                </p>
                <Pill tone={STAGE_TONE[o.stage]}>{DELIVERY_STAGES[o.stage]}</Pill>
              </div>
              <p className="tfd-muted mt-0.5 truncate text-xs">{o.address}</p>
              <Meter value={o.progress} tone={STAGE_TONE[o.stage]} className="mt-2" />
              <div className="tfd-muted mt-1.5 flex justify-between text-[11px]">
                <span>Rider {o.rider}</span>
                <span className="font-semibold tabular-nums">{rs(o.total)}</span>
              </div>
            </button>
          ))}
        </div>

        <Card className="lg:col-span-3">
          <CardTitle
            icon={MapPin}
            right={
              <span className="tfd-ok flex items-center gap-2 text-xs font-semibold">
                <span className="tfd-live-dot" /> Live tracking
              </span>
            }
          >
            Order #{selected.no} · {selected.customer}
          </CardTitle>

          <div className="tfd-line relative overflow-hidden rounded-2xl border" style={{ background: 'var(--glass-soft)' }}>
            <svg viewBox="0 0 300 200" className="block h-auto w-full" role="img" aria-label="Map showing the rider on the way to the customer">
              {/* City blocks */}
              {[
                [12, 12, 66, 38], [92, 12, 96, 38], [12, 66, 14, 36], [58, 66, 44, 36], [220, 50, 68, 16],
                [134, 82, 54, 50], [204, 82, 84, 50], [58, 134, 60, 54], [134, 148, 70, 40], [220, 148, 68, 40],
                [12, 118, 14, 70],
              ].map(([x, y, w, h], i) => (
                <rect key={i} x={x} y={y} width={w} height={h} rx="5" fill="var(--track)" />
              ))}
              <path d={routeD} fill="none" stroke="var(--track)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
              <path
                d={routeD}
                fill="none"
                stroke="var(--brand)"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="1 7"
              />
              {/* Restaurant */}
              <circle cx={ROUTE[0][0]} cy={ROUTE[0][1]} r="11" fill="#f2611a" />
              <text x={ROUTE[0][0]} y={ROUTE[0][1] + 4} textAnchor="middle" fontSize="11">🍽️</text>
              {/* Customer */}
              <circle cx="262" cy="34" r="11" fill="#10b981" />
              <text x="262" y="38" textAnchor="middle" fontSize="11">🏠</text>
              {/* Rider */}
              {selected.stage >= 2 ? (
                <g style={{ transform: `translate(${rx}px, ${ry}px)`, transition: 'transform 1s linear' }}>
                  <circle r="13" fill="#8b5cf6" opacity="0.25" />
                  <circle r="9" fill="#8b5cf6" stroke="#fff" strokeWidth="2" />
                  <text y="4" textAnchor="middle" fontSize="10">🛵</text>
                </g>
              ) : null}
            </svg>
            <div className="tfd-glass-strong absolute left-3 top-3 rounded-xl px-3 py-1.5 text-xs">
              <p className="tfd-muted">{selected.stage === 3 ? 'Status' : 'Arriving in'}</p>
              <p className="text-base font-bold tabular-nums">{selected.stage === 3 ? 'Delivered' : `${eta} min`}</p>
            </div>
          </div>

          <ol className="mt-4 grid grid-cols-4 gap-1">
            {DELIVERY_STAGES.map((label, i) => {
              const Icon = STAGE_ICON[i]
              const reached = i <= selected.stage
              return (
                <li key={label} className="text-center">
                  <span
                    className={cn('tfd-pill mx-auto h-9 w-9 justify-center !p-0 transition-colors duration-500', reached ? 'tfd-btn-primary' : 'tfd-pill-neutral')}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className={cn('mt-1 block text-[10px] font-semibold leading-tight sm:text-xs', !reached && 'tfd-muted')}>{label}</span>
                </li>
              )
            })}
          </ol>

          <div className="tfd-line mt-4 grid gap-3 border-t pt-4 text-xs sm:grid-cols-2">
            <div>
              <p className="tfd-muted">Deliver to</p>
              <p className="font-semibold">{selected.address}</p>
              <p className="tfd-muted mt-2">Items</p>
              <p className="font-semibold">{selected.items}</p>
            </div>
            <div>
              <p className="tfd-muted">Payment</p>
              <p className="font-semibold">
                {rs(selected.total)} · {selected.payment}
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" className="tfd-btn tfd-btn-glass flex-1 px-3 py-2" onClick={() => notify(`Calling rider ${selected.rider}.`)}>
                  <Phone className="h-3.5 w-3.5" aria-hidden /> Rider {selected.rider}
                </button>
                <button type="button" className="tfd-btn tfd-btn-glass flex-1 px-3 py-2" onClick={() => notify('The customer gets this same tracking page by SMS link.')}>
                  <Store className="h-3.5 w-3.5" aria-hidden /> Share link
                </button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
