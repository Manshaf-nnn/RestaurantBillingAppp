Implement a professional and flexible Product, Menu, Variant, Portion, Pricing, and Order Customization system for the restaurant POS. Inspect the existing Menu, QR Ordering, Counter Order, Takeaway, Cashier, Kitchen, Inventory, and Order logic first. Do not recreate working features unnecessarily. Extend the existing system properly with real database and backend logic. Do not only create UI.

CORE REQUIREMENT

The system must support different types of food and product variations without creating a separate menu item for every size or portion.

Examples:

Rice:
- Normal
- Full

Kottu:
- Normal
- Full

Pizza:
- Small
- Medium
- Large

Pasta:
- Regular
- Large

Drinks:
- Small
- Medium
- Large

Any future food item should be able to have its own custom options, sizes, portions, quantities, prices, and modifiers.

The system must be fully flexible. Do not hard-code Normal, Full, Small, Medium, or Large globally. The shop owner/admin must be able to create their own option names.

For example, one restaurant may use:
- Half / Full
Another may use:
- Normal / Full
Another may use:
- Small / Medium / Large
Another may use:
- 6 Inch / 9 Inch / 12 Inch

The system must support all of these.

PRODUCT AND MENU STRUCTURE

Use the following professional hierarchy:

Category
→ Menu Item / Product
→ Variant Group or Option Group
→ Variant / Option
→ Individual Price

Example 1:

Category: Rice

Menu Item: Chicken Fried Rice

Variant Group: Portion

Variants:
- Normal — Rs. 850
- Full — Rs. 1,400

Example 2:

Category: Pizza

Menu Item: Chicken BBQ Pizza

Variant Group: Size

Variants:
- Small — Rs. 1,200
- Medium — Rs. 1,800
- Large — Rs. 2,500

Example 3:

Menu Item: BBQ Pasta

Variant Group: Portion

Variants:
- Regular — Rs. 1,100
- Large — Rs. 1,600

The Owner/Admin must be able to create, edit, reorder, activate, deactivate, or remove variant groups and variants.

CREATE MENU ITEM FLOW

When creating a menu item, include:

- Menu Item Name
- Category
- Description
- Image
- Base Price, if applicable
- Branch availability
- Variant/Option support
- Add-ons/Modifiers support
- Preparation time, optional
- Active/Inactive status

The admin must be able to choose:

1. Simple Product
Example:
Water Bottle — Rs. 100

No size or variant is required.

2. Product with Variants
Example:
Chicken Fried Rice
- Normal — Rs. 850
- Full — Rs. 1,400

3. Product with Multiple Option Groups
Example:
Pizza
Size:
- Small
- Medium
- Large

Crust:
- Thin
- Thick

The system must support required and optional option groups.

VARIANT LOGIC

When the admin enables variants for a food item, allow creation of a custom Variant Group.

Example:

Variant Group Name:
[ Portion ]

Selection Type:
[ Single Selection ]

Required:
[ Yes ]

Variants:
- Normal | Price: Rs. 850
- Full | Price: Rs. 1,400

For Pizza:

Variant Group Name:
[ Size ]

Variants:
- Small | Price: Rs. 1,200
- Medium | Price: Rs. 1,800
- Large | Price: Rs. 2,500

The admin must be able to add unlimited variants.

Do not limit the system to only 2 or 3 options.

ORDER FLOW FROM QR MENU

When a customer scans the QR code, they should see only the menu available for that branch.

When they select a food item with variants:

Example:

Chicken Fried Rice

Select Portion:
○ Normal — Rs. 850
○ Full — Rs. 1,400

Quantity:
[-] 1 [+]

[ Add to Cart ]

If the item has a required variant, the customer must select one before adding it to the cart.

Example for Pizza:

Chicken BBQ Pizza

Select Size:
○ Small — Rs. 1,200
○ Medium — Rs. 1,800
○ Large — Rs. 2,500

Select Quantity:
[-] 1 [+]

Add to Cart

The selected variant must be saved with the order item.

Example:

Order:
2 × Chicken Fried Rice — Normal
1 × Chicken BBQ Pizza — Large

Do not save only the parent menu item. Save the selected variant and the final unit price as part of the order item.

BRANCH-SPECIFIC QR ORDERING

Each branch must have its own QR and its own menu context.

When a customer orders from Branch A QR:

- Show Branch A menu availability
- Show Branch A tables only
- Create the order under Branch A
- Send the order to Branch A kitchen
- Use Branch A prices if branch-specific pricing is configured
- Never send the order to Main Branch or another branch

The QR order must contain the correct branch context from the beginning.

COUNTER ORDER AND TAKEAWAY ORDER

The same menu and variant system must also work at the Cashier/POS.

The Cashier should be able to create:

- Dine-In Order
- Takeaway Order
- Counter Order
- QR/Table Order

