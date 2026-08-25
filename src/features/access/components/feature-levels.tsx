'use client'

import * as React from 'react'

import {
  FEATURES,
  FEATURE_GROUPS,
  levelOf,
  permissionsForLevel,
  withLevel,
  type Feature,
  type FeatureLevel,
} from '../features'

/**
 * The coarse view of a permission set: one feature, three words.
 *
 * ── Why this exists next to the role builder rather than inside it ──────────
 *
 * The role builder is exact — every action its own switch — because a role is
 * composed once by somebody who wants precision. This is the other audience: an
 * owner adding a location, answering "can the Kandy manager work the till or
 * only look at it". Asking them to reason about `payment.view` against
 * `payment.collect` against `payment.refund` to say that is how a setup screen
 * gets abandoned half-finished.
 *
 * Both write the same thing — a flat `Set<string>` of permission ids — so a
 * grid filled in here can be opened and refined under Roles & access, and a
 * role built there reads back here without being mangled.
 *
 * ── `custom` is shown, never rounded ────────────────────────────────────────
 *
 * A role built action-by-action often sits between two of these words.
 * `levelOf` returns `custom` for that, and this renders it as a fourth,
 * unselectable state saying where to go and change it. Rounding it to the
 * nearest word would silently rewrite somebody's careful work the first time
 * this screen was opened and saved — the worst kind of data loss, because
 * nothing appears to have happened.
 */

const LEVELS: Array<{ value: Exclude<FeatureLevel, 'custom'>; label: string; hint: string }> = [
  { value: 'off', label: 'Off', hint: 'Hidden from the menu, and the URL is refused' },
  { value: 'read', label: 'Read', hint: 'Can open it and look; cannot change anything' },
  { value: 'full', label: 'Full', hint: 'Everything this feature allows' },
]

export function FeatureLevelGrid({
  granted,
  onChange,
  grantable,
  disabled = false,
}: {
  granted: Set<string>
  onChange: (next: Set<string>) => void
  /**
   * What the person filling this in holds themselves. The server refuses
   * anything beyond it — `assertNoEscalation` — but a control that always
   * fails is worse than one that is not offered, so those are greyed out and
   * say why.
   */
  grantable: Set<string>
  disabled?: boolean
}) {
  return (
    <div className="space-y-5">
      {FEATURE_GROUPS.map((group) => {
        const features = FEATURES.filter((f) => f.group === group)
        if (features.length === 0) return null
        return (
          <div key={group}>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group}
            </p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {features.map((feature) => (
                <FeatureLevelRow
                  key={feature.key}
                  feature={feature}
                  granted={granted}
                  grantable={grantable}
                  disabled={disabled}
                  onChange={onChange}
                />
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function FeatureLevelRow({
  feature,
  granted,
  grantable,
  disabled,
  onChange,
}: {
  feature: Feature
  granted: Set<string>
  grantable: Set<string>
  disabled: boolean
  onChange: (next: Set<string>) => void
}) {
  const level = levelOf(feature, granted)

  /*
   * Grantable per LEVEL, not per feature. Somebody may hold a feature's view
   * and not its manage permission — they can hand out Read and not Full, and
   * the control should show exactly that rather than all-or-nothing.
   */
  const can = (value: Exclude<FeatureLevel, 'custom'>) =>
    value === 'off' ||
    feature.actions
      .filter((a) => permissionsForLevel(feature, value).includes(a.permission))
      .every((a) => grantable.has(a.permission))

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{feature.label}</p>
        <p className="text-xs text-muted-foreground">
          {level === 'custom'
            ? 'Set up in detail under Roles & access — left as it is.'
            : (LEVELS.find((l) => l.value === level)?.hint ?? feature.description)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border p-0.5">
        {LEVELS.map((option) => {
          const active = level === option.value
          const allowed = can(option.value)
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled || !allowed}
              title={allowed ? option.hint : 'You do not have this yourself, so you cannot grant it'}
              aria-pressed={active}
              onClick={() => onChange(withLevel(granted, feature, option.value))}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              } disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {option.label}
            </button>
          )
        })}
        {level === 'custom' ? (
          <span className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            Custom
          </span>
        ) : null}
      </div>
    </li>
  )
}
