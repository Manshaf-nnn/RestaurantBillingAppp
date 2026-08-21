# TableFlow — how it all works

Written for the person who owns the restaurant, not the person who wrote the code.

One idea underpins everything: **stock is never a number someone types. It is the
running total of things that happened to it.** Every kilogram that arrives, is
sold, is wasted, is moved or is cooked leaves a dated, named row in the stock
ledger, and the number you see on screen is the sum of those rows. That is why
the books can always be proved right — and why there is a screen that proves it.

---

## 1. The four kinds of place

Everything in TableFlow happens *somewhere*. There are three kinds of location and
they are the same underneath — the same stock, the same ledger, the same
transfers — they only differ in what they are for.

| | What it is for |
|---|---|
| **Branch** | A place that serves guests. Tables, a kitchen, a till. |
| **Central warehouse** | Receives bulk deliveries and supplies the others. No guests. |
| **Production house** | Makes food from raw materials. No guests. |

Inside any of them you can name **storage areas** — Cold room, Dry store, Bar.
These are *shelves*. They hold stock; they are not stock themselves. Naming one
"Sugar" does not give you any sugar.

**You do not have to use any of this.** A single restaurant with one kitchen gets
one location called Main and never thinks about it again.

---

## 2. How stock gets in

Three ways, and only three.

**A purchase order.** Suppliers → Purchases → New. You choose the supplier, the
items, and — this matters — **where the delivery lands**. Raising the order moves
no stock: *an order is a promise, not a delivery.* When the goods arrive you open
the order and press Receive, entering what actually turned up. That is the moment
stock exists.

> You can receive **less** than you ordered. Do it — record what arrived, not what
> was promised. The order stays open for the rest, and the shortfall is visible.

**Add stock here.** On any location's page. For an opening count when you start
using the system, or a delivery that arrived without an order. Item, quantity,
optional shelf. It goes straight onto that location's shelves.

**A transfer in**, from another location. Section 4.

That is all. There is deliberately no "just change the number" — a balance that
can be typed over is a balance nobody can trust.

---

## 3. How stock goes out

**A sale.** When the kitchen accepts an order, TableFlow reads the recipe for each
dish and takes the ingredients off *that branch's* shelves. Sell three burgers at
Kandy and Kandy loses three patties, six bun halves, three slices of cheese.

Change the order and it corrects itself — reduce it to one burger and two
patties come back. Cancel it and everything comes back. Void a line at the till
and that line's ingredients come back. You never have to remember to undo
anything.

**Wastage.** Stock → Wastage. Always with a reason, because "we lost 4kg of
chicken" and "we lost 4kg of chicken because the fridge failed" are different
facts and only the second one lets you fix something.

**A transfer out**, or **production consuming it**.

If you try to sell what you have not got, TableFlow stops you. You can turn that
off in Settings if you would rather never block service — the balance then goes
negative and shows as an alert instead. Your call; both are defensible.

---

## 4. Moving stock between places

A transfer has four steps, and each one exists because something real happens at
that moment.

| Step | What physically happens | What the system does |
|---|---|---|
| **Request** | Nothing. | A question: "can Kandy have 20kg of sugar?" No stock moves. |
| **Approve** | Nothing yet. | Sets 20kg aside at the warehouse — **reserved**. Still on the warehouse's shelf, but promised. Nobody can sell it out from under the transfer. |
| **Dispatch** | The van leaves. | Warehouse loses 20kg. Kandy shows 20kg **in transit** — on its way, not yet usable. |
| **Receive** | The van arrives. | Kandy gains what actually arrived. |

That middle bit is the whole point. Between dispatch and receipt the sugar is
**nowhere you can sell it** — and it is not lost either, it is visibly in transit.

**If 18kg arrives instead of 20**, you enter 18 and TableFlow *makes you say why*:
damaged, missing, rejected. The 2kg does not quietly evaporate; it is a recorded
variance you can go and ask about.

You can also move stock **between two shelves in the same location** — Main store
to Cold room. Pick the same location on both sides and choose two different
storage areas. The location's total does not change; only where it sits.

---

## 5. Recipes, and why they matter more than they look

