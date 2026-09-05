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
  healthScore: 'One number from 0 to 100 built from six signals: sales trend, profit trend, food cost, waste, stock levels and whether the books balance.',
  daysRemaining: 'How many days the stock on hand will last at the average daily usage of the last 28 days.',
  averageUsage: 'How much of an item leaves stock per day through sales, kitchen use and production, averaged over the last 28 days. Waste is not counted.',
  recommendedOrder: 'Enough to cover the supplier’s lead time plus a week, never less than the reorder rule already suggests, rounded up to whole packs.',
  recipeCost: 'What one portion costs at today’s ingredient prices, from the active recipe. Sold lines carry the cost pinned when they sold, which can differ.',
  menuClass: 'Stars sell well and earn well; Workhorses sell well but earn little; Hidden gems earn well but sell little; Problems do neither.',
  anomaly: 'Something legal on its own that sits far outside the usual pattern. Flagged for a person to look at — never changed automatically.',
  wasteShare: 'Waste value as a share of the ingredient cost of what was sold in the same period.',
  cashCollected: 'Cash handed over by guests in the period, before refunds. Card and other methods are counted separately.',
  lowStock: 'Items at or below the higher of their reorder level and minimum stock, plus items out of stock. Live, not period-scoped.',
} as const

export type GlossaryTerm = keyof typeof GLOSSARY
