/**
 * Plain-language accounting glossary (acCal.md UI rules): every unfamiliar
 * term gets a ⓘ with a one-sentence explanation. Short on purpose — the
 * screen explains itself first, the tooltip only unpacks the word.
 *
 * Client-safe: strings only.
 */
export const GLOSSARY = {
  cogs: 'Cost of the ingredients used to make the items sold.',
  netSales: 'What you earned from food and drink after discounts and refunds — before tax and service charge.',
  grossSales: 'The value of everything sold, before any discounts or refunds.',
  grossProfit: 'Net sales minus the ingredient cost (COGS) of what was sold.',
  foodCostPercent: 'Ingredient cost as a share of sales. Lower means each sale keeps more profit.',
  margin: 'Profit as a share of the selling price. A 1,000 sale with 400 profit is a 40% margin.',
  markup: 'Profit as a share of the cost. A 600 cost sold at 1,000 is a 66.7% markup.',
  receivables: 'Money guests were billed but have not paid yet.',
  payables: 'Money you owe suppliers for goods already received.',
  collected: 'Money actually received — cash, card and other payments, minus refunds. Not the same as sales.',
  purchases: 'Stock bought this period. It becomes a cost (COGS) only when the food is sold.',
  inventoryValue: 'What the stock on your shelves cost you.',
  reconcile: 'Compare recorded transactions with actual money and explain any difference.',
  cashDifference: 'Counted cash minus what the records expected. Short means money is missing; over means extra.',
  closeMonth: 'Lock this accounting period after all checks are complete. Nothing inside it can be changed afterwards.',
  trialBalance: 'A totals list of every account. Debits must equal credits — if not, something is wrong.',
  journal: 'Every money event written as balanced debit and credit lines, with a link to its source.',
  cashBook: 'Every movement of physical cash — in, out, and to the bank.',
  retainedEarningsDerived: 'The running total of income minus expenses since records began, computed from the books — not an entered figure.',
  explain: 'See how this number was calculated.',
  variance: 'The difference between what happened and what was expected or what happened before.',
  wastage: 'Stock thrown away, spilled or spoiled — costed at what it cost you.',
  serviceCharge: 'A percentage added to the bill for service. Kept separate from sales and tax.',
  tips: 'Money guests leave for staff. Held apart — it is never your revenue.',
} as const

export type GlossaryTerm = keyof typeof GLOSSARY
