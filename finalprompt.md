# RESTAURANTOS — 5-STAR PRODUCTION SYSTEM

# MASTER ARCHITECTURE + OPERATIONS + ACCOUNTING + INVENTORY PROMPT

You are acting as a:

* Principal Software Architect
* Senior Full-Stack Engineer
* Database Architect
* Financial Systems Architect
* Inventory Management Specialist
* Restaurant POS/KDS Specialist
* Accounting Systems Designer
* Security Engineer
* DevOps Engineer
* QA/Test Engineer
* SaaS Product Architect
* UI/UX Designer

You are working on an **existing RestaurantOS codebase**.

RestaurantOS is a multi-restaurant SaaS platform containing:

* QR ordering
* Customer ordering
* KDS
* Waiter dashboard
* Cashier/POS
* Billing
* Payment recording
* Menu management
* Table management
* Customer management
* Staff management
* Inventory
* Suppliers
* Purchasing
* Recipes
* Costing
* COGS
* Reports
* Analytics
* Notifications
* Printing
* PWA/offline
* SaaS/platform administration

The existing specification defines RestaurantOS as a multi-restaurant platform with isolated restaurant data and includes menu, tables, orders, customers, staff, inventory, suppliers, purchases, stock, waste, expiry, reports, tax and exports.

The goal is NOT to build a demo.

The goal is to build a **commercial-grade restaurant operating system that can be trusted by restaurant owners, managers, accountants and auditors.**

---

# 1. NON-NEGOTIABLE PRINCIPLE

Every important number in the system must be explainable.

If the dashboard says:

Revenue = LKR 1,250,000

an accountant must be able to drill down and determine:

* which orders created the revenue
* which invoices created the revenue
* which items were sold
* quantities sold
* selling price
* discounts
* tax
* service charges
* payment records
* refunds/voids
* date/time
* cashier
* table/order
* final net revenue

If inventory says:

Chicken Stock = 42.5 kg

the accountant/manager must be able to determine:

* opening quantity
* purchases received
* transfers
* recipe consumption
* waste
* returns
* stock adjustments
* physical counts
* closing quantity
* unit cost
* total value
* every transaction responsible for the change

There must be a clear audit trail.

**No unexplained numbers.**

---

# 2. DO NOT BLINDLY REBUILD

Before modifying anything:

1. Inspect the entire repository.
2. Understand the current architecture.
3. Understand the database.
4. Understand existing migrations.
5. Understand existing business logic.
6. Understand existing UI.
7. Understand existing APIs/server actions.
8. Understand authentication.
9. Understand authorization.
10. Understand realtime.
11. Understand printing.
12. Understand inventory.
13. Understand billing.
14. Understand payment recording.
15. Understand reports.
16. Understand deployment.

Identify what already works.

Preserve working functionality.

Do not rewrite something merely because you prefer a different implementation.

---

# 3. PHASE 0 — COMPLETE AUDIT

Before writing implementation code, produce a complete audit.

Classify findings:

* CRITICAL
* HIGH
* MEDIUM
* LOW

For every problem identify:

* current behavior
* problem
* business risk
* data-integrity risk
* financial risk
* security risk
* proposed solution
* affected files
* database changes
* migration requirements
* test requirements

Pay special attention to:

* inventory correctness
* financial calculations
* historical data
* duplicate transactions
* stock manipulation
* tenant isolation
* report accuracy
* order/payment relationships

Do not implement Phase 1 until the audit is understood.

---

# 4. CORE BUSINESS PRINCIPLE

RestaurantOS must behave like a **controlled business system**, not a collection of CRUD screens.

Every major business event must produce a traceable record.

Examples:

Purchase received
→ inventory increases

Order completed
→ sales recorded

Recipe consumed
→ ingredients decrease

Waste recorded
→ inventory decreases

Stock count approved
→ variance adjustment created

Payment recorded
→ payment ledger changes

Refund approved
→ refund/adjustment recorded

Discount applied
→ revenue calculation changes

Nothing important should happen through an invisible direct database update.

---

# 5. FINANCIAL DATA PRINCIPLES

NEVER use floating-point arithmetic for money.

Use:

* Decimal
  OR
* integer minor units

consistently.

All monetary calculations must be deterministic.

Every financial transaction must have:

* amount
* currency
* date/time
* restaurant
* reference
* actor where appropriate
* source transaction
* status

Historical financial records must remain reproducible.

---

# 6. NORMAL PAYMENT SYSTEM — NO PAYMENT GATEWAY

RestaurantOS does NOT currently integrate with real payment gateways.

Do NOT implement:

* Stripe
* PayHere
* WEBXPAY
* OnePay
* PayPal
* Visa/Mastercard API
* bank APIs
* gateway SDKs
* payment webhooks
* card tokenization
* card storage
* online payment processing

The system only records payments made through normal restaurant methods.

Supported methods:

* CASH
* CARD
* BANK_TRANSFER
* OTHER

The actual card/bank transaction happens externally.

RestaurantOS records the result.

---

# 7. CASH PAYMENT FLOW

Example:

Invoice:

LKR 4,250

Customer gives:

LKR 5,000

System calculates:

Change = LKR 750

Flow:

Invoice
→ select Cash
→ enter amount received
→ server validates amount
→ calculate change
→ create payment record
→ update invoice payment status
→ create audit record
→ generate receipt
→ notify relevant users
→ optionally print receipt

The calculation must happen on the backend.

---

# 8. CARD PAYMENT FLOW

Restaurant may have an external physical card terminal.

Flow:

Invoice
→ customer pays on physical terminal
→ cashier confirms payment
→ selects CARD
→ records amount
→ optionally enters reference
→ server validates
→ payment record created
→ invoice updated
→ audit log created
→ receipt generated

RestaurantOS does NOT communicate with the terminal.

---

# 9. BANK TRANSFER FLOW

Flow:

Customer transfers externally
→ restaurant verifies transfer
→ cashier records BANK_TRANSFER
→ enters amount
→ enters reference
→ backend validates
→ payment recorded
→ invoice updated
→ audit record

Do not pretend RestaurantOS automatically verified the bank transfer.

---

# 10. SPLIT PAYMENT

Example:

Invoice:

LKR 10,000

Payments:

Cash = 4,000

Card = 6,000

Total = 10,000

Invoice:

PAID

All individual payment records remain permanently traceable.

---

# 11. PARTIAL PAYMENT

Example:

Invoice = 20,000

Payment 1 = 8,000

Remaining = 12,000

Status:

