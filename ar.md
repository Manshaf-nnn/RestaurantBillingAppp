TABLEFLOW — QR MENU & CUSTOMER ACCESS CONTROL CENTER
MASTER IMPLEMENTATION PROMPT

IMPORTANT:

First inspect the existing implementation for:

- QR ordering
- Customer CRM
- Customer categories
- Customer profiles
- Menu/items/categories
- Offers/discounts
- Loyalty
- Orders
- POS
- Tables/table sessions
- Branches
- Analytics
- Authentication/session handling
- QR/link generation

Reuse the existing systems.

DO NOT create a second customer system, second menu system, second discount system, second loyalty system or separate QR ordering system.

The goal is to create a simple OWNER CONTROL CENTER where the owner can customize what customers see and what information they must provide when entering the QR menu.

Keep the default TableFlow QR ordering behavior unchanged when the owner does not customize anything.

==================================================
1. QR MENU CONTROL CENTER
==================================================

Add a clear owner/admin section:

QR MENU / QR EXPERIENCES

Owner can:

- Create QR experience
- Edit
- Activate/deactivate
- Preview
- Generate QR
- Copy link
- Regenerate QR if required
- View usage/analytics

Keep the UI simple.

Do not make the owner configure complicated technical settings.

==================================================
2. DEFAULT QR EXPERIENCE
==================================================

The existing normal QR ordering flow must remain the DEFAULT.

If the owner creates a QR and changes nothing:

Customer:

Scan QR
→ View menu
→ Select items
→ Enter required customer/table information
→ Place order
→ Existing TableFlow order flow

Do not break the existing QR ordering system.

==================================================
3. TWO MAIN QR EXPERIENCE TYPES
==================================================

Support at least:

A. ORDERING QR

Normal TableFlow QR experience.

Customer can:
- View menu
- Select items
- Order
- Track order
- Use existing customer/loyalty/order flow

B. MENU-ONLY QR

A special QR/link that is primarily for viewing the menu.

Customer can:
- Open menu
- Browse categories
- Search items
- View item details
- View prices
- View offers/special items
- See owner-configured content

This QR must NOT automatically create an order.

If ordering is enabled for that QR, use the existing TableFlow ordering flow.

Do not create a separate menu/order system.

==================================================
4. OWNER CUSTOMIZATION
==================================================

When creating a QR experience, show a simple step-by-step setup.

STEP 1 — BASIC DETAILS

Owner enters:

- QR Experience Name
- Branch/location
- Experience Type:
  - Ordering
  - Menu Only

Optional:
- Description

==================================================
5. CUSTOMER ACCESS / ENTRY SETTINGS
==================================================

Owner chooses what customers must provide when entering this QR experience.

Example:

Customer Information

[ON/OFF]
Identify Customer

If OFF:
Customer can browse/use the default flow without additional identification.

If ON:
Owner can choose what information is required.

Available fields may include:

- Name
- Phone number
- Email
- Customer Category
- Date of Birth
- Anniversary
- Custom fields

Do not make everything mandatory.

Owner controls:

Visible
Required
Optional

for each field where appropriate.

==================================================
6. CUSTOMER CATEGORY
==================================================

This must connect directly to the existing Customer Category system.

Example categories already created by owner:

- Student
- Regular Customer
- VIP
- Corporate
- Tourist

The owner can enable:

"Ask customer to choose category"

If enabled:

Customer sees:

Choose your category

[ Student ]
[ VIP ]
[ Regular Customer ]
[ Corporate ]

Only categories enabled for that QR should appear.

Do NOT create a second category database.

Use the categories already created in Customer CRM.

==================================================
7. CATEGORY-SPECIFIC INFORMATION
==================================================

This is an important feature.

The owner should be able to configure additional information required for each customer category.

Example:

STUDENT

Category:
Student

Required:
Campus ID

Optional:
Phone

VIP

Category:
VIP

Required:
Mobile Number

Corporate

Category:
Corporate

Required:
Company Name
Contact Number

The owner should be able to configure these without coding.

Use simple custom fields where necessary.

Example:

Category:
Student

Add Field:
Campus ID

Type:
Text

Required:
Yes

The customer experience should automatically show the correct fields after selecting the category.

Do NOT show irrelevant fields.

==================================================
8. CUSTOMER CRM CONNECTION
==================================================

This QR system MUST connect to the existing Customer CRM.

Example:

Customer enters:

Phone:
0771234567

Category:
Student

Campus ID:
ABC123

If the phone/customer already exists:

→ Find existing customer
→ Update/use existing profile according to the existing CRM rules
→ Do NOT create duplicate customer

If customer is new:

→ Create customer in the existing Customer system
→ Save category
→ Save configured information
→ Continue with QR experience

Do not create a separate QR customer database.

==================================================
9. CUSTOM FIELDS
==================================================

Owner may need different information for different QR experiences.

Support simple custom fields such as:

