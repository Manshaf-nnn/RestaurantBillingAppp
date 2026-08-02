import { z } from 'zod'

/** 1 = 😞 … 4 = 😍 . No personal details — feedback stays anonymous. */
export const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(4),
  comment: z.string().trim().max(300).optional().or(z.literal('')),
  tableNumber: z.string().trim().max(20).optional().or(z.literal('')),
})
export type FeedbackInput = z.infer<typeof feedbackSchema>