PARTIALLY_PAID

Payment 2 = 12,000

Status:

PAID

Never overwrite Payment 1.

---

# 12. BILLING ENGINE

Create one authoritative billing engine.

Calculation order must be explicitly defined.

Example:

ITEM SUBTOTAL

↓

ITEM DISCOUNTS

↓

ORDER DISCOUNTS

↓

COUPONS

↓

TAXABLE AMOUNT

↓

TAX

↓

SERVICE CHARGE

↓

OTHER CHARGES

↓

ROUNDING

↓

GRAND TOTAL

↓

PAYMENTS

↓

BALANCE

The exact order must be configurable where business rules require it.

Never duplicate billing formulas across:

* frontend
* backend
* reports
* invoice generation
* POS

There must be one source of truth.

---

# 13. BILLING EXAMPLE

Suppose:

Food subtotal = 10,000

Discount = 1,000

Taxable subtotal = 9,000

Tax = 900

Service charge = 450

Grand total = 10,350

The system must be able to show exactly how:

10,350

was calculated.

Reports must use the same calculation logic.

---

# 14. HISTORICAL PRICE SNAPSHOT

When an order is created/finalized, preserve:

* product name
* product ID
* quantity
* unit price
* discount
* tax
* add-ons
* variants
* service charge
* final amount

If the menu price later changes from:

LKR 1,000 → LKR 1,200

old invoices must still show:

LKR 1,000

---

# 15. ORDER → INVENTORY → ACCOUNTING FLOW

This is one of the most important parts of the system.

The system must connect the entire chain:

PURCHASE

↓

GOODS RECEIVED

↓

INVENTORY INCREASE

↓

RECIPE COST

↓

CUSTOMER ORDER

↓

ORDER COMPLETION / CONSUMPTION EVENT

↓

INGREDIENT CONSUMPTION

↓

INVENTORY DECREASE

↓

COGS

↓

REVENUE

↓

GROSS PROFIT

This chain must be traceable.

---

# 16. INVENTORY MUST BE LEDGER-BASED

Do NOT treat:

`currentStock`

as the only source of truth.

Every stock change must create an inventory movement/ledger entry.

Examples:

* OPENING_BALANCE
* PURCHASE_RECEIPT
* SALE_CONSUMPTION
* WASTE
* RETURN_TO_SUPPLIER
* CUSTOMER_RETURN
* STOCK_ADJUSTMENT
* STOCK_COUNT_VARIANCE
* TRANSFER_IN
* TRANSFER_OUT
* PRODUCTION_IN
* PRODUCTION_OUT
* OTHER

The exact transaction types should be designed according to the actual business requirements.

---

# 17. INVENTORY LEDGER EXAMPLE

Opening:

100 kg Chicken

Purchase:

+50 kg

Sale consumption:

-30 kg

Waste:

-5 kg

Stock adjustment:

+2 kg

Closing:

117 kg

The system must be able to show:

100
+ 50

* 30
* 5
  + 2
  = 117 kg

If the database says 117 kg, there must be ledger evidence supporting 117 kg.

---

# 18. NEVER DIRECTLY CHANGE STOCK

Avoid code such as:

`stock = stock + quantity`

without a corresponding controlled inventory transaction.

Every change must have:

* transaction type
* quantity
* unit
* source/reference
* actor
* timestamp
* restaurant
* reason where applicable
* cost information

Current stock can be a derived/cached balance for performance, but the ledger remains the authoritative audit trail.

---

# 19. INVENTORY TRANSACTION IMMUTABILITY

Once an inventory transaction has been posted:

Do not silently edit or delete it.

If an error occurs:

create a correcting/reversal transaction.

Example:

Incorrect purchase:

+100 kg

Correction:

-20 kg

Net:

+80 kg

The history remains visible.

---

# 20. INVENTORY ITEM MASTER

Every ingredient/product should support:

* name
* SKU/code
* category
* base unit
* purchase unit
* consumption unit
* conversion
* minimum stock
* reorder level
* maximum stock where applicable
* preferred supplier
* tax information where applicable
* active/inactive
* costing method
* storage location
* expiry tracking
* batch tracking where applicable

---

# 21. UNIT CONVERSION

Example:

1 carton = 12 bottles

1 bottle = 750 ml

Therefore:

1 carton = 9,000 ml

The conversion engine must be deterministic.

Never allow:

purchase quantity in cartons

and

consumption quantity in ml

to be compared without conversion.

---

# 22. PURCHASE FLOW

Purchase lifecycle:

DRAFT

↓

SUBMITTED

↓

APPROVED

↓

PARTIALLY_RECEIVED

↓

RECEIVED

↓

CLOSED

Cancelled where appropriate.

Creating a purchase order must NOT automatically increase inventory.

---

# 23. GOODS RECEIVING

Inventory increases only when goods are actually received.

Example:

Purchase order:

100 kg rice

Received:

80 kg

Inventory increases:

+80 kg

Remaining:

20 kg

Later:

Receive 20 kg

Inventory increases:

+20 kg

Purchase:

FULLY_RECEIVED

Every receipt must contain:

* received quantity
* unit
* purchase cost
* supplier
* purchase reference
* date
* received by
* batch where applicable
* expiry where applicable

---

# 24. PURCHASE COST

Record actual received cost.

Example:

Supplier invoice:

100 kg chicken

Unit cost = LKR 850/kg

Inventory value added:

100 × 850

= LKR 85,000

Do not use selling price as inventory cost.

---

# 25. PURCHASE PRICE HISTORY

Maintain historical purchase prices.

Example:

January:

Chicken = 800/kg

February:

Chicken = 850/kg

March:

Chicken = 900/kg

The system must preserve this history.

Never rewrite January's cost to 900.

---

# 26. INVENTORY COSTING

Use a clearly defined costing methodology.

At minimum, implement a reliable weighted-average costing method if appropriate to the existing business model.

Every consumption event must obtain a defensible cost.

Example:

Opening:

100 kg × 800 = 80,000

Purchase:

50 kg × 900 = 45,000

Total:

150 kg

Total value:

125,000

Weighted average:

125,000 / 150

= 833.333...

The system must handle the precision internally and apply appropriate reporting/display rounding.

Do not introduce hidden rounding errors.

---

# 27. COGS

For every sale/consumption event:

COGS = quantity consumed × applicable historical cost

Example:

Burger consumes:

150g chicken

Cost:

LKR 833.33/kg

COGS:

0.150 × 833.33

≈ LKR 125.00