The product selection logic must be consistent across all order types.

Example:

Cashier selects:
Chicken Fried Rice
→ System asks/selects Portion
→ Normal or Full
→ Select Quantity
→ Add to Order

For a takeaway order:

Order Type: Takeaway

Customer Name: Optional/Required according to settings
Mobile Number: Optional/Required according to settings

Then:

Chicken BBQ Pizza
Size: Large
Quantity: 2

The system must correctly calculate:

Unit Price × Quantity

Example:

Large Pizza: Rs. 2,500
Quantity: 2

Total: Rs. 5,000

CUSTOM PRICE AND QUANTITY ADJUSTMENT AT CASHIER

The Cashier/authorized staff must be able to adjust the quantity for every order item.

Example:

BBQ Pasta — Regular
Quantity:
[-] 2 [+]

The system must recalculate the line total automatically.

PRICE ADJUSTMENT

For authorized roles only, allow price adjustment at the order level.

Example:

BBQ Pasta — Regular
Original Price: Rs. 1,100

Price Adjustment:
New Price: Rs. 1,000
Reason: Customer Discount / Manager Approval

Important rules:

- Do not silently overwrite the original menu price
- Save the original price
- Save the adjusted price
- Save adjustment amount
- Save adjustment reason
- Save who made the adjustment
- Save date/time
- Require manager approval if configured by the Owner

Normal Cashiers should only be able to adjust prices if the Owner/Admin has granted that permission.

OWNER/ADMIN MENU PRICE CONTROL

The Owner/Admin should be able to edit menu prices at any time.

They must be able to change:

Chicken Fried Rice:
Normal: Rs. 850 → Rs. 900
Full: Rs. 1,400 → Rs. 1,500

Pizza:
Small: Rs. 1,200 → Rs. 1,300
Medium: Rs. 1,800 → Rs. 1,900
Large: Rs. 2,500 → Rs. 2,600

Price changes must affect new orders only.

Important:
Old completed orders must keep the exact historical price that was charged at the time of the order.

Do not update old order totals when a menu price changes.

STORE PRICE SNAPSHOTS IN ORDER ITEMS

When an order is created, save:

- Product ID
- Product Name Snapshot
- Selected Variant ID
- Selected Variant Name Snapshot
- Original Unit Price
- Adjusted Unit Price, if applicable
- Quantity
- Discount
- Final Line Total

This ensures historical orders remain accurate even if:

- Product name changes
- Variant name changes
- Menu price changes
- Product is deleted or deactivated

ADD-ONS AND MODIFIERS

Also support optional or required add-ons/modifiers.

Example:

Pizza:
Extra Cheese — +Rs. 300
Extra Chicken — +Rs. 500

Pasta:
Extra Cheese — +Rs. 250

Rice:
Extra Egg — +Rs. 150

The admin must be able to create custom Modifier Groups.

Example:

Modifier Group:
Extra Toppings

Selection:
Multiple Selection

Options:
- Extra Cheese — Rs. 300
- Extra Chicken — Rs. 500
- Extra Sauce — Rs. 100

The final price should be:

Base/Variant Price
+ Selected Modifier Prices
× Quantity

Example:

Large Pizza: Rs. 2,500
Extra Cheese: Rs. 300
Extra Chicken: Rs. 500

Unit Price: Rs. 3,300

Quantity: 2

Final Total: Rs. 6,600

ORDER ITEM NOTES

Allow customers or Cashiers to add special instructions where enabled.

Examples:

- Less spicy
- No onions
- Extra spicy
- No cheese

Notes must be sent to the correct branch kitchen together with the order.

Notes must not change the price unless they are linked to a paid modifier.

BRANCH-SPECIFIC MENU AND PRICING

Menu items must support branch availability.

Example:

Chicken Fried Rice:
- Main Branch: Available
- Kandy Branch: Available
- Galle Branch: Not Available

The Owner/Admin should be able to control which branch can sell each item.

Do not automatically make every new menu item available to all branches unless the Owner explicitly chooses that.

When creating or editing a menu item, provide:

Available Branches:
☑ Main Branch
☑ Kandy Branch
☐ Galle Branch

Also support branch-specific pricing where required.

Example:

Chicken Fried Rice — Normal:

Main Branch: Rs. 850
Kandy Branch: Rs. 900

The system must resolve the correct price based on the branch where the order is created.

If no branch-specific price exists, use the default menu price.

IMPORTANT BRANCH LOGIC

Each branch is operationally isolated.

Branch A:
- Own QR code
- Own tables
- Own orders
- Own kitchen
- Own staff permissions
- Own menu availability
- Optional branch-specific prices

Branch B:
- Separate QR code
- Separate tables
- Separate orders
- Separate kitchen
- Separate staff permissions
- Separate menu availability
- Optional branch-specific prices

An order from Branch B must never appear in Branch A's kitchen or Main Branch kitchen unless an explicitly configured central kitchen workflow exists.

