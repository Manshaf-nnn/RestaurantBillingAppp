TABLEFLOW — REBUILD PAYMENT DETAILS + PAYMENT DESTINATIONS

IMPORTANT:
Completely rebuild ONLY these two areas:

1. Payment Details
2. Settings → Payment → Where Each Payment Lands

Keep the flow extremely simple and user-friendly.

DO NOT add any extra features, integrations, or workflows.
DO NOT use real bank connections or payment gateways.
This is an INTERNAL money/account tracking system only.

FIRST inspect the existing payment/account logic and reuse it where possible.

==================================================
1. PAYMENT DETAILS
==================================================

The Payment Details page should have exactly TWO main buttons:

[ Create Account ]    [ Money Transfer ]

--------------------------------------------------
CREATE ACCOUNT
--------------------------------------------------

Owner can create any internal bank/account record.

Fields:
- Account Heading/Name
- Bank Name
- account number 
- holder name 

Example:

BOC Main Account
BOC

After creation, show an account card clearly displaying:

BOC Main Account
BOC
Current Balance

Each account card must have:

[ Deposit ]

Deposit flow:

Click Deposit
→ Enter Amount
→ Confirm
→ Amount is added to that account's internal balance.

This is NOT a real bank transaction.
It only updates the internal TableFlow account balance.

Every deposit must create a transaction record and audit history.

--------------------------------------------------
MONEY TRANSFER
--------------------------------------------------

Owner can transfer money between any created accounts.

Flow:

Money Transfer
→ From Account
→ To Account
→ Amount
→ Reason/Note
→ Confirm

Example:

BOC → HNB
LKR 50,000

After confirmation:

BOC balance decreases by 50,000
HNB balance increases by 50,000

The transfer must be one atomic transaction.

Never allow the transfer to partially complete.

==================================================
2. ACCOUNT STAFF ACCESS
==================================================

Owner can assign staff to each account.

For every account, owner can decide:

- Which staff can access the account
- Which staff can transfer money FROM that account

A staff member must NOT be able to transfer from an account unless explicitly authorized.

Permissions must be enforced on the backend, not only hidden in the UI.

Owner/Main Admin has full access.

Do not create additional permission complexity.

==================================================
3. TRANSACTION HISTORY / REPORT
==================================================

Provide a clear report/history showing the complete process for every account transaction.

Show:

- Date/time
- Transaction type
- From account
- To account
- Amount
- Reason/note
- Staff/user
- Reference
- Resulting balance

Transaction types:

- Deposit
- Transfer

Account balance and transaction history must always reconcile.

Never edit historical transactions directly.

==================================================
4. SETTINGS → PAYMENT → WHERE EACH PAYMENT LANDS
==================================================

Completely simplify this section.

For every existing payment method, show ONE dropdown.

Example:

CASH           → [ BOC Main Account ▼ ]
CARD           → [ HNB Account ▼ ]
QR             → [ BOC Main Account ▼ ]
ONLINE         → [ NDB Account ▼ ]
WALLET         → [ HNB Account ▼ ]
BANK_TRANSFER  → [ NDB Account ▼ ]

The dropdown must show ONLY the accounts created in:

Payment Details

Show the account's bank name/label.

REMOVE all other destination options.

Do not allow manually entering arbitrary destinations here.

==================================================
5. AUTOMATIC PAYMENT ACCOUNTING
==================================================

When a cashier collects a payment:

Example:

Cash payment:
LKR 5,000

If:

CASH → BOC

Then the internal BOC account balance automatically increases by:

LKR 5,000

And the transaction must record:

Payment Method: CASH
Destination: BOC
Amount: LKR 5,000
Source: Customer Payment
Staff: Cashier
Date/Time
Related Order/Invoice

Same logic for every payment method.

This is INTERNAL ACCOUNT TRACKING ONLY.

No real bank API.
No real bank connection.
No payment gateway.
No external money movement.

==================================================
6. IMPORTANT DISTINCTION
==================================================

There are only TWO ways money enters an internal account:

1. Deposit
2. Customer payment assigned through Settings → Where Each Payment Lands

Money moves between accounts only through:

Money Transfer.

Do not create any other money movement mechanism.

==================================================
7. UI
==================================================

Make the UI very clean and simple, similar in usability to the existing Transfer tab.

Payment Details:

[ Create Account ] [ Money Transfer ]

Then clean account cards:

┌─────────────────────────────┐
│ BOC Main Account            │
│ BOC                         │
│ Balance: LKR 250,000        │
│                             │
│ [ Deposit ] [ Transactions ]│
└─────────────────────────────┘

Keep the interface simple.

Do not add dashboards, analytics, banking integrations, unnecessary settings, or unrelated features.

==================================================
8. DATA / SECURITY
==================================================

Inspect and reuse existing accounting/payment architecture.

All balance changes must happen through controlled backend transactions.

Never allow frontend-only balance changes.

Every deposit, payment allocation and transfer must be:

- Atomic
- Auditable
- Tenant isolated
- Branch-aware where applicable
- Duplicate-safe
- Historically traceable

Do not silently modify historical balances.

==================================================
FINAL IMPLEMENTATION RULE
==================================================

AUDIT EXISTING PAYMENT/ACCOUNT LOGIC
→ REUSE WHAT EXISTS
→ REBUILD THESE TWO AREAS
→ CONNECT PAYMENT DESTINATIONS
→ TEST BALANCES
→ TEST TRANSACTIONS
→ TEST STAFF PERMISSIONS

Do NOT add anything that is not explicitly requested above.

The final concept must remain extremely simple:

CREATE ACCOUNT
→ DEPOSIT / RECEIVE CUSTOMER PAYMENTS
→ TRANSFER BETWEEN ACCOUNTS
→ VIEW COMPLETE TRANSACTION HISTORY

And:

PAYMENT METHOD
→ SELECT CREATED ACCOUNT
→ CUSTOMER PAYMENT AUTOMATICALLY ADDS TO THAT ACCOUNT.