The exact internal precision must be preserved.

---

# 28. RECIPE / BOM

Every sellable menu item can have a recipe/BOM.

Example:

BURGER

Bun = 1 piece

Beef = 150 g

Cheese = 1 slice

Sauce = 20 ml

Lettuce = 30 g

When one burger is consumed:

inventory deductions are generated according to the recipe.

---

# 29. VARIANTS AND ADD-ONS

Variants/add-ons must affect inventory where applicable.

Example:

Burger:

Regular → 150g beef

Double → 300g beef

Extra cheese:

+1 cheese slice

The inventory system must understand these relationships.

---

# 30. RECIPE VERSIONING

Do not allow a recipe change to corrupt historical COGS.

Example:

January recipe:

150g beef

February recipe:

170g beef

January orders must continue to use the historical recipe/cost applicable at that time.

Maintain effective dates/versioning or equivalent historical snapshots.

---

# 31. INVENTORY CONSUMPTION TIMING

Define one authoritative business event for inventory consumption.

Do not randomly deduct stock when:

* customer opens cart
* customer adds item
* customer views menu

Consumption must happen according to the defined restaurant operational event, such as completed/confirmed sale or another explicitly chosen point.

The same order must never consume inventory twice.

---

# 32. ORDER CANCELLATION

If inventory has already been consumed and the order is later cancelled:

Do not simply delete the consumption record.

Create an appropriate reversal/return transaction according to business rules.

Everything remains auditable.

---

# 33. WASTE MANAGEMENT

Waste must be a first-class inventory transaction.

Record:

* ingredient
* quantity
* unit
* cost
* reason
* batch where applicable
* employee
* date/time
* notes

Example:

Chicken waste:

5 kg

Cost:

LKR 4,250

Reason:

Expired

This must appear in:

* inventory ledger
* waste report
* inventory valuation
* management analytics
* relevant COGS/waste analysis

according to the accounting treatment chosen.

---

# 34. STOCK COUNT

Support physical stock counts.

Example:

System stock:

100 kg

Physical stock:

96 kg

Variance:

-4 kg

The system must NOT simply change 100 to 96.

Create:

STOCK_COUNT

and then:

STOCK_COUNT_VARIANCE

-4 kg

Record:

* counter
* approver
* date
* reason
* location
* item
* system quantity
* physical quantity
* variance
* financial impact

---

# 35. STOCK COUNT APPROVAL

Depending on permissions:

Staff:

perform count

Manager:

review

Authorized manager/admin:

approve variance

Only after approval should the adjustment be posted.

---

# 36. NEGATIVE STOCK

Define strict rules.

Do not silently allow impossible inventory.

If stock is:

5 kg

and sale requires:

7 kg

the system should either:

* prevent the transaction
  OR
* allow negative stock only if explicitly configured by authorized management

Never silently create unexplained negative inventory.

---

# 37. LOW STOCK

Support:

* minimum stock
* reorder point
* preferred supplier
* reorder quantity

Example:

Current:

8 kg

Reorder level:

10 kg

System:

LOW STOCK

Avoid repeatedly generating the same alert every minute.

---

# 38. EXPIRY AND BATCHES

Where applicable track:

* batch number
* received date
* expiry date
* quantity
* unit cost
* supplier

Support FEFO:

First Expired → First Out

where appropriate.

---

# 39. INVENTORY LOCATIONS

Prepare for storage locations.

Example:

Main Kitchen

Cold Room

Dry Store

Bar

Freezer

Each inventory transaction should identify the relevant location when required.

---

# 40. INVENTORY TRANSFERS

Support transfers between locations where applicable.

Example:

Kitchen:

20 kg

Transfer:

5 kg → Bar

Kitchen:

15 kg

Bar:

5 kg

The transfer must create traceable:

TRANSFER_OUT

and

TRANSFER_IN

records.

---

# 41. SUPPLIER MANAGEMENT

Supplier records should support:

* supplier name
* contact
* phone
* email
* address
* payment terms
* tax details where required
* supplied items
* purchase history
* price history
* outstanding purchase information where applicable

---

# 42. SUPPLIER REPORTING

Managers should be able to see:

* total purchases by supplier
* purchase count
* average purchase cost
* latest purchase price
* price changes
* most purchased items
* supplier performance where data exists

---

# 43. INVENTORY VALUATION

At any point the system should be able to answer:

"What is the value of our current stock?"

Example:

Chicken:

42.5 kg × current applicable cost

Rice:

75 kg × applicable cost

Oil:

20 L × applicable cost

Total Inventory Value:

LKR XXXXX

The valuation methodology must be documented.

---

# 44. INVENTORY RECONCILIATION

Provide a reconciliation report.

Example:

Opening stock value

* Purchases
* Transfers in
* Production in

- COGS/consumption
- Waste
- Transfers out
- Returns
  ± Adjustments
  = Closing stock value

The report must explain differences.

---

# 45. SALES ACCOUNTING LOGIC

Revenue reports must be based on finalized/valid sales transactions according to the defined business rules.

Clearly distinguish:

* gross sales
* discounts
* refunds
* net sales
* tax
* service charge
* other charges
* payments
* outstanding balance

Do not mix payment totals with revenue totals.

**Revenue and payment are not the same thing.**

---

# 46. CRITICAL ACCOUNTING DISTINCTION

Example:

Today:

Sales = LKR 100,000

Cash collected = LKR 60,000

Card recorded = LKR 30,000

Outstanding = LKR 10,000

The system must NOT report revenue as only LKR 90,000.

Revenue:

LKR 100,000

Payments collected:

LKR 90,000

Outstanding:

LKR 10,000

These are different business concepts.

---

# 47. PAYMENT RECONCILIATION

Provide:

Total sales

vs

Total recorded payments

vs

Outstanding amount

vs

Refunds

vs

Voids/adjustments

The system should make discrepancies visible.

---

# 48. CASHIER SHIFT / CASH CONTROL

Implement cashier shift/session management where appropriate.

A cashier shift should support:

Opening cash

*

Cash sales

*

Other cash movements in

*

Cash refunds

*

Cash movements out

=

Expected closing cash

Then:

Actual counted cash

vs

Expected cash

=

Cash variance

Example:

Opening cash = 10,000

Cash sales = 50,000

Cash refund = 2,000

Expected = 58,000

Actual = 57,500

Variance = -500

This must be visible and auditable.

---

# 49. CASH MOVEMENTS

Support controlled non-sale cash movements where required:

