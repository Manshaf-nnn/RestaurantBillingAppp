import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { toAppError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'
import { enforceRateLimit } from '@/server/security/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_BYTES = 8 * 1024 * 1024
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/**
 * Read a printed menu from a photo.
 *
 * Typing a 60-item menu into a form is the single biggest reason a restaurant
 * signs up and never goes live. Almost all of them already have the menu
 * printed, so one photo plus a review pass replaces the entire evening of data
 * entry. Nothing is written here — the response feeds a review table the owner
 * corrects before saving, because a misread price is worse than a blank field.
 */
/**
 * The schema is written out as raw JSON Schema rather than generated from the
 * Zod object below. The SDK's `zodOutputFormat` helper requires Zod 4 and this
 * project is on Zod 3, so the two are declared side by side: JSON Schema
 * constrains the model, and the Zod object validates what comes back.
 */
const MENU_SCAN_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'Every dish on the menu, in the order printed.',
      items: {
        type: 'object',
        properties: {
          categoryName: {
            type: 'string',
            description:
              'Section heading this item sits under, e.g. "Starters". Infer a sensible one if the menu has no headings.',
          },
          name: { type: 'string', description: 'The dish name exactly as printed.' },
          description: {
            type: 'string',
            description:
              'The description printed under the dish, or an empty string when there is none.',
          },
          price: {
            type: 'number',
            description:
              "Numeric price in the menu's own currency, e.g. 450 or 4.5. Use 0 when unreadable.",
          },
          isVeg: {
            type: 'boolean',
            description: 'True only when the menu marks it vegetarian.',
          },
          spiceLevel: {
            type: 'string',
            enum: ['NONE', 'MILD', 'MEDIUM', 'HOT', 'EXTRA_HOT'],
            description: 'Only when the menu indicates it; NONE otherwise.',
          },
        },
        required: ['categoryName', 'name', 'description', 'price', 'isVeg', 'spiceLevel'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const

const MenuScan = z.object({
  items: z.array(
    z.object({
      categoryName: z.string(),
      name: z.string(),
      description: z.string(),
      price: z.number(),
      isVeg: z.boolean(),
      spiceLevel: z.enum(['NONE', 'MILD', 'MEDIUM', 'HOT', 'EXTRA_HOT']),
    }),
  ),
})

export async function POST(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.MENU_MANAGE)
    await enforceRateLimit('upload')

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        {
          error:
            'Menu scanning is not set up on this deployment. Use the spreadsheet import instead.',
          code: 'SCAN_UNCONFIGURED',
        },
        { status: 501 },
      )
    }

    const form = await request.formData()
    const files = form.getAll('file').filter((entry): entry is File => entry instanceof File)

    if (files.length === 0) {
      return NextResponse.json({ error: 'Attach a photo of your menu', code: 'NO_FILE' }, { status: 400 })
    }
    if (files.length > 4) {
      return NextResponse.json(
        { error: 'Up to 4 pages at a time', code: 'TOO_MANY' },
        { status: 400 },
      )
    }
    for (const file of files) {
      if (!ALLOWED.has(file.type)) {
        return NextResponse.json(
          { error: 'Photos must be JPG, PNG, WEBP or GIF', code: 'BAD_TYPE' },
          { status: 400 },
        )
      }
      if (file.size > MAX_BYTES) {
        return NextResponse.json(
          { error: 'Each photo must be 8 MB or smaller', code: 'TOO_LARGE' },
          { status: 400 },
        )
      }
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic()

    const images = await Promise.all(
      files.map(async (file) => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: file.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
          data: Buffer.from(await file.arrayBuffer()).toString('base64'),
        },
      })),
    )

    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system:
        'You transcribe restaurant menus from photographs. Read only what is printed — never invent dishes, ' +
        'prices or descriptions, and never translate or tidy up wording. If a price is unreadable use 0 so ' +
        'the owner can spot it and fill it in. If the menu has no section headings, group dishes into sensible ' +
        'ones. Include every dish on the page.',
      messages: [
        {
          role: 'user',
          content: [
            ...images,
            {
              type: 'text',
              text: 'Transcribe every dish on this menu.',
            },
          ],
        },
      ],
      output_config: {
        format: { type: 'json_schema', schema: MENU_SCAN_SCHEMA },
      },
    })

    // Structured outputs put the JSON in the text block; validate it rather
    // than trusting the shape, so a truncated or odd response fails cleanly
    // instead of writing junk into the review table.
    const text = response.content
      .filter((block): block is { type: 'text'; text: string; citations: null } => block.type === 'text')
      .map((block) => block.text)
      .join('')

    let parsed: z.infer<typeof MenuScan>
    try {
      parsed = MenuScan.parse(JSON.parse(text))
    } catch {
      return NextResponse.json(
        { error: 'Could not read that menu. Try a clearer, straight-on photo.', code: 'UNREADABLE' },
        { status: 422 },
      )
    }

    return NextResponse.json({
      items: parsed.items.map((item) => ({ ...item, prepTimeMinutes: 15, imageUrl: '' })),
    })
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}