- Campus ID
- Student ID
- Membership ID
- Company Name
- Employee ID
- Room Number
- Registration Number

Owner should be able to:

- Add field
- Rename field
- Choose field type
- Make optional/required
- Enable/disable

Keep this simple.

Do NOT build a complicated form builder.

==================================================
10. MENU CUSTOMIZATION
==================================================

Owner can decide what customers see.

Allow customization of:

- Menu categories
- Menu items
- Item visibility
- Item availability
- Prices where existing menu rules allow
- Item descriptions
- Images
- Featured items
- Special offers
- Promotional items

The owner should be able to select:

"Show all menu"

OR

"Customize menu"

If customized:

Select categories/items to show.

Do not duplicate menu items.

The QR experience should reference the existing menu.

==================================================
11. SPECIAL OFFERS
==================================================

Owner can configure special offers for a QR experience.

Example:

Student QR:

Student Lunch
LKR 750

VIP QR:

VIP Special
10% discount

Owner can choose:

- Specific menu item
- Category
- Offer/discount
- Start date
- End date
- Customer category where applicable
- QR experience

IMPORTANT:

Do NOT create another discount engine.

Use the existing TableFlow discount/offer system.

Historical orders must never be changed.

Offers only affect eligible future orders.

==================================================
12. CATEGORY-SPECIFIC MENU/OFFERS
==================================================

Allow the owner to connect category + QR + menu/offer.

Example:

Student QR:

Customer selects:
Student

Then sees:
- Student menu
- Student offers
- Student pricing/discount where configured

VIP:

Customer selects:
VIP

Then sees:
- VIP offers
- VIP menu items
- VIP benefits

Only apply these rules if the owner explicitly configured them.

Default behavior remains unchanged.

==================================================
13. WHAT CUSTOMER CAN SEE
==================================================

Owner should have a simple section:

CUSTOMER EXPERIENCE

Configure:

✓ Menu
✓ Search
✓ Categories
✓ Item details
✓ Prices
✓ Special offers
✓ Customer identification
✓ Loyalty
✓ Ordering
✓ Order tracking
✓ Customer category selection

The owner can enable/disable supported features.

Do not expose settings that are not actually supported by the backend.

==================================================
14. LOYALTY CONNECTION
==================================================

If Loyalty is enabled:

Customer can:

- Enter phone
- Find existing customer
- View loyalty points
- View eligible rewards
- Redeem where allowed

Use the existing Loyalty system.

Do not create a second loyalty balance.

If Loyalty is disabled for the QR:

Do not show loyalty UI.

==================================================
15. ORDER CONNECTION
==================================================

If ordering is enabled:

Orders created through the QR must become normal TableFlow orders.

They must appear in the existing:

Customer
→ Cashier
→ KDS
→ Live Floor
→ Inventory/COGS
→ Billing
→ Payment
→ Reporting

flow.

Do NOT create a separate "QR Order" database/workflow.

The order should retain the QR experience/source for analytics.

==================================================
16. TABLE CONNECTION
==================================================

For normal restaurant table QR ordering:

Use the existing TableFlow table/session logic.

Do not change the existing:

EMPTY
OCCUPIED
RESERVED

rules.

A special Menu-Only QR should not automatically occupy a table.

If an ordering QR is attached to a table, use the existing table/session rules.

==================================================
17. QR GENERATION
==================================================

After the owner finishes configuration:

Show:

[Preview]

[Generate QR]

After Generate:

QR Code
+
Public Link

Provide:

- View QR
- Download/print where existing system supports it
- Copy QR
- Copy Link
- Open Preview

The generated QR must point to a stable public URL.

Do not expose internal IDs unnecessarily.

Each QR experience must have a unique identifier.

==================================================
18. QR MANAGEMENT
==================================================

Owner should see:

QR Experience Name
Type
Branch
Status
Created Date
Usage/Scans if available
Orders if applicable

Actions:

- Open
- Preview
- Edit
- Activate/Deactivate
- Copy Link
- Generate QR
- View Analytics

Do not delete historical QR references if orders depend on them.

Deactivate instead.

==================================================
19. PREVIEW
==================================================

Before generating the QR, owner should have:

PREVIEW EXPERIENCE

The owner should see exactly what a customer will see.

Preview:

- Customer entry
- Category selection
- Required fields
- Menu
- Offers
- Loyalty
- Ordering flow

This should use the same real customer-facing components.

Do not build a fake preview.

==================================================
20. EASY OWNER WORKFLOW
==================================================

The final owner workflow should be approximately:

QR MENU

→ Create QR

→ Name it

→ Choose:
   Ordering
   OR
   Menu Only

→ Choose Branch

→ Customize Customer Access

→ Choose Customer Categories

→ Configure category-specific fields

→ Choose Menu

→ Configure Offers

→ Enable/disable Loyalty/Ordering

→ Preview

→ Generate

→ QR + Link ready

Keep this workflow simple.