* CASH_IN
* CASH_OUT
* PETTY_CASH
* REFUND

Every movement requires:

* amount
* reason
* actor
* timestamp
* approval where required

Do not allow arbitrary cash balance editing.

---

# 50. DAILY CLOSING / END-OF-DAY

Provide a clear end-of-day workflow.

Example:

DAY

↓

Orders finalized

↓

Invoices finalized

↓

Payments recorded

↓

Refunds/voids reviewed

↓

Cashier shifts closed

↓

Cash reconciled

↓

Inventory consumption posted

↓

Daily sales calculated

↓

COGS calculated

↓

Gross profit calculated

↓

Tax/service charge summarized

↓

Daily report generated

The exact workflow must match the actual system's operational rules.

---

# 51. ACCOUNTING-FRIENDLY DAILY REPORT

A manager/accountant should be able to open one report and understand:

### SALES

Gross Sales

Discounts

Refunds

Net Sales

### TAX

Taxable Sales

Tax

### SERVICE CHARGE

Service Charge

### COGS

Food COGS

Other COGS

Total COGS

### PROFIT

Gross Profit

Gross Margin %

### PAYMENTS

Cash

Card

Bank Transfer

Other

### BALANCE

Outstanding

### CASH

Opening Cash

Cash Sales

Cash In

Cash Out

Cash Refunds

Expected Cash

Actual Cash

Variance

### INVENTORY

Opening Stock

Purchases

Consumption

Waste

Adjustments

Closing Stock

Inventory Value

Every number must be drillable.

---

# 52. PROFIT CALCULATION

Use:

Net Sales

*

COGS

=

Gross Profit

Gross Margin:

Gross Profit / Net Sales × 100

Do not call this "Net Profit" unless actual operating expenses are also included.

If the system does not track:

* salaries
* rent
* utilities
* marketing
* other operating expenses

then report:

**Gross Profit**

not:

**Net Profit**

This distinction is extremely important for accounting accuracy.

---

# 53. FOOD COST %

Food Cost %:

COGS / Net Food Sales × 100

The exact denominator must be clearly defined and documented.

Do not mix tax/service charges incorrectly into food-cost calculations.

---

# 54. MENU ITEM PROFITABILITY

For each menu item show:

Selling price

Discounted selling price where applicable

Recipe cost

COGS

Gross profit

Gross margin %

Quantity sold

Revenue generated

Total COGS

Total gross profit

This allows the restaurant owner to identify profitable and unprofitable items.

---

# 55. CATEGORY PROFITABILITY

Provide:

Category revenue

Category discounts

Category COGS

Category gross profit

Category margin %

Quantity sold

Top items

---

# 56. INVENTORY PROFITABILITY RECONCILIATION

The system should connect:

Menu sales

→ Recipe consumption

→ Inventory cost

→ COGS

→ Gross profit

If an accountant asks:

"Why is COGS LKR 350,000?"

the system should allow drilling down to:

COGS
→ orders
→ order items
→ recipes
→ ingredients
→ quantities
→ historical costs
→ inventory transactions.

---

# 57. REPORT DRILL-DOWN

Every important summary number should be clickable.

Example:

Dashboard:

Revenue:

LKR 1,250,000

Click:

→ Sales report

Click:

→ Invoice

Click:

→ Order

Click:

→ Order items

Click:

→ Payment records

Similarly:

Inventory value:

LKR 500,000

Click:

→ Inventory valuation

Click:

→ Ingredient

Click:

→ Ledger

Click:

→ Purchase/consumption/waste/adjustment transaction

---

# 58. REPORT FILTERS

Reports should support:

* today
* yesterday
* this week
* this month
* custom range
* restaurant
* branch where applicable
* cashier
* waiter
* kitchen
* category
* menu item
* supplier
* inventory item
* payment method

All filters must work consistently.

---

# 59. ACCOUNTING PERIODS

Prepare the architecture for:

* business day
* daily closing
* monthly reporting
* historical periods

Once a financial period is closed, normal users must not silently alter historical figures.

Corrections must create adjustment records.

---

# 60. AUDIT TRAIL

Audit every important financial/inventory action.

Examples:

Payment recorded

Payment voided

Refund created

Discount applied

Price changed

Recipe changed

Purchase created

Purchase approved

Goods received

Stock adjusted

Stock count approved

Inventory transfer

Waste created

Cashier shift closed

Invoice finalized

Invoice corrected

Each audit event should identify:

* who
* what
* when
* restaurant
* entity
* old value where appropriate
* new value where appropriate
* reason
* reference

---

# 61. NO SILENT DATA CHANGES

Never silently:

* change stock
* change invoice totals
* change historical price
* change COGS
* delete payment
* delete inventory transaction
* delete purchase receipt
* alter historical reports

Use:

* reversal
* adjustment
* correction
* refund
* void

where appropriate.

---

# 62. MULTI-TENANCY

Every financial and inventory record must belong to the correct restaurant/tenant.

Restaurant A must never see:

Restaurant B's:

* sales
* inventory
* purchases
* suppliers
* payments
* reports
* customers
* staff
* audit logs

Test tenant isolation aggressively.

---

# 63. DATABASE DESIGN

Review and improve models for:

* Organization
* Restaurant
* Branch
* User
* Role
* Permission
* Session
* Table
* TableSession
* Customer
* Category
* MenuItem/Food
* Variant
* AddOn
* Recipe
* RecipeVersion
* Ingredient
* InventoryItem
* InventoryLocation
* InventoryLedger
* InventoryBatch
* Supplier
* PurchaseOrder
* PurchaseOrderItem
* GoodsReceipt
* GoodsReceiptItem
* Waste
* StockCount
* StockCountItem
* InventoryTransfer
* Order
* OrderItem
* OrderStatusHistory
* Invoice
* InvoiceLine
* Payment
* PaymentAdjustment/Refund
* CashierShift
* CashMovement
* Coupon
* LoyaltyTransaction
* Reservation
* Notification
* AuditLog

Do not blindly create every model.

Adapt the schema to the existing application.

---

# 64. DATABASE CONSTRAINTS

Use database constraints wherever practical.

Examples:

* unique invoice numbers per restaurant
* unique order numbers per restaurant
* valid foreign keys
* valid tenant relationships
* positive quantities where appropriate
* valid payment amounts
* valid status transitions where enforceable
* unique SKU per restaurant where required
* unique table number within a restaurant
* duplicate prevention

---

# 65. ORDER → BILL → PAYMENT RELATIONSHIP

Use a clear relationship:

