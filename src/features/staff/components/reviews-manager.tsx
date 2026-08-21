'use client'

import * as React from 'react'
import { MessageSquare, Star } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/primitives'
import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { cn } from '@/lib/utils'
import { replyToReview, toggleReviewPublished } from '../actions'
import { callAction } from '@/lib/use-action'

export interface ReviewRow {
  id: string
  rating: number
  foodRating: number | null
  serviceRating: number | null
  comment: string | null
  reply: string | null
  customerName: string
  orderNumber: string
  isPublished: boolean
  createdAt: string
}

export function ReviewsManager({
  reviews: initial,
  average,
  locale,
}: {
  reviews: ReviewRow[]
  average: number
  locale: string
}) {
  const [reviews, setReviews] = React.useState(initial)

  const distribution = [5, 4, 3, 2, 1].map((star) => ({
    star,
    count: reviews.filter((review) => review.rating === star).length,
  }))

  const reply = async (id: string, text: string) => {
    const result = await callAction(() => replyToReview({ id, reply: text }))
    if (result.ok) {
      setReviews((current) =>
        current.map((review) => (review.id === id ? { ...review, reply: text } : review)),
      )
      toast.success('Reply posted')
    } else {
      toast.error(result.error)
    }
  }

  const togglePublished = async (id: string, next: boolean) => {
    setReviews((current) =>
      current.map((review) => (review.id === id ? { ...review, isPublished: next } : review)),
    )
    await callAction(() => toggleReviewPublished(id, next))
  }

  return (
    <>
      <PageHeader title="Reviews" description="What your guests are saying" />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard label="Average rating" value={average ? average.toFixed(1) : '—'} icon={<Star />} tone="warning" />
        <StatCard label="Total reviews" value={reviews.length} icon={<MessageSquare />} />
        <div className="rounded-xl border bg-card p-5 shadow-soft">
          {distribution.map((row) => (
            <div key={row.star} className="mb-1 flex items-center gap-2 text-xs">
              <span className="w-3">{row.star}</span>
              <Star className="size-3 fill-warning text-warning" />
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-warning"
                  style={{ width: `${reviews.length ? (row.count / reviews.length) * 100 : 0}%` }}
                />
              </div>
              <span className="w-6 text-right text-muted-foreground">{row.count}</span>
            </div>
          ))}
        </div>
      </div>

      {reviews.length === 0 ? (
        <EmptyState icon={<Star />} title="No reviews yet" description="Reviews from guests will appear here." />
      ) : (
        <div className="space-y-3">
          {reviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              locale={locale}
              onReply={reply}
              onTogglePublished={togglePublished}
            />
          ))}
        </div>
      )}
    </>
  )
}

function ReviewCard({
  review,
  locale,
  onReply,
  onTogglePublished,
}: {
  review: ReviewRow
  locale: string
  onReply: (id: string, text: string) => void
  onTogglePublished: (id: string, next: boolean) => void
}) {
  const [replyText, setReplyText] = React.useState(review.reply ?? '')
  const [replying, setReplying] = React.useState(false)

  return (
    <div className="rounded-xl border bg-card p-4 shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex">
              {Array.from({ length: 5 }).map((_, index) => (
                <Star
                  key={index}
                  className={cn(
                    'size-4',
                    index < review.rating ? 'fill-warning text-warning' : 'text-muted-foreground/30',
                  )}
                />
              ))}
            </div>
            <span className="text-sm font-medium">{review.customerName}</span>
            <Badge variant="secondary" size="sm">
              #{review.orderNumber}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {new Date(review.createdAt).toLocaleDateString(locale)}
          </p>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch checked={review.isPublished} onCheckedChange={(v) => onTogglePublished(review.id, v)} />
          {review.isPublished ? 'Published' : 'Hidden'}
        </label>
      </div>

      {review.comment ? <p className="mt-2 text-sm">{review.comment}</p> : null}

      {review.reply ? (
        <div className="mt-3 rounded-lg border-l-2 border-primary bg-muted/40 px-3 py-2">
          <p className="text-xs font-semibold text-primary">Your reply</p>
          <p className="text-sm">{review.reply}</p>
        </div>
      ) : replying ? (
        <div className="mt-3 space-y-2">
          <Textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} rows={2} placeholder="Write a reply…" />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onReply(review.id, replyText)
                setReplying(false)
              }}
              disabled={!replyText.trim()}
            >
              Post reply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setReplying(true)}>
          <MessageSquare /> Reply
        </Button>
      )}
    </div>
  )
}
