'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, Minus, RotateCcw, Save, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import { setStaffPermissions } from '../actions'

/**
 * One person's access, in the three blocks the spec names (staff.A.md §3, §8):
 * what the role gives, what was changed for them alone, and what that adds up
 * to.
 *
 * ── Why three states and not a checkbox ─────────────────────────────────────
 *
 * A checkbox has two positions and this question has three. "Off" is not the
 * same as "not overridden": if an owner unticks a permission the role does not
 * grant anyway, nothing has happened; if they untick one the role DOES grant,
 * that is a denial that has to survive a later edit to the role. Collapsing the
 * two would mean every save wrote a denial for every permission the person
 * happens not to hold — hundreds of rows saying nothing, and a role change that
 * could then never reach them.
 *
 * So each row is Inherit / Allow / Deny, and Inherit is the default. The
 * effective column is computed the same way the server computes it, and the
 * summary at the top counts only genuine differences.
 */

export type Override = 'inherit' | 'allow' | 'deny'

export interface AccessAction {
  permission: string
  label: string
  hint?: string
  /** True when the ROLE grants it, before any override. */
  inherited: boolean
}

export interface AccessFeature {
  key: string
  label: string
  group: string
  description?: string
  actions: AccessAction[]
}

function effective(inherited: boolean, override: Override): boolean {
  if (override === 'allow') return true
  if (override === 'deny') return false
  return inherited
}