TABLE SESSION

↓

ORDERS

↓

ORDER ITEMS

↓

INVOICE

↓

PAYMENTS

↓

RECEIPT

The system must handle multiple orders under the same table session where applicable.

---

# 66. CUSTOMER FLOW

Existing customer flow is:

Scan QR

↓

Enter table number

↓

Browse menu

↓

Search/filter

↓

Select food

↓

Quantity

↓

Variants

↓

Add-ons

↓

Special instructions

↓

Cart

↓

Checkout

↓

Customer name

↓

Mobile number

↓

Optional email

↓

Confirm order

The implementation must preserve this business flow.

---

# 67. ORDER → KITCHEN FLOW

After confirmation:

Create order

↓

Generate order number

↓

Save customer

↓

Save table

↓

Save items

↓

Server validation

↓

Commit transaction

↓

Publish realtime event

↓

KDS receives order

No page refresh should be required for realtime operations.

---

# 68. KDS FLOW

KDS should receive:

* order number
* table
* customer
* items
* quantities
* notes
* order time
* estimated preparation time

Statuses:

Received

→ Accepted

→ Preparing

→ Ready

→ Completed

The existing specification explicitly expects instant kitchen updates and kitchen statistics such as pending, preparing, completed and average cooking time.

---

# 69. WAITER FLOW

Ready order:

KDS

↓

READY

↓

Waiter notified

↓

Waiter views table/order

↓

Waiter delivers

↓

Customer sees SERVED

This must be realtime and persistent.

---

# 70. TABLE SESSION LOGIC

Do not treat table status as the entire table accounting system.

Use:

Table

*

TableSession

*

Orders

*

Invoice

*

Payments

A table can have multiple orders before the final bill.

---

# 71. COUPONS AND DISCOUNTS

All discount logic must be server validated.

Prevent:

* negative totals
* excessive discounts
* unauthorized discounts
* duplicate coupon usage
* invalid dates
* invalid item/category usage

Record:

* discount amount
* discount type
* applied by
* reason where required

---

# 72. LOYALTY

Use a loyalty ledger.

Do not only store:

`pointsBalance`

Track:

* points earned
* points redeemed
* adjustments
* order
* actor
* timestamp
* reason

---

# 73. REPORTING MODULES

At minimum:

### Sales

* gross sales
* discounts
* refunds
* net sales
* tax
* service charge
* average order value

### Payment

* cash
* card
* bank transfer
* other
* outstanding
* refunds

### Inventory

* opening
* purchases
* consumption
* waste
* adjustments
* closing
* valuation

### Purchasing

* supplier
* purchases
* price history
* outstanding receipts

### COGS

* total COGS
* item COGS
* ingredient COGS

### Profitability

* revenue
* COGS
* gross profit
* margin %

### Customers

* visits
* spending
* repeat customers

### Staff

* sales
* orders
* cashier activity
* waiter activity

The original specification also requires daily, weekly, monthly and yearly reports plus Excel/PDF/CSV export.

---

# 74. ACCOUNTANT VIEW

Create reports with accounting clarity rather than only attractive charts.

An accountant should be able to answer:

### Sales

"How much did we sell?"

### Collections

"How much money was actually recorded?"

### Outstanding

"How much remains unpaid?"

### Inventory

"What stock do we have?"

### Purchases

"How much did we purchase?"

### Consumption

"How much stock was consumed?"

### Waste

"How much stock was lost?"

### COGS

"What did the food actually cost?"

### Gross Profit

"How much did we make before operating expenses?"

### Variance

"Why does physical stock differ from system stock?"

### Cash

"Why is actual cash different from expected cash?"

Every question should have a report/drill-down path.

---

# 75. RECONCILIATION DASHBOARD

Create a reconciliation section showing:

Sales

vs

Payments

vs

Outstanding

vs

Refunds

vs

Cash

vs

Inventory

vs

COGS

vs

Gross Profit

Highlight discrepancies.

Do not hide inconsistencies.

---

# 76. DATA RECONCILIATION CHECKS

Create automated consistency checks.

Examples:

### Sales check

Invoice total

=

invoice line calculations

### Payment check

Paid amount

=

sum(payment records)

### Outstanding check

Invoice total

*

valid payments

=

outstanding

### Inventory check

Opening

*

increases

*

decreases

=

closing

### COGS check

Recipe consumption

×

historical cost

=

COGS

### Profit check

Net sales

*

COGS

=

gross profit

These checks should be testable.

---

# 77. SECURITY

Protect against:

* SQL injection
* XSS
* CSRF where applicable
* IDOR
* privilege escalation
* broken access control
* tenant leakage
* brute force
* unauthorized discounts
* unauthorized refunds
* unauthorized inventory adjustments
* unauthorized cash movements

Every server operation must validate:

Authentication

*

Authorization

*

Tenant

*

Input

*

Business Rules

---

# 78. ROLE PERMISSIONS

Examples:

### Cashier

Can:

* create orders
* record payments
* print receipts

Cannot automatically:

* change recipes
* adjust inventory
* approve stock variance
* change financial configuration

### Inventory Staff

Can:

* receive stock
* perform counts
* record waste

Cannot automatically:

* issue refunds
* modify payments

### Manager

Can:

* approve adjustments
* approve discounts
* review reports
* close shifts

### Owner

Can:

* configure restaurant
* manage staff
* review financial/inventory reports

Permissions must be configurable.

---

# 79. REALTIME

Use realtime for operational events:

* orders
* KDS
* waiter notifications
* table status
* payment recorded
* customer requests
* inventory alerts

Realtime messages must NEVER bypass server authorization.

---

# 80. PRINTING

Support:

* 58mm
* 80mm

Print:

* customer receipt
* invoice
* kitchen ticket

Cloud server cannot directly control a local USB printer.

Use an appropriate local print-agent/bridge architecture.

Maintain a print queue:

QUEUED

→ PROCESSING

→ PRINTED

or

FAILED

with retry support.

---

# 81. PWA / OFFLINE

Do not falsely claim offline support.

If implemented:

* IndexedDB
* offline queue
* synchronization
* retry
* conflict handling
* idempotency

must actually work.

Financial and inventory operations require especially careful conflict handling.

---

# 82. PERFORMANCE

Optimize:

* database queries
* indexes
* aggregation
* pagination
* reports
* inventory ledger
* realtime
* dashboard loading

Do not load millions of ledger rows into the browser.

Use server-side aggregation.

---

# 83. LARGE REPORTS

For large reports:

Use:

