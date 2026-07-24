'use client'

import * as React from 'react'
import { Boxes, Eye, EyeOff, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Field } from '@/components/ui/label'
import { Input, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/features/dashboard/components/page-header'
import {
  deleteCategory,
  reorderCategories,
  saveCategory,
  toggleCategoryVisibility,
} from '../actions'

export interface ManagedCategory {
  id: string
  name: string
  description: string | null
  icon: string | null
  isVisible: boolean
  sortOrder: number
  itemCount: number
}

export function CategoryManager({
  categories: initial,
  canManage,
}: {
  categories: ManagedCategory[]
  canManage: boolean
}) {
  const [categories, setCategories] = React.useState(initial)
  const [editing, setEditing] = React.useState<ManagedCategory | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  const dragIndex = React.useRef<number | null>(null)

  React.useEffect(() => setCategories(initial), [initial])

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEdit = (category: ManagedCategory) => {
    setEditing(category)
    setDialogOpen(true)
  }

  const toggleVisible = async (category: ManagedCategory) => {
    const next = !category.isVisible
    setCategories((current) =>
      current.map((entry) => (entry.id === category.id ? { ...entry, isVisible: next } : entry)),
    )
    const result = await toggleCategoryVisibility(category.id, next)
    if (!result.ok) {
      setCategories(initial)
      toast.error(result.error)
    }
  }

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await deleteCategory(id)
    if (result.ok) {
      setCategories((current) => current.filter((category) => category.id !== id))
      toast.success('Category deleted')
    } else {
      toast.error(result.error)
    }
  }

  const onDrop = async (targetIndex: number) => {
    const from = dragIndex.current
    dragIndex.current = null
    if (from === null || from === targetIndex) return

    const reordered = [...categories]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(targetIndex, 0, moved)
    setCategories(reordered)

    const result = await reorderCategories({ ids: reordered.map((category) => category.id) })
    if (!result.ok) {
      setCategories(initial)
      toast.error(result.error)
    }
  }

  return (
    <>
      <PageHeader
        title="Categories"
        description="Group your menu. Drag to reorder — the order is used on the guest menu."
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus /> Add category
            </Button>
          ) : null
        }
      />

      {categories.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="No categories yet"
          description="Create categories like Starters, Mains and Desserts to organise your menu."
          action={
            canManage ? (
              <Button onClick={openCreate}>
                <Plus /> Add your first category
              </Button>
            ) : null
          }
        />
      ) : (
        <ul className="space-y-2">
          {categories.map((category, index) => (
            <li
              key={category.id}
              draggable={canManage}
              onDragStart={() => (dragIndex.current = index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => onDrop(index)}
              className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-soft"
            >
              {canManage ? (
                <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
              ) : null}

              {category.icon ? <span className="text-xl">{category.icon}</span> : null}

              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  {category.name}
                  {!category.isVisible ? (
                    <Badge variant="secondary" size="sm">
                      Hidden
                    </Badge>
                  ) : null}
                </p>
                {category.description ? (
                  <p className="truncate text-xs text-muted-foreground">{category.description}</p>
                ) : null}
              </div>

              <Badge variant="secondary">{category.itemCount} items</Badge>

              {canManage ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => toggleVisible(category)}
                    aria-label={category.isVisible ? 'Hide' : 'Show'}
                  >
                    {category.isVisible ? <Eye /> : <EyeOff />}
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(category)} aria-label="Edit">
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDeleteId(category.id)}
                    aria-label="Delete"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <CategoryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        category={editing}
        nextSortOrder={categories.length}
      />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete this category?"
        description="Categories with items cannot be deleted. Move the items first."
        confirmLabel="Delete"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

function CategoryDialog({
  open,
  onOpenChange,
  category,
  nextSortOrder,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  category: ManagedCategory | null
  nextSortOrder: number
}) {
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [icon, setIcon] = React.useState('')
  const [isVisible, setIsVisible] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setName(category?.name ?? '')
    setDescription(category?.description ?? '')
    setIcon(category?.icon ?? '')
    setIsVisible(category?.isVisible ?? true)
  }, [open, category])

  const save = async () => {
    setError(null)
    setSaving(true)
    const result = await saveCategory({
      id: category?.id,
      name,
      description,
      icon,
      isVisible,
      sortOrder: category?.sortOrder ?? nextSortOrder,
    })
    setSaving(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success('Category saved')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{category ? 'Edit category' : 'New category'}</DialogTitle>
          <DialogDescription>Categories organise the guest menu.</DialogDescription>
        </DialogHeader>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Starters" />
        </Field>

        <Field label="Emoji icon" hint="Optional — shown as a chip on the menu">
          <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="🥗" maxLength={4} />
        </Field>

        <Field label="Description" hint="Optional">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <Switch checked={isVisible} onCheckedChange={setIsVisible} />
          Visible on the guest menu
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
