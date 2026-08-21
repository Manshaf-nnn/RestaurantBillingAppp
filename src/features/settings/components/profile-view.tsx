'use client'

import * as React from 'react'
import { LogOut, Monitor, Shield } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { changePassword, signOutEverywhereElse, updateProfile } from '@/features/auth/actions'
import { callAction } from '@/lib/use-action'

export interface SessionInfo {
  id: string
  userAgent: string | null
  ipAddress: string | null
  lastUsedAt: string
  current: boolean
}

export function ProfileView({
  profile,
  sessions,
}: {
  profile: { name: string; email: string; phone: string | null }
  sessions: SessionInfo[]
}) {
  const [name, setName] = React.useState(profile.name)
  const [phone, setPhone] = React.useState(profile.phone ?? '')
  const [savingProfile, setSavingProfile] = React.useState(false)

  const [current, setCurrent] = React.useState('')
  const [next, setNext] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [savingPassword, setSavingPassword] = React.useState(false)

  const saveProfile = async () => {
    setSavingProfile(true)
    const result = await callAction(() => updateProfile({ name, phone, avatarUrl: '' }))
    setSavingProfile(false)
    if (result.ok) toast.success('Profile updated')
    else toast.error(result.error)
  }

  const savePassword = async () => {
    setSavingPassword(true)
    const result = await callAction(() => changePassword({ currentPassword: current, password: next, confirmPassword: confirm }))
    setSavingPassword(false)
    if (result.ok) {
      toast.success('Password changed')
      setCurrent('')
      setNext('')
      setConfirm('')
    } else {
      toast.error(result.error)
    }
  }

  return (
    <>
      <PageHeader title="My profile" description="Your account and security" />

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Profile">
          <div className="space-y-4">
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" hint="Contact your manager to change your email">
              <Input value={profile.email} disabled />
            </Field>
            <Field label="Phone">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Button onClick={saveProfile} loading={savingProfile}>
              Save profile
            </Button>
          </div>
        </SectionCard>

        <SectionCard title="Change password">
          <div className="space-y-4">
            <Field label="Current password" required>
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            <Field label="New password" required>
              <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            </Field>
            <Field label="Confirm new password" required>
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </Field>
            <Button onClick={savePassword} loading={savingPassword}>
              <Shield /> Update password
            </Button>
          </div>
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard
          title="Active sessions"
          description="Devices signed in to your account"
          bodyClassName="p-0"
          actions={
            sessions.length > 1 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const result = await callAction(() => signOutEverywhereElse())
                  if (result.ok) toast.success(`Signed out ${result.data.revoked} other device(s)`)
                  else toast.error(result.error)
                }}
              >
                <LogOut /> Sign out others
              </Button>
            ) : null
          }
        >
          <ul className="divide-y">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-3 px-5 py-3">
                <Monitor className="size-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {session.userAgent?.slice(0, 60) ?? 'Unknown device'}
                    {session.current ? (
                      <span className="ml-2 text-xs font-normal text-success">This device</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {session.ipAddress ?? '—'} · {new Date(session.lastUsedAt).toLocaleString()}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </>
  )
}