* background jobs
* server-side generation
* streaming where appropriate
* pagination

Do not freeze the browser.

---

# 84. UI/UX

The original specification requires a modern premium responsive interface with desktop/tablet/mobile support, dark mode, glassmorphism, micro-interactions, skeleton loading and good empty states.

Maintain a premium visual system but prioritize:

**clarity > decoration**

Especially for:

* POS
* KDS
* inventory
* accounting
* reports

An accountant should be able to scan a report quickly.

---

# 85. INVENTORY UI

Inventory should have separate areas:

### Overview

* stock value
* low stock
* expiring stock
* today's movements
* purchases
* waste

### Items

Master inventory items.

### Ledger

Every stock movement.

### Purchases

Purchase workflow.

### Receiving

Goods receipts.

### Suppliers

Supplier management.

### Recipes

BOM/recipes.

### Stock Counts

Physical counts.

### Waste

Waste records.

### Transfers

Location transfers.

### Valuation

Inventory value.

### Reports

Historical analysis.

---

# 86. INVENTORY LEDGER UI

For each ingredient show:

| Date | Type | Reference | Qty In | Qty Out | Balance | Unit Cost | Value | User |
| ---- | ---- | --------- | -----: | ------: | ------: | --------: | ----: | ---- |

Example:

| Jan 01 | Opening | OPEN-001 | 100 | - | 100 | 800 | 80,000 | Admin |
| Jan 03 | Purchase | PO-001 | 50 | - | 150 | 900 | ... | Manager |
| Jan 05 | Consumption | ORD-103 | - | 20 | 130 | ... | ... | System |
| Jan 06 | Waste | WST-009 | - | 5 | 125 | ... | ... | Staff |

This is the level of traceability required.

---

# 87. INVENTORY DASHBOARD

Show:

* Total stock value
* Low-stock items
* Out-of-stock items
* Expiring items
* Today's consumption
* Today's waste
* Today's purchases
* Stock adjustments
* Top consumed ingredients
* Highest-value inventory
* Stock variance

Every metric should be drillable.

---

# 88. REPORT EXPORTS

Exports must preserve:

* filters
* date range
* restaurant
* report title
* generated timestamp
* currency
* totals

CSV/Excel/PDF should contain meaningful accounting data, not just visual dashboard screenshots.

---

# 89. ACCOUNTING REPORT FORMAT

Reports should have:

### Header

Restaurant

Report

Period

Generated at

Currency

### Summary

Totals

### Detailed transactions

Every transaction

### Reconciliation

Opening

Movements

Closing

### Audit information

Generated by

Generated at

Filters

This makes reports suitable for management/accounting review.

---

# 90. HISTORICAL REPORT STABILITY

Old reports must remain reproducible.

If:

* menu prices change
* recipes change
* supplier prices change
* tax changes
* service charge changes

historical transactions must retain the values applicable when they occurred.

---

# 91. TAX

Tax configuration must be explicit.

Support appropriate:

* tax rate
* taxable/non-taxable items
* tax-inclusive pricing where required
* tax-exclusive pricing where required

Do not hardcode tax assumptions.

Reports must clearly separate:

* sales before tax
* tax
* sales including tax

---

# 92. SERVICE CHARGE

Service charge must be separately identifiable.

Example:

Subtotal = 10,000

Service charge = 1,000

Tax = X

Do not hide service charge inside product revenue.

Reports should clearly show it.

---

# 93. DISCOUNTS

Separate:

* item discount
* order discount
* coupon discount
* promotional discount

Reports should explain the total discount.

---

# 94. ORDER NUMBER / INVOICE NUMBER

Use restaurant-specific numbering.

Examples:

ORD-2026-000001

INV-2026-000001

Numbers must be:

* unique
* traceable
* sequential according to configured rules
* safe under concurrency

Never generate duplicate invoice numbers.

---

# 95. CONCURRENCY

Protect against simultaneous:

* order creation
* invoice finalization
* payment recording
* stock receiving
* inventory consumption
* stock adjustment
* coupon usage
* cashier closing

Use:

* database transactions
* locking
* unique constraints
* idempotency

where appropriate.

---

# 96. DATABASE TRANSACTION PRINCIPLE

Important business operations should be atomic.

Example:

Order finalization may involve:

Create/finalize order

*

Create invoice

*

Calculate totals

*

Create inventory consumption

*

Create COGS

*

Update table session

*

Create audit records

These operations must not leave the database in a half-completed state.

Use appropriate database transactions.

---

# 97. NO HALF-SUCCESS

Never allow:

Invoice = PAID

while

Payment record does not exist.

Never allow:

Inventory = -10

with no ledger transaction explaining it.

Never allow:

COGS exists

without source consumption.

Never allow:

Payment exists

without invoice/order relationship where required.

Never allow:

Inventory receipt exists

without purchase/supplier reference where required.

---

# 98. AUDITABLE FINANCIAL CHAIN

Every important financial number must have a source.

Example:

Gross Profit

↓

Net Sales

↓

Invoices

↓

Order Items

↓

Menu Prices

and:

COGS

↓

Inventory Consumption

↓

Recipes

↓

Ingredients

↓

Inventory Ledger

↓

Purchase Receipts

↓

Supplier Costs

This chain must be reproducible.

---

# 99. TESTING

Create comprehensive tests for:

### Billing

* subtotal
* discounts
* tax
* service charge
* rounding
* totals

### Payments

* cash
* card
* bank transfer
* split payment
* partial payment
* overpayment rules
* refunds
* voids

### Inventory

* opening
* purchases
* receiving
* consumption
* waste
* transfers
* adjustments
* stock counts
* negative stock rules

### Costing

* weighted average
* historical cost
* recipe cost
* COGS

### Reports

* sales
* payment reconciliation
* inventory
* COGS
* gross profit
* cash reconciliation

### Security

* tenant isolation
* RBAC
* unauthorized adjustments

---

# 100. CRITICAL END-TO-END TEST

Test:

Purchase

→ Goods Receipt

→ Inventory Increase

→ Recipe

→ Customer Order

→ Kitchen

→ Order Completion

→ Inventory Consumption

→ COGS

→ Invoice

→ Payment Recording

→ Daily Closing

→ Sales Report

→ Inventory Report

→ COGS Report

→ Gross Profit Report

The numbers must reconcile from beginning to end.

---

# 101. EXAMPLE RECONCILIATION TEST

Given:

Purchase:

100 kg chicken

Cost:

LKR 800/kg

Purchase value:

