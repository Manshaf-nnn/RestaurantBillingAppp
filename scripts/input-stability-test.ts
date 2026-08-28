/**
 * The `<Input>` primitive must not change shape when an icon appears.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 *
 * `Input` renders a bare `<input>` with no icons and a `<div class="relative">`
 * wrapper with them. It used to choose between those on **truthiness**, so a
 * caller doing `endIcon={busy ? <Spinner/> : null}` flipped between the two
 * shapes as its own state changed. React compares the element type at that
 * position, sees `input` become `div`, and unmounts the input to mount a fresh
 * one — taking the caret, the selection and the IME state with it.
 *
 * On the POS phone box that was: type two digits fine, then on the third the
 * lookup starts, the spinner appears, and the cursor is gone. It came back
 * 250ms later when the spinner left, then went again on the fourth digit. A
 * cashier had to click the field before every single keystroke.
 *
 * The global search box had the identical pattern and the identical bug.
 *
 * These checks render the real component, so they fail if anyone reintroduces a
 * truthiness branch — the fix is one `=== undefined` and easy to "simplify".
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/input-stability-test.ts
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Input } from '../src/components/ui/input'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** True when the markup wraps the input rather than returning it bare. */
const wrapped = (html: string) => html.startsWith('<div')

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(Input, props))
}

function main() {
  console.log('\n── a field that never mentions icons stays bare ──')

  const plain = render({ value: '', onChange: () => {} })
  check('no icon props at all renders a bare input', !wrapped(plain), plain.slice(0, 60))
  /*
   * This one is load-bearing. `className` is forwarded to the `<input>`, not to
   * the wrapper, so screens that put grid placement on an Input — recipe-editor
   * puts `col-span-4` on one inside a 12-column grid — would break if every
   * input suddenly gained a wrapper.
   */
  const placed = render({ className: 'col-span-4', value: '', onChange: () => {} })
  check(
    'and keeps its className on the input itself, where grids expect it',
    !wrapped(placed) && placed.includes('col-span-4'),
    placed.slice(0, 80),
  )

  console.log('\n── a field that toggles an icon keeps ONE shape ──')

  const idle = render({ endIcon: null, value: '', onChange: () => {} })
  const busy = render({ endIcon: createElement('i'), value: '', onChange: () => {} })

  check('an absent icon still renders the wrapper', wrapped(idle), idle.slice(0, 60))
  check('a present icon renders the wrapper', wrapped(busy), busy.slice(0, 60))
  check(
    'so the input never changes depth mid-type, and the caret survives',
    wrapped(idle) === wrapped(busy),
    'the element type at that position changes — React will remount the input',
  )

  check(
    'the same holds for a leading icon',
    wrapped(render({ startIcon: null, value: '', onChange: () => {} })) ===
      wrapped(render({ startIcon: createElement('i'), value: '', onChange: () => {} })),
  )

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