export function AccessEditor({
  userId,
  userName,
  roleLabel,
  roleSource,
  features,
  initial,
  canEdit,
}: {
  userId: string
  userName: string
  roleLabel: string
  /** Where the defaults come from: a saved role, or the built-in preset. */
  roleSource: string
  features: AccessFeature[]
  initial: Record<string, Override>
  canEdit: boolean
}) {
  const router = useRouter()
  const [state, setState] = React.useState<Record<string, Override>>(initial)
  const [saving, setSaving] = React.useState(false)

  // What was loaded, so Reset and the dirty check compare against the server's
  // answer rather than against "everything inherited".
  const baseline = React.useRef(initial)
  React.useEffect(() => {
    baseline.current = initial
    setState(initial)
  }, [initial])

  const at = (permission: string): Override => state[permission] ?? 'inherit'
  const dirty = React.useMemo(() => {
    const keys = new Set([...Object.keys(state), ...Object.keys(baseline.current)])
    return [...keys].some((key) => (state[key] ?? 'inherit') !== (baseline.current[key] ?? 'inherit'))
  }, [state])

  const set = (permission: string, next: Override) => {
    if (!canEdit) return
    setState((current) => ({ ...current, [permission]: next }))
  }

  const allowed: string[] = []
  const denied: string[] = []
  for (const feature of features) {
    for (const action of feature.actions) {
      const override = at(action.permission)
      if (override === 'allow') allowed.push(action.permission)
      if (override === 'deny') denied.push(action.permission)
    }
  }

  /*
   * Only overrides that CHANGE something are counted. Allowing a permission the
   * role already grants is a no-op, and counting it would tell an owner they
   * have made six exceptions when they have made one.
   */
  const meaningful = features.flatMap((feature) =>
    feature.actions.filter((action) => {
      const override = at(action.permission)
      return override !== 'inherit' && effective(action.inherited, override) !== action.inherited
    }),
  )

  const effectiveCount = features.reduce(
    (total, feature) =>
      total + feature.actions.filter((a) => effective(a.inherited, at(a.permission))).length,
    0,
  )
  const inheritedCount = features.reduce(
    (total, feature) => total + feature.actions.filter((a) => a.inherited).length,
    0,
  )

  const save = async () => {
    setSaving(true)
    const result = await callAction(() => setStaffPermissions({ userId, allow: allowed, deny: denied }))
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    baseline.current = state
    toast.success(`${userName}'s access updated`)
    // Permissions are re-read per request, so a refresh is all it takes for
    // this screen — and for them — to show the new answer.
    router.refresh()
  }

  const groups = [...new Set(features.map((f) => f.group))]

  return (
    <div className="space-y-5">
      <SectionCard
        title="Inherited + overrides = effective"
        description={`${userName} works on ${roleSource}. Everything below starts from that; an override changes one permission for this person only, and survives a later change to the role.`}
        actions={
          canEdit ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => setState(baseline.current)}
              >
                <RotateCcw /> Reset
              </Button>
              <Button size="sm" loading={saving} disabled={!dirty || saving} onClick={save}>
                <Save /> Save access
              </Button>
            </div>
          ) : null
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure label={`Role default (${roleLabel})`} value={inheritedCount} hint="permissions the role gives" />
          <Figure
            label="Individual overrides"
            value={meaningful.length}
            hint={meaningful.length === 0 ? 'none — they have exactly what the role gives' : 'changes for this person only'}
            tone={meaningful.length > 0 ? 'warning' : 'default'}
          />
          <Figure label="Final effective access" value={effectiveCount} hint="what they can actually do" tone="success" />
        </div>

        {meaningful.length > 0 ? (
          <ul className="mt-4 space-y-1.5 border-t pt-4 text-sm">
            {meaningful.map((action) => (
              <li key={action.permission} className="flex flex-wrap items-center gap-2">
                {at(action.permission) === 'deny' ? (
                  <Badge variant="destructive" size="sm">Denied</Badge>
                ) : (
                  <Badge variant="success" size="sm">Allowed</Badge>
                )}
                <span>{action.label}</span>
                <span className="text-muted-foreground">
                  {at(action.permission) === 'deny'
                    ? '— the role grants this and they may not use it'
                    : '— the role does not grant this and they may'}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>

      {groups.map((group) => (
        <SectionCard key={group} title={group}>
          <div className="space-y-5">
            {features
              .filter((feature) => feature.group === group)
              .map((feature) => (
                <div key={feature.key}>
                  <h3 className="text-sm font-semibold">{feature.label}</h3>
                  {feature.description ? (
                    <p className="mb-2 text-xs text-muted-foreground">{feature.description}</p>
                  ) : null}
                  <ul className="divide-y divide-border rounded-lg border">
                    {feature.actions.map((action) => {
                      const override = at(action.permission)
                      const now = effective(action.inherited, override)
                      return (
                        <li
                          key={action.permission}
                          className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm"
                        >
                          <div className="min-w-48 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{action.label}</span>
                              {now ? (
                                <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                              ) : (
                                <ShieldAlert className="size-3.5 text-muted-foreground" />
                              )}
                            </div>
                            {action.hint ? (
                              <p className="text-xs text-muted-foreground">{action.hint}</p>
                            ) : null}
                          </div>

                          <span className="text-xs text-muted-foreground">
                            Role: {action.inherited ? 'yes' : 'no'}
                          </span>

                          <div className="flex overflow-hidden rounded-lg border" role="group" aria-label={action.label}>
                            <Choice
                              current={override}
                              value="deny"
                              disabled={!canEdit}
                              onSelect={() => set(action.permission, 'deny')}
                              icon={<X className="size-3.5" />}
                              label="Deny"
                              tone="deny"
                            />
                            <Choice
                              current={override}
                              value="inherit"
                              disabled={!canEdit}
                              onSelect={() => set(action.permission, 'inherit')}
                              icon={<Minus className="size-3.5" />}
                              label="Inherit"
                              tone="inherit"
                            />
                            <Choice
                              current={override}
                              value="allow"
                              disabled={!canEdit}
                              onSelect={() => set(action.permission, 'allow')}
                              icon={<Check className="size-3.5" />}
                              label="Allow"
                              tone="allow"
                            />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
          </div>
        </SectionCard>
      ))}
    </div>
  )
}

function Figure({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: number
  hint: string
  tone?: 'default' | 'success' | 'warning'
}) {
  const colour =
    tone === 'success'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warning'
        ? 'text-amber-600 dark:text-amber-400'
        : ''
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold ${colour}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function Choice({
  current,
  value,
  disabled,
  onSelect,
  icon,
  label,
  tone,
}: {
  current: Override
  value: Override
  disabled: boolean
  onSelect: () => void
  icon: React.ReactNode
  label: string
  tone: 'deny' | 'inherit' | 'allow'
}) {
  const active = current === value
  const activeClass =
    tone === 'deny'
      ? 'bg-destructive text-destructive-foreground'
      : tone === 'allow'
        ? 'bg-emerald-600 text-white'
        : 'bg-muted text-foreground'
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onSelect}
      title={label}
      className={`flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        active ? activeClass : 'bg-background text-muted-foreground hover:bg-muted'
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}