KITCHEN ORDER DISPLAY

Kitchen staff must see:

- Order Number
- Order Type
- Table Number, for Dine-In/QR orders
- Takeaway/Counter indicator where applicable
- Items
- Selected Variant/Size/Portion
- Quantity
- Selected Add-ons
- Special Instructions
- Order Time

Example:

Order #1024
Branch: Kandy Branch
Type: Dine-In
Table: 05

2 × Chicken Fried Rice
Portion: Full

1 × Chicken BBQ Pizza
Size: Large
Extra Cheese

1 × BBQ Pasta
Portion: Regular
Note: Less spicy

The kitchen must see the exact selected variant and modifiers.

INVENTORY CONNECTION

Where recipe/inventory management is enabled, inventory consumption must depend on the selected product and variant.

Example:

Chicken Fried Rice:
Normal uses:
- Rice: 200g
- Chicken: 100g

Full uses:
- Rice: 350g
- Chicken: 180g

When the Full variant is ordered, deduct the Full recipe quantities, not the Normal recipe quantities.

For Pizza:

Small, Medium, and Large can have separate recipe quantities.

Example:
Small:
- Cheese: 100g

Large:
- Cheese: 200g

The inventory deduction logic must use the selected variant.

Do not deduct inventory from the parent item without considering the selected portion or size.

ORDER RECORD AND HISTORY

Every order item must permanently store:

- Branch ID
- Order ID
- Order Type
- Table ID where applicable
- Customer details where applicable
- Product ID
- Product Name Snapshot
- Variant ID
- Variant Name Snapshot
- Selected Modifiers Snapshot
- Original Unit Price
- Adjusted Unit Price if applicable
- Quantity
- Discount
- Final Line Total
- Special Instructions
- Created Date/Time
- Created By
- Payment Status

This information must remain historically correct even if the menu changes later.

PERMISSIONS

Owner/Admin:
- Full access
- Create menu items
- Create categories
- Create variants
- Create modifier groups
- Set branch availability
- Set prices
- Set branch-specific prices
- Control who can adjust prices

Manager:
Permissions configurable by Owner.

Cashier:
- Create Counter Orders
- Create Takeaway Orders
- Edit quantity before finalizing
- Adjust price only if permission is granted
- Must provide a reason for price adjustments

Waiter:
- Create permitted orders
- Change quantity before kitchen processing according to permissions
- No price adjustment unless specifically allowed

Kitchen:
- View only authorized branch kitchen orders
- Cannot see other branch orders

Customer:
- Can order only from the menu and branch linked to the QR code
- Cannot adjust prices manually

REPORTING

Add reports and filters for:

- Menu Item Sales
- Variant/Size/Portion Sales
- Quantity Sold
- Revenue by Product
- Revenue by Variant
- Branch-wise Product Sales
- Cashier Price Adjustments
- Discount and Adjustment Report
- Most Popular Variant
- Most Popular Food Item

Filters:
- Branch
- Category
- Menu Item
- Variant
- Order Type
- Cashier
- Date Range

Date Range options:
- Today
- Yesterday
- This Week
- Last Week
- This Month
- Last Month
- Custom Date Range

The report must use actual saved order data and historical order price snapshots.

FINAL TESTING REQUIREMENTS

Test all of the following:

- Rice can have Normal and Full options.
- Kottu can have Normal and Full options.
- Pizza can have Small, Medium, and Large options.
- Any future custom size/portion names can be created by the Owner.
- Unlimited variants can be added.
- Simple products can exist without variants.
- Products can have required or optional option groups.
- Products can have add-ons/modifiers.
- QR orders correctly save selected variants.
- Counter orders correctly save selected variants.
- Takeaway orders correctly save selected variants.
- Quantity correctly updates the total.
- Authorized staff can adjust prices.
- Unauthorized staff cannot adjust prices.
- Every price adjustment is audited.
- Old orders retain historical prices after menu price changes.
- Branch A menu does not automatically appear in every branch unless assigned.
- Each branch can have different availability and pricing.
- Branch B QR sends orders only to Branch B kitchen.
- Kitchen displays the exact portion, size, quantity, add-ons, and notes.
- Inventory deduction uses the correct recipe for the selected variant.
- Reports correctly show sales by product and variant.
- All branch data remains isolated.

FINAL BUSINESS RULE

Build this as a flexible restaurant product configuration system, not a hard-coded food-size system. The Owner/Admin must be able to create any food, any size, any portion, any option name, any variant, and any modifier. The same product configuration must work consistently for QR ordering, Dine-In, Table Orders, Counter Orders, Takeaway Orders, Cashier POS, Kitchen Display, Inventory, Billing, Reports, and historical order records. Prices, quantities, variants, and modifiers must always be accurately saved with each order, and all branch operations must remain properly isolated.