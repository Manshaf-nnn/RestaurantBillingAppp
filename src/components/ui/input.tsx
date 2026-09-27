import * as React from 'react'

import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  startIcon?: React.ReactNode
  endIcon?: React.ReactNode
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, startIcon, endIcon, ...props }, ref) => {
    const field = (
      <input
        type={type}
        className={cn(
          /*
           * `text-base` on a phone, `text-sm` from `sm` up.
           *
           * Safari on iOS zooms the page whenever a focused field's text is
           * under 16px, and will not zoom back out — so tapping Name on the
           * QR checkout left the guest on a magnified, sideways-scrolling
           * page for the rest of their order. 16px is the whole fix.
           *
           * The alternative everybody reaches for, `maximum-scale=1` on the
           * viewport, also works and takes pinch-zoom away from everyone who
           * needs it to read. Never that.
           */
          'flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm shadow-sm transition-colors',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive',
          startIcon && 'pl-9',
          endIcon && 'pr-9',
          className,
        )}
        ref={ref}
        {...props}
      />
    )

    /*
     * Whether the props were PASSED, not whether they are truthy.
     *
     * These two shapes put the `<input>` at different depths, so a caller doing
     * `endIcon={busy ? <Spinner/> : null}` used to flip between them mid-type.
     * React sees the element type at that position change from `input` to `div`,
     * unmounts the input and mounts a fresh one — and the caret goes with it.
     * On the POS phone box that meant the cursor vanished on the third digit,
     * came back 250ms later, and vanished again on the fourth: a number could
     * only be typed by clicking the field before every keystroke.
     *
     * Testing for `undefined` keeps the structure stable for anyone who passes
     * the prop at all, while a caller that passes no icons still gets the bare
     * input — which matters, because `className` lands on the input and several
     * screens put grid placement there.
     */
    if (startIcon === undefined && endIcon === undefined) return field

    return (
      <div className="relative">
        {startIcon ? (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">
            {startIcon}
          </span>
        ) : null}
        {field}
        {endIcon ? (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">
            {endIcon}
          </span>
        ) : null}
      </div>
    )
  },
)
Input.displayName = 'Input'

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    className={cn(
      // 16px on phones for the same reason as Input — see its note.
      'flex min-h-[80px] w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm shadow-sm transition-colors',
      'placeholder:text-muted-foreground',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'aria-[invalid=true]:border-destructive',
      className,
    )}
    ref={ref}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export { Input, Textarea }