A recipe links a dish to what it consumes. Without one, selling a burger takes
nothing off any shelf, and your food cost is unknowable.

Two kinds:

- **Menu recipe** — one burger uses 1 patty, 2 bun halves, 1 slice of cheese.
- **Prep recipe** — one batch of burger sauce uses mayo, ketchup, spices, and
  makes 2kg. A menu recipe can then use "50g of burger sauce" as an ingredient.

Recipes support **wastage %** per line: trim, peel, spillage. If 100g reaches the
plate but 105g leaves the store, say 5% and the books will match the bin.

**Recipes are versioned.** Change a recipe that has already been sold against and
TableFlow keeps the old version and starts a new one. Last month's cost stays
last month's cost. This is not fussiness — without it, editing a recipe silently
rewrites your history and every margin you have ever reported.

---

## 6. Production — making things in-house

Production is for anything you **make** rather than buy: bread, sauces, marinades,
butchered cuts. It turns raw materials into a new stock item.

You need a **production house** (Locations → New → Production house), because
making things is not the same job as serving guests and the stock has to be
somewhere while it is being made.

**The recipe (spec):** "One batch = 10kg flour + 200g yeast + 5g salt, and makes
10 loaves. Shelf life 3 days."

**The run:**

1. **Plan** — "make 10 batches." Nothing moves.
2. **Approve** — someone senior signs it off. Nothing moves.
3. **Complete** — enter how many batches you *actually* got.

At Complete, and only then, three things happen at once: the raw materials come
off the production house's shelves, the finished loaves appear on them, and the
cost is worked out.

### The costing rule, which is the point of the whole feature

You planned 10 batches — 100kg of flour went into the mixers. Only 8 batches came
out; two caught and were binned.

**All 100kg is consumed.** The flour was used whether or not it became bread. The
cost of the whole run is divided by the **80 loaves you actually got**, so each
loaf costs more than it would have on a good day.

That is the true picture, and it is why the variance figure is compulsory. A
system that quietly consumed only 80 loaves' worth of flour would report a
disastrous run as perfectly efficient — and you would never know your night shift
was burning a fifth of your production.

You can add **overhead** — labour, power — and it lands in the same per-unit cost.

Finished goods sit at the production house. Send them out with a normal transfer.

---

## 7. Who sees what

Everyone signs in with their **email** and their **sign-in code** — an 8-character
code on a card. `W-0003` is a different thing: that is their ID, the one that
appears on dockets and in "who served table 4".

Assign someone to a location and they see **only that location**. The Kandy
manager sees Kandy's stock, Kandy's orders, Kandy's takings. Leave the location
blank and they see everything — that is your group manager.

**Things to do** is each location's list of what is waiting: stock arriving to
receive, transfers to send, approvals, and any instruction you have left for them.
That is how you tell a branch to do something and know they have seen it.

---

## 8. The screen that proves the books

**Reports → Reconciliation.** For every item:

```
Opening              100 kg
  + purchases         50 kg
  + transferred in     0 kg
  − sold              30 kg
  − wasted             5 kg
  = closing          115 kg      ← what the ledger says
    stored quantity  115 kg      ← what the system holds
    drift              0         ← must be zero
```

**Drift must be zero.** Anything else means a balance changed without a movement
behind it, and every figure derived from that item — value, margin, reorder
level — is wrong from that moment.

If you read one screen before trusting any other number, read this one.

---

## 9. A full worked example

**Nila Restaurant** — Ampara warehouse, Kandy branch, one production house.

**Monday — buy flour.**
Purchases → New → supplier Ampara Traders → **Deliver to: Ampara warehouse** →
100kg flour at LKR 100/kg. Order raised. *No stock yet.*

Thursday the lorry comes. Open the order → Receive → 100kg.
→ **Ampara warehouse: 100kg flour. Value LKR 10,000.**

**Send half to the bakery.**
Transfers → New → from Ampara warehouse → to Production house → 50kg flour →
Request → Approve → Dispatch → Receive.
→ Warehouse 50kg · Production house 50kg.

**Write the bread recipe.**
Production → Production recipe: makes **Bread**, per batch **10kg flour**,
output **10 loaves**, shelf life 3 days.

