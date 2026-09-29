/**
 * The words a guest receives: templates, blanks and tidying.
 *
 * Pure functions only — no database, no gateway. The end-to-end for the
 * triggers that use these lives in scripts/sms-triggers-test.ts.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/sms-messages-test.ts
 */

import {
  DEFAULT_MESSAGES,
  MESSAGE_PLACEHOLDERS,
  firstName,
  messageFor,
  renderMessage,
} from '../src/features/sms/messages'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

console.log('\nfirstName')
check('takes the first word', firstName('Nimal Perera') === 'Nimal')
check('trims', firstName('  Nimal ') === 'Nimal')
check('empty stays empty', firstName('') === '' && firstName(null) === '' && firstName(undefined) === '')

console.log('\nrenderMessage')
check(
  'fills every blank',
  renderMessage('Hi {name}, order {order} is {total}.', { name: 'Nimal', order: 'A-12', total: 'Rs 1,200' }) ===
    'Hi Nimal, order A-12 is Rs 1,200.',
)
check('a number is fine', renderMessage('Table for {party}', { party: 4 }) === 'Table for 4')
check(
  'a missing blank disappears and the comma closes up',
  renderMessage('Hi {name}, your order is ready.', {}) === 'Hi, your order is ready.',
)
check(
  'a missing blank before an exclamation mark closes up',
  renderMessage('Thank you {name}! See you soon.', { name: '' }) === 'Thank you! See you soon.',
)
check('an unknown blank is dropped, not left as braces', !renderMessage('Hi {nobody}', {}).includes('{'))
check('double spaces collapse', renderMessage('A  {x}  B', { x: '' }) === 'A B')
check('a literal brace with no letters survives', renderMessage('{ 10% }', {}) === '{ 10% }')

console.log('\nmessageFor')
const values = { name: 'Nimal', order: 'A-12', total: 'Rs 1,200', restaurant: 'Mr.Chai' }
check(
  'a blank owner template falls back to the standard wording',
  messageFor({ receipt: '   ' }, 'receipt', values) === renderMessage(DEFAULT_MESSAGES.receipt, values),
)
check(
  "the owner's own wording wins",
  messageFor({ receipt: 'Paid {total}, thanks {name}' }, 'receipt', values) === 'Paid Rs 1,200, thanks Nimal',
)

console.log('\ndefaults and placeholders')
for (const [key, template] of Object.entries(DEFAULT_MESSAGES)) {
  const used = [...template.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]!)
  const allowed = MESSAGE_PLACEHOLDERS[key as keyof typeof MESSAGE_PLACEHOLDERS]
  check(`${key}: every blank in the standard wording is a listed placeholder`, used.every((u) => allowed.includes(u)), {
    used,
    allowed,
  })
  check(`${key}: the standard wording fits one GSM segment with typical values`, template.length <= 160, template.length)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
