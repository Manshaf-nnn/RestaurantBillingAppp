import { z } from 'zod'

export const shiftNoteSchema = z.object({
  body: z.string().trim().min(1, 'Write a note').max(500),
})
export type ShiftNoteInput = z.infer<typeof shiftNoteSchema>
