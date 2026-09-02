'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import { saveExpenseCategoryAction } from '../actions'

/** The category book: add, rename, retire. Retiring hides it from new
 * expenses; history keeps its name. */
export function CategoryManager({
  categories,
  canManage,
}: {
  categories: Array<{ id: string; name: string; isActive: boolean }>
  canManage: boolean
}) {
  const router = useRouter()
  const [name, setName] = React.useState('')
  const [pending, setPending] = React.useState(false)

  const save = async (input: { id?: string; name: string; isActive: boolean }) => {
    setPending(true)
    const result = await callAction(() => saveExpenseCategoryAction(input))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setName('')
    router.refresh()
  }

  return (
    <SectionCard
      title="Expense categories"
      description="The book reports group by. Retire what you no longer use — history keeps the name."
    >
      {canManage ? (
        <div className="mb-4 flex gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New category, e.g. Insurance"
            className="max-w-xs"
          />
          <Button
            loading={pending}
            disabled={name.trim().length < 2}
            onClick={() => save({ name: name.trim(), isActive: true })}
          >
            Add
          </Button>
        </div>
      ) : null}
      <ul className="divide-y text-sm">
        {categories.map((category) => (
          <li key={category.id} className="flex items-center justify-between gap-3 py-2">
            <span className={category.isActive ? '' : 'text-muted-foreground line-through'}>
              {category.name}
            </span>
            <span className="flex items-center gap-2">
              {!category.isActive ? <Badge variant="outline">retired</Badge> : null}
              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    save({ id: category.id, name: category.name, isActive: !category.isActive })
                  }
                >
                  {category.isActive ? 'Retire' : 'Restore'}
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}
