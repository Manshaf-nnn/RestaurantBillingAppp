TABLEFLOW — WEBSITE CONNECTION SYSTEM

IMPORTANT: DO NOT START CODING IMMEDIATELY.

FIRST inspect the existing TableFlow architecture and understand:

- Restaurant/tenant structure
- Branch structure
- Existing authentication and RBAC
- Existing API structure
- Menu system
- Order system
- POS
- KDS
- Billing/payment logic
- Inventory and COGS
- Existing realtime system
- Existing Super Admin
- Existing settings and integration patterns

Identify what already exists and REUSE it.

DO NOT blindly rebuild anything.
DO NOT create duplicate restaurant, branch, user, order, menu, billing or API systems.
DO NOT change existing financial/business logic.
DO NOT break existing POS functionality.

Only after understanding the existing system, implement the following:

==================================================
WEBSITE CONNECTION
==================================================

Add a simple:

Super Admin
→ Restaurants
→ Select Restaurant
→ Connect Website

option for every registered restaurant.

The Connect Website page should automatically generate everything required to connect that restaurant's website to TableFlow.

Show:

- Website URL
- TableFlow API URL
- Restaurant ID
- Branch ID
- Secure API/Connection Key
- Webhook URL if required
- Connection Status
- Last Connection

Buttons:

[ Test Connection ]
[ Generate Key ]
[ Regenerate Key ]
[ Copy Integration Details ]
[ Disconnect ]

No hardcoded restaurant IDs, branch IDs or API URLs.

Everything must be generated from the selected restaurant.

==================================================
WEBSITE CONNECTION FLOW
==================================================

Website developer enters the generated connection details into the website configuration.

Then:

Website
→ TableFlow API
→ Correct Restaurant
→ Correct Branch
→ TableFlow POS

The website should automatically receive/use:

- Restaurant information
- Logo/branding
- Menu
- Categories
- Food items
- Prices
- Availability
- Opening hours
- Ordering
- Order status

Website orders must become normal TableFlow orders.

Reuse the existing order, billing, payment, inventory, COGS, KDS and reporting systems.

DO NOT create a separate website order system.

==================================================
SECURITY
==================================================

Each restaurant must have its own secure connection.

Restaurant A website can access ONLY Restaurant A data.

Restaurant B website can access ONLY Restaurant B data.

Enforce tenant and branch isolation on the backend.

Do not expose secret API keys in frontend/browser code.

Keys must be revocable and regeneratable.

Use proper authentication, authorization, validation and rate limiting.

==================================================
FINAL USER EXPERIENCE
==================================================

Make the entire process extremely simple:

Super Admin
→ Select Restaurant
→ Connect Website
→ Generate Connection Details
→ Website Developer Adds Details
→ Test Connection
→ Connected ✓

After connection:

Website ↔ TableFlow POS

The system should require minimal technical configuration.

IMPORTANT:

First inspect.
Then understand.
Then reuse existing architecture.
Then implement only what is missing.

Do not blindly rebuild existing functionality.

After implementation, run tests and verify that existing POS, billing, inventory, accounting, KDS, reports and other restaurant modules still work correctly.