**Bake.**
Start a run: **5 batches** (= 50 loaves). Approve. Bake.
Two batches catch. Enter **3** batches actually made, reason *production loss*.

→ 50kg flour consumed — all of it, because all of it went in.
→ **30 loaves** created.
→ Cost: LKR 5,000 ÷ 30 = **LKR 167 a loaf**, against LKR 100 on a good day.
The run shows a variance of −2 batches with your reason against it.

**Send bread to Kandy.**
Transfer 20 loaves, production house → Kandy. Kandy's manager sees
**"Arriving: 20 Bread"** in Things to do and presses Receive.
→ Kandy: 20 loaves. Production house: 10.

**Sell.**
A "Toasted sandwich" menu recipe uses 2 loaves. Sell one at Kandy:
→ Kandy 18 loaves. COGS for that sandwich = **LKR 334**, from what the bread
actually cost — not a number anyone typed.

**Check.**
Reports → Reconciliation → Bread at Kandy:
opening 0, transferred in 20, sold 2, closing 18, **drift 0.**

---

## 10. Getting started, in order

1. **Settings** — name, currency, tax.
2. **Locations** — your branches, warehouse, production house. One is the default.
3. **Staff** — add people, set *Works at*, hand out their sign-in code.
4. **Stock** — create your items with their units.
5. **Add stock here** on each location, or a purchase order — get the opening
   figures in.
6. **Menu** — categories and dishes with prices.
7. **Recipes** — link each dish to what it uses. *Do not skip this.* Without
   recipes nothing depletes and your food cost is guesswork.
8. **Tables**, then print the QR codes.
9. Sell something, then open **Reconciliation** and confirm it balances.

---

## A short glossary

| Word | What it means |
|---|---|
| **Available** | On the shelf, sellable now |
| **Reserved** | On the shelf, but promised to an approved transfer |
| **In transit** | Dispatched, not yet arrived. Not sellable at either end |
| **Batch** (production) | One run of a recipe. 10 batches of a 10-loaf recipe = 100 loaves |
| **Batch / lot** (stock) | A delivery with its own expiry date, used oldest-first |
| **Variance** | The gap between expected and actual. Always needs a reason |
| **Drift** | Stored balance minus ledger sum. Must be zero |
| **COGS** | What the ingredients cost. Revenue − COGS = gross profit |
| **Spec** | A production recipe |

---

## Working across locations

**The switcher in the top bar changes everything below it.** Pick Kandy and the
takings, the orders, the stock quantities, the tables and the reorder list are
all Kandy's. Pick "All locations" for the group total. Your choice is
remembered between visits, and the address bar carries it — so a filtered view
can be bookmarked or sent to an accountant.

Two things stay restaurant-wide on purpose: your customer list and your item
list. A customer is a customer wherever they eat, and "Flour" is one item
defined once. It is the *quantity* that lives somewhere — 100kg at the
warehouse and 5kg at Kandy are the same item on two shelves.

### Things to do

The owner leaves an instruction for a location — "count the cold room before
Friday" — and the managers there are notified. It stays on their list until
someone marks it done, with their name and what they found against it. A month
later you can still see whether it happened.

Only an owner or a group manager writes them. A manager assigned to a location
sees and completes theirs.

### Who may move stock

Each step of a transfer belongs to one end:

| Step | Who |
|---|---|
| Request | Either end — asking to pull, or offering to push |
| Approve | The sending location; approval reserves their stock |
| Dispatch | The sending location; the stock leaves that building |
| Receive | The receiving location; only they can say what came off the van |
| Cancel / reject | Either end |

An owner or group manager passes every one of these. Buttons you cannot use are
not shown.

### Production

Runs read "10 batches = 100 loaves" so nobody multiplies in their head at the
mixer. On completion you can enter what the labour and power cost; it is
divided over the output along with the ingredients, so the cost per loaf is
what it really cost.

Click any run number for the full picture: what went in, what came out, what
the shortfall cost, who approved it.

Recipes can be edited or retired. Editing affects future runs only — runs
already completed keep the costs they were completed with, so last month's
margins never move under you. A recipe cannot be retired while a run still
depends on it.
