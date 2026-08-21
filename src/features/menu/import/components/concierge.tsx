'use client'

import * as React from 'react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input, Textarea } from '@/components/ui/input'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { requestConciergeSetup } from '../actions'
import { callAction } from '@/lib/use-action'

/**
 * Hand the whole job over.
 *
 * The fallback when every other route fails — a handwritten menu the scanner
 * cannot read, an owner who would rather not touch a spreadsheet, or someone
 * who simply wants to be open tomorrow. It costs staff time rather than owner
 * time, which for the first customers is the right trade.
 */
export function Concierge({ defaultName }: { defaultName: string }) {
  const [form, setForm] = React.useState({
    contactName: defaultName,
    contactPhone: '',
    contactEmail: '',
    itemCount: '',
    notes: '',
  })
  const [sending, setSending] = React.useState(false)
  const [sent, setSent] = React.useState(false)

  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }))

  const submit = async () => {
    setSending(true)
    const result = await callAction(() => requestConciergeSetup(form))
    setSending(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSent(true)
    toast.success('Request sent — we will be in touch')
  }

  if (sent) {
    return (
      <SectionCard title="We have your request">
        <p className="text-sm text-muted-foreground">
          Send your menu — a photo, a PDF, or a link — to whoever set up your account, and we will
          load it for you. You can keep using every other option here in the meantime.
        </p>
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title="Have us set it up for you"
      description="Send your menu over and we will enter it. Best if your menu is handwritten or you would rather not do it yourself."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name" required>
          <Input
            value={form.contactName}
            onChange={(event) => set('contactName', event.target.value)}
          />
        </Field>
        <Field label="Phone" required hint="How we reach you about it">
          <Input
            value={form.contactPhone}
            onChange={(event) => set('contactPhone', event.target.value)}
            placeholder="+94 77 123 4567"
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={form.contactEmail}
            onChange={(event) => set('contactEmail', event.target.value)}
          />
        </Field>
        <Field label="Roughly how many dishes?">
          <Input
            value={form.itemCount}
            onChange={(event) => set('itemCount', event.target.value)}
            placeholder="about 60"
          />
        </Field>
        <Field label="Anything we should know?" className="sm:col-span-2">
          <Textarea
            rows={3}
            value={form.notes}
            onChange={(event) => set('notes', event.target.value)}
            placeholder="Two menus — lunch and dinner. Prices changed last week."
          />
        </Field>
      </div>

      <Button
        className="mt-4"
        onClick={submit}
        loading={sending}
        disabled={!form.contactName.trim() || form.contactPhone.trim().length < 5}
      >
        <Send /> Send request
      </Button>
    </SectionCard>
  )
}
