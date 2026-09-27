'use client'

import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { callAction } from '@/lib/use-action'
import {
  checkNeonNowAction,
  clearNeonConfigAction,
  saveNeonConfigAction,
} from '@/features/platform/neon-actions'
import type { NeonProjectSummary, PublicNeonConfig } from '@/server/neon/types'

/**
 * The operator's Neon settings: one form, no cleverness.
 *
 * The API key field is write-only — it shows the last four characters of what
 * is stored and never the key itself, and leaving it blank keeps the stored
 * key. Every button reloads the page afterwards so what is shown is what the
 * server actually did (the ops-controls rule).
 */
export function NeonPanel({
  config,
  projects,
  adminEmail,
}: {
  config: PublicNeonConfig
  projects: NeonProjectSummary[]
  adminEmail: string
}) {
  const [apiKey, setApiKey] = React.useState('')
  const [projectId, setProjectId] = React.useState(config.projectId ?? '')
  const [alertEmail, setAlertEmail] = React.useState(config.alertEmail ?? adminEmail)
  const [reminderDays, setReminderDays] = React.useState(String(config.reminderDaysBefore))
  const [computeBudget, setComputeBudget] = React.useState(config.budgets.computeHours?.toString() ?? '')
  const [storageBudget, setStorageBudget] = React.useState(config.budgets.storageGb?.toString() ?? '')
  const [transferBudget, setTransferBudget] = React.useState(config.budgets.transferGb?.toString() ?? '')
  const [busy, setBusy] = React.useState(false)

  const run = async (
    call: () => Promise<{ ok: boolean; error?: string; message?: string }>,
    success: string,
  ) => {
    setBusy(true)
    const result = await callAction(call as never)
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(success)
    window.location.reload()
  }

  const save = () =>
    run(
      () =>
        saveNeonConfigAction({
          apiKey,
          projectId,
          alertEmail,
          reminderDaysBefore: reminderDays,
          computeHoursBudget: computeBudget,
          storageGbBudget: storageBudget,
          transferGbBudget: transferBudget,
        }),
      config.configured ? 'Neon settings saved.' : 'Neon connected.',
    )

  const disconnect = () => {
    if (!window.confirm('Forget the Neon API key and stop watching the database?')) return
    void run(() => clearNeonConfigAction(), 'Neon disconnected.')
  }

  const selectClass =
    'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

  return (
    <Card>
      <CardHeader>
        <CardTitle>{config.configured ? 'Neon settings' : 'Connect Neon'}</CardTitle>
        <CardDescription>
          An API key lets the platform read usage, endpoint state and billing dates every hour, and
          warn you before something refuses connections. It cannot change, delete or restore
          anything. The database password is not asked for: the application already holds it in
          DATABASE_URL.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Neon API key"
            htmlFor="neon-api-key"
            hint={
              config.apiKeyHint
                ? `Saved · ends “${config.apiKeyHint}”${config.source === 'env' ? ' (from the server environment)' : ''}. Leave blank to keep it.`
                : 'Neon console → Account settings → API keys → Create. Make it in the organisation that owns the production project.'
            }
          >
            <Input
              id="neon-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={config.apiKeyHint ? '•••••••••••• (unchanged)' : 'napi_…'}
            />
          </Field>

          <Field
            label="Project"
            htmlFor="neon-project"
            hint={
              projects.length
                ? 'The project that holds the production database.'
                : 'Save the key first and the projects it can see appear here; or paste the project id from the Neon project page.'
            }
          >
            {projects.length ? (
              <select
                id="neon-project"
                className={selectClass}
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">Choose a project…</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} · {project.regionId ?? 'region ?'} · {project.id}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id="neon-project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                placeholder="e.g. purple-waterfall-51210000"
              />
            )}
          </Field>

          <Field label="Send alerts to" htmlFor="neon-email" hint="Every alert also appears under Errors. Email needs SMTP configured on the server.">
            <Input
              id="neon-email"
              type="email"
              value={alertEmail}
              onChange={(event) => setAlertEmail(event.target.value)}
              placeholder={adminEmail}
            />
          </Field>

          <Field
            label="Invoice reminder"
            htmlFor="neon-reminder"
            hint="Days before the billing period closes to start reminding. Neon invoices at the close and charges the card on file."
          >
            <div className="flex items-center gap-2">
              <Input
                id="neon-reminder"
                type="number"
                min={0}
                max={28}
                className="w-24"
                value={reminderDays}
                onChange={(event) => setReminderDays(event.target.value)}
              />
              <span className="text-sm text-muted-foreground">days before</span>
            </div>
          </Field>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">Budgets for this billing period (optional)</div>
          <p className="mb-3 text-xs text-muted-foreground">
            A note at 80 % and a warning when passed. These are your own ceilings, not Neon&apos;s limits —
            Neon&apos;s hard quotas, where set, are watched regardless.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Compute hours" htmlFor="neon-budget-compute">
              <Input
                id="neon-budget-compute"
                type="number"
                min={0}
                step="0.1"
                value={computeBudget}
                onChange={(event) => setComputeBudget(event.target.value)}
                placeholder="e.g. 200"
              />
            </Field>
            <Field label="Storage, GB" htmlFor="neon-budget-storage">
              <Input
                id="neon-budget-storage"
                type="number"
                min={0}
                step="0.1"
                value={storageBudget}
                onChange={(event) => setStorageBudget(event.target.value)}
                placeholder="e.g. 2"
              />
            </Field>
            <Field label="Data transfer, GB" htmlFor="neon-budget-transfer">
              <Input
                id="neon-budget-transfer"
                type="number"
                min={0}
                step="0.1"
                value={transferBudget}
                onChange={(event) => setTransferBudget(event.target.value)}
                placeholder="e.g. 20"
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={save}>
            {busy ? 'Working…' : config.configured ? 'Save' : 'Save and connect'}
          </Button>
          {config.configured ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run(() => checkNeonNowAction(), 'Checked — the figures below are current.')}
            >
              Check now
            </Button>
          ) : null}
          {config.source === 'stored' ? (
            <Button variant="ghost" disabled={busy} onClick={disconnect}>
              Disconnect
            </Button>
          ) : null}
        </div>

        {config.encryptionKey === 'fallback' ? (
          <p className="text-xs text-muted-foreground">
            The stored key is sealed with the session secret because CREDENTIAL_ENCRYPTION_KEY is not
            set on the server. That works, but rotating the session secret would then also lock this
            key — set a dedicated CREDENTIAL_ENCRYPTION_KEY when convenient.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
