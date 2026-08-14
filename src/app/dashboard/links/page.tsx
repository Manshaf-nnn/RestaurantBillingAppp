"use client"

import React, { useEffect, useState } from 'react'

type Invite = { id: string; role: string; expiresAt: string | null; isActive: boolean; url: string; createdAt: string }

export default function Page() {
  const [invites, setInvites] = useState<Invite[]>([])
  const [role, setRole] = useState('WAITER')
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(false)

  useEffect(() => { fetchList() }, [])

  async function fetchList() {
    const res = await fetch('/api/dashboard/invites')
    if (res.ok) setInvites(await res.json())
  }

  async function createInvite() {
    setLoading(true)
    const res = await fetch('/api/dashboard/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, days }) })
    setLoading(false)
    if (res.ok) {
      const j = await res.json()
      setInvites((s) => [j as Invite, ...s])
    }
  }

  async function revoke(id: string) {
    await fetch(`/api/dashboard/invites?id=${id}`, { method: 'DELETE' })
    setInvites((s) => s.map((i) => (i.id === id ? { ...i, isActive: false } : i)))
  }

  async function copy(url: string) {
    await navigator.clipboard.writeText(url)
    alert('Link copied to clipboard')
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Shareable Staff Links</h1>

      <div className="mb-6 flex items-end gap-3">
        <label className="flex flex-col">
          <span className="text-sm text-muted-foreground">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)} className="mt-1 border rounded px-2 py-1">
            <option value="KITCHEN">Kitchen</option>
            <option value="CASHIER">Cashier</option>
            <option value="WAITER">Waiter</option>
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-sm text-muted-foreground">Expires (days)</span>
          <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} className="mt-1 border rounded px-2 py-1 w-28" />
        </label>
        <button onClick={createInvite} disabled={loading} className="bg-primary text-white px-4 py-2 rounded">{loading ? 'Creating…' : 'Create link'}</button>
      </div>

      <div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-sm text-muted-foreground">
              <th>Role</th>
              <th>Link</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.id} className="border-t">
                <td className="py-3">{i.role}</td>
                <td className="py-3 text-sm text-primary underline">{i.url}</td>
                <td className="py-3">{i.expiresAt ? new Date(i.expiresAt).toLocaleString() : 'never'}</td>
                <td className="py-3">
                  <button onClick={() => copy(i.url)} className="mr-2 px-3 py-1 border rounded">Copy</button>
                  {i.isActive ? <button onClick={() => revoke(i.id)} className="px-3 py-1 border rounded">Revoke</button> : <span className="text-sm text-muted-foreground">Revoked</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