Owner should NOT need technical knowledge.

==================================================
21. DEFAULTS
==================================================

IMPORTANT:

If owner does not customize something:

USE EXISTING TABLEFLOW DEFAULT.

Do not force owners to configure every setting.

Example:

Create QR
→ Choose branch
→ Generate

should produce a normal working QR experience using existing TableFlow behavior.

Customization is OPTIONAL.

==================================================
22. ANALYTICS CONNECTION
==================================================

Connect QR experiences to existing analytics.

Where applicable show:

- QR scans/views
- Customers
- New customers
- Returning customers
- Orders
- Sales
- Popular items
- Offers used
- Customer categories
- Loyalty usage

Do not create a completely separate analytics engine.

Use existing reporting definitions.

==================================================
23. CUSTOMER INSIGHTS CONNECTION
==================================================

QR-created customer data should appear in:

Customer CRM
→ Customer Profile
→ Customer Insights

Example:

Student QR

Customer:
John

Category:
Student

Campus ID:
ABC123

Visits:
8

Orders:
10

Total Spent:
LKR 24,500

Loyalty:
450 points

The owner should be able to understand where the customer came from and which QR experience they used where the existing analytics supports it.

==================================================
24. REPORTING / SOURCE
==================================================

Orders should retain source information such as:

QR Experience:
Student Menu QR

Source:
QR

Branch:
Ampara

This allows reporting without creating a separate order system.

==================================================
25. SECURITY
==================================================

Public QR pages must only expose information intentionally configured by the owner.

Never expose:

- Internal database IDs unnecessarily
- Staff information
- Private customer information
- Internal financial data
- Admin information
- Secrets
- API keys

Customer-entered data must be validated server-side.

Customer category/custom-field data must remain tenant-specific.

One restaurant must never see another restaurant's QR configuration or customer data.

==================================================
26. IMPORTANT ARCHITECTURE
==================================================

DO NOT create:

- Second Customer system
- Second Menu system
- Second Order system
- Second Loyalty system
- Second Discount system
- Second Analytics system
- Separate QR database unrelated to TableFlow

QR Experience is a CONFIGURATION LAYER over the existing TableFlow systems.

Conceptually:

QR Experience
      ↓
Customer Access Configuration
      ↓
Existing Customer CRM
      ↓
Existing Menu
      ↓
Existing Offers/Discounts
      ↓
Existing Loyalty
      ↓
Existing Orders
      ↓
Existing KDS/POS/Billing
      ↓
Existing Inventory/COGS
      ↓
Existing Analytics

==================================================
27. IMPLEMENTATION RULE
==================================================

FIRST:

Audit the existing architecture.

Then:

1. Identify reusable models/components
2. Identify existing customer categories
3. Identify existing menu/offer/discount logic
4. Identify existing QR ordering flow
5. Identify existing loyalty
6. Identify existing analytics
7. Design the minimum required changes
8. Implement
9. Test

Do not rebuild working systems unnecessarily.

Do not introduce duplicate business logic.

==================================================
28. TEST THE COMPLETE FLOW
==================================================

Test:

DEFAULT QR:

Create QR
→ Generate
→ Scan
→ Existing default menu/order flow works.

MENU ONLY:

Generate
→ Scan
→ Menu appears
→ No accidental order/table session.

STUDENT QR:

Category:
Student

Required:
Campus ID

Scan
→ Student
→ Campus ID
→ Student menu/offer
→ Customer saved in CRM.

VIP QR:

Category:
VIP

Required:
Phone

Scan
→ VIP
→ Phone
→ VIP configuration applied.

EXISTING CUSTOMER:

Enter existing phone
→ Existing customer found
→ No duplicate customer.

NEW CUSTOMER:

Enter new phone
→ Customer created
→ CRM updated.

ORDERING:

QR
→ Customer
→ Menu
→ Order
→ Existing Cashier/KDS/Billing flow.

LOYALTY:

Customer identified
→ Existing points shown
→ Existing loyalty rules used.

OFFER:

Eligible customer
→ Eligible offer shown/applied.

NON-ELIGIBLE CUSTOMER:

Offer must NOT incorrectly apply.

BRANCH:

QR from Branch A must never expose Branch B configuration/data.

==================================================
FINAL REQUIREMENT
==================================================

Keep this feature EASY for the owner.

The owner should think:

"Create QR → choose what customers see → choose what information to ask → choose menu/offers → preview → generate."

Everything else should happen automatically using existing TableFlow systems.

Do not make the owner configure technical settings.

Do not add unnecessary features.

Do not change the existing default QR ordering behavior.

Do not create duplicate CRM, menu, loyalty, discount, order or analytics systems.

INSPECT FIRST → REUSE EXISTING LOGIC → IMPLEMENT MINIMUM REQUIRED CHANGES → TEST THE COMPLETE FLOW.

The final result must be simple for the owner, simple for customers, and fully connected to the existing TableFlow architecture.