LKR 80,000

Recipe consumption:

50 kg

COGS:

LKR 40,000

Waste:

5 kg

Waste cost:

LKR 4,000

Remaining:

45 kg

Inventory value:

LKR 36,000

The system must be able to explain:

80,000

*

40,000

*

4,000

=

36,000

assuming no other movements.

---

# 102. REPORT ACCURACY TEST

If:

Net Sales = 100,000

COGS = 35,000

Then:

Gross Profit = 65,000

Gross Margin = 65%

The dashboard, sales report, profitability report and exported report must all agree.

There must be one calculation source.

---

# 103. NO DUPLICATION

Do not implement the same calculation independently in:

* dashboard
* API
* report
* PDF
* Excel
* frontend

Create reusable domain/service calculations.

---

# 104. ERROR HANDLING

Errors must be clear.

Example:

"Insufficient stock: Chicken requires 7 kg, available 5 kg."

Not:

"Internal server error."

But never expose sensitive internal information.

---

# 105. OBSERVABILITY

Track:

* API errors
* database errors
* failed inventory transactions
* failed reports
* failed print jobs
* failed realtime events
* background job failures

Use request IDs/correlation IDs where appropriate.

---

# 106. DOCUMENTATION

Create/update:

* README
* ARCHITECTURE.md
* DATABASE.md
* INVENTORY.md
* ACCOUNTING.md
* REPORTING.md
* SECURITY.md
* API.md
* DEPLOYMENT.md
* TESTING.md

Especially document:

### Inventory accounting rules

### Costing methodology

### COGS methodology

### Revenue methodology

### Payment recording methodology

### Tax calculation

### Service charge calculation

### Stock adjustment rules

### Daily closing rules

An accountant or developer should be able to understand exactly how the numbers are produced.

---

# 107. ACCOUNTING TERMINOLOGY RULE

Use correct terminology.

Do not confuse:

Revenue

with

Payment

Do not confuse:

Gross Profit

with

Net Profit

Do not confuse:

Inventory Value

with

Purchase Expense

Do not confuse:

COGS

with

Purchases

Do not confuse:

Cash Balance

with

Total Sales

Do not confuse:

Outstanding Receivable

with

Revenue

Where the system does not contain enough information to calculate an accounting metric correctly, do NOT invent it.

Instead clearly label the metric according to what the system actually knows.

---

# 108. IMPORTANT: PURCHASES ≠ COGS

Example:

Restaurant buys:

LKR 500,000 inventory.

It does NOT automatically mean:

COGS = LKR 500,000.

Some inventory may remain in stock.

COGS should be based on actual consumption/costing methodology.

Reports must keep:

Purchases

separate from:

COGS.

---

# 109. IMPORTANT: WASTE ≠ SALE

Waste must not be counted as customer revenue.

It must be separately tracked as inventory loss/waste according to the defined accounting treatment.

---

# 110. IMPORTANT: TAX ≠ REVENUE

Tax collected should be separately identifiable.

Do not incorrectly include tax as restaurant revenue where the accounting model requires it to be treated separately.

---

# 111. IMPORTANT: PAYMENT ≠ SALE

A customer can owe money.

Therefore:

Sale

and

Payment

must be separate records.

---

# 112. FUTURE ACCOUNTING EXTENSIBILITY

Design the system so that future versions can add more formal accounting features if required:

* chart of accounts
* journal entries
* accounts receivable
* accounts payable
* expense management
* bank reconciliation
* financial statements

BUT:

**Do not implement a full accounting ERP unless explicitly required.**

The current system must provide accurate restaurant operational accounting data and reconciliation.

---

# 113. SAAS

RestaurantOS remains multi-tenant.

SaaS functionality includes:

* restaurants
* plans
* subscriptions
* feature entitlements
* usage

Keep SaaS subscription billing separate from restaurant customer payment recording.

Do NOT add a payment gateway.

---

# 114. PERFORMANCE

Inventory ledgers can become very large.

Design indexes for:

* restaurant
* item
* location
* transaction type
* date
* reference

Reports should aggregate server-side.

Use pagination.

Never load the entire ledger into the browser.

---

# 115. DATA INTEGRITY CHECKER

Create an internal/admin integrity checker where appropriate.

It should detect problems such as:

* invoice without order
* payment without invoice
* payment total mismatch
* inventory balance mismatch
* missing ledger source
* negative stock
* COGS without consumption
* consumption without order
* duplicate invoice number
* duplicate order number
* tenant mismatch
* orphaned records

This is extremely valuable for production.

---

# 116. RECONCILIATION STATUS

Provide statuses such as:

OK

WARNING

ERROR

For example:

Inventory:

OK

Payment reconciliation:

OK

Cash reconciliation:

WARNING

Missing receipt:

ERROR

This allows managers to identify issues quickly.

---

# 117. FINAL QUALITY STANDARD

Do not judge success by:

"All pages exist."

Judge success by:

"Can a real restaurant operate for months and then hand the database/reporting to an accountant without unexplained numbers?"

If the answer is no, the system is not 5-star.

---

# 118. FINAL IMPLEMENTATION ORDER

Use this order:

## PHASE 0

Repository audit

## PHASE 1

Architecture and domain model

## PHASE 2

Database integrity and migrations

## PHASE 3

Multi-tenancy

## PHASE 4

Authentication/RBAC

## PHASE 5

Core domain services

## PHASE 6

Menu/categories/variants/add-ons

## PHASE 7

Tables/table sessions

## PHASE 8

Customer QR ordering

## PHASE 9

Order engine

## PHASE 10

KDS

## PHASE 11

Waiter

## PHASE 12

POS/cashier

## PHASE 13

Billing engine

## PHASE 14

Normal payment recording

## PHASE 15

Cashier shifts/cash reconciliation

## PHASE 16

Inventory foundation

## PHASE 17

Units/conversions

## PHASE 18

Suppliers

## PHASE 19

Purchasing

## PHASE 20

Goods receiving

## PHASE 21

Recipes/BOM

## PHASE 22

Inventory consumption

## PHASE 23

Costing

## PHASE 24

COGS

## PHASE 25

Waste

## PHASE 26

Stock counts

## PHASE 27

Transfers

## PHASE 28

Inventory valuation

## PHASE 29

Customers/loyalty

## PHASE 30

Coupons/discounts

## PHASE 31

Reservations

## PHASE 32

Reports

## PHASE 33

Accounting/reconciliation reports

## PHASE 34

Printing

## PHASE 35

Notifications/realtime

## PHASE 36

PWA/offline

## PHASE 37

SaaS/platform admin

## PHASE 38

Security hardening

## PHASE 39

Performance

## PHASE 40

Automated testing

## PHASE 41

Deployment/monitoring

---

# 119. AFTER EVERY PHASE

Run:

* TypeScript
* lint
* unit tests
* integration tests
* E2E tests
* database validation
* migration validation
* production build

Fix failures before continuing.

---

# 120. FINAL 5-STAR SCORECARD

At the end provide:

| Area                | Score / 5 | Evidence | Remaining Issues |
| ------------------- | --------: | -------- | ---------------- |
| Architecture        |           |          |                  |
| Multi-tenancy       |           |          |                  |
| Database            |           |          |                  |
| Authentication      |           |          |                  |
| RBAC                |           |          |                  |
| QR Ordering         |           |          |                  |
| Orders              |           |          |                  |
| KDS                 |           |          |                  |
| Waiter              |           |          |                  |
| POS                 |           |          |                  |
| Billing             |           |          |                  |
| Payments            |           |          |                  |
| Cash Reconciliation |           |          |                  |
| Inventory           |           |          |                  |
| Inventory Ledger    |           |          |                  |
| Purchasing          |           |          |                  |
| Suppliers           |           |          |                  |
| Recipes             |           |          |                  |
| Costing             |           |          |                  |
| COGS                |           |          |                  |
| Waste               |           |          |                  |
| Stock Counts        |           |          |                  |
| Inventory Valuation |           |          |                  |
| Customers           |           |          |                  |
| Loyalty             |           |          |                  |
| Coupons             |           |          |                  |
| Reservations        |           |          |                  |
| Sales Reports       |           |          |                  |
| Accounting Reports  |           |          |                  |
| Reconciliation      |           |          |                  |
| Printing            |           |          |                  |
| Realtime            |           |          |                  |
| PWA                 |           |          |                  |
| Security            |           |          |                  |
| Performance         |           |          |                  |
| Testing             |           |          |                  |
| Deployment          |           |          |                  |
| UI/UX               |           |          |                  |
| Accessibility       |           |          |                  |
| Documentation       |           |          |                  |

Do not automatically give 5/5.

Every 5/5 must have evidence.

---

# 121. DEFINITION OF DONE

RestaurantOS is 5-star only when:

* Orders are reliable.
* Billing is deterministic.
* Payments are correctly recorded.
* Cash is reconcilable.
* Inventory is ledger-based.
* Purchases are traceable.
* Goods receiving is controlled.
* Recipes determine consumption.
* Historical costs are preserved.
* COGS is reproducible.
* Waste is traceable.
* Stock counts create controlled adjustments.
* Inventory valuation is explainable.
* Sales reports reconcile with invoices.
* Payment reports reconcile with payment records.
* Inventory reports reconcile with inventory ledger.
* COGS reconciles with consumption.
* Gross profit reconciles with revenue and COGS.
* Historical reports remain stable.
* Financial records are auditable.
* No silent financial changes occur.
* No unexplained stock changes occur.
* Tenant isolation is verified.
* Permissions are server-enforced.
* Critical operations are atomic.
* Duplicate transactions are prevented.
* Reports are drillable.
* CSV/Excel/PDF exports agree with on-screen reports.
* Production logging exists.
* Automated tests cover critical flows.
* Deployment is documented.
* No critical placeholders remain.

---

# 122. MOST IMPORTANT ACCOUNTANT TEST

Before declaring the project complete, imagine an accountant asks:

> "Show me why today's gross profit is LKR 250,000."

The system must allow:

Gross Profit

↓

Net Sales = LKR 700,000

↓

Invoices

↓

Orders

↓

Items Sold

↓

Selling Prices / Discounts

AND:

COGS = LKR 450,000

↓

Ingredient Consumption

↓

Recipes

↓

Ingredient Quantities

↓

Inventory Ledger

↓

Goods Receipts

↓

Supplier Purchase Costs

Then:

LKR 700,000

*

LKR 450,000

=

LKR 250,000 Gross Profit

The accountant must be able to verify every step.

---

# 123. SECOND ACCOUNTANT TEST

Ask:

> "Why did chicken inventory decrease by 37.5 kg?"

The system must answer:

37.5 kg decrease

↓

30 kg recipe consumption

↓

5 kg waste

↓

2.5 kg stock adjustment

↓

Each transaction

↓

Each order/reference

↓

Each employee/system action

↓

Dates/times

↓

Costs

Nothing should be unexplained.

---

# 124. THIRD ACCOUNTANT TEST

Ask:

> "Why does the system say we have LKR 125,000 worth of inventory?"

The system must provide:

Ingredient A

* Ingredient B

* Ingredient C

* ...

=

LKR 125,000

and each ingredient must be drillable to:

Quantity

×

Applicable cost

=

Inventory value

with the costing methodology clearly shown.

---

# 125. FOURTH ACCOUNTANT TEST

Ask:

> "We purchased LKR 500,000 worth of ingredients. Why is COGS only LKR 350,000?"

The system must explain:

Purchases

≠

COGS

because some inventory remains in stock.

Show:

Opening Inventory

*

Purchases

*

Consumption/COGS

± Adjustments

=

Closing Inventory

The report must make this understandable without manually reconstructing the database.

---

# 126. FIRST COMMAND TO CLAUDE

**START WITH PHASE 0 ONLY.**

Do NOT modify the code yet.

Audit the entire existing RestaurantOS repository against this master specification.

Return:

1. Current architecture score.
2. Current inventory score.
3. Current accounting/reporting score.
4. Current billing score.
5. Current payment score.
6. Current database score.
7. Current security score.
8. Current multi-tenancy score.
9. Current UI/UX score.
10. Current testing score.
11. CRITICAL issues.
12. HIGH issues.
13. MEDIUM issues.
14. LOW issues.
15. Existing functionality that must be preserved.
16. Inventory data-integrity risks.
17. Financial calculation risks.
18. Reporting/reconciliation risks.
19. Database migration requirements.
20. Exact implementation order.

Pay particular attention to the **inventory → recipe → consumption → costing → COGS → gross profit → reporting chain**.

Do not start implementing until the audit is complete.

After Phase 0, proceed phase-by-phase.

**The goal is not to create the largest amount of code.**

**The goal is to create a RestaurantOS where every important operational and financial number can be traced, reconciled, audited and explained.**

Build it as if a serious restaurant owner, manager and accountant will depend on it every single day.
