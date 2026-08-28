Implement a Feature Plan / Feature Access Management system for the Super Admin.

Some restaurants may purchase only a basic or minimal version of the POS, while others may purchase more features.

When a new restaurant requests approval, the Super Admin should be able to decide exactly which features are enabled for that restaurant.

FLOW:

Restaurant Registration
→ Restaurant requests approval
→ Appears in Super Admin Approval page
→ Super Admin opens the restaurant request
→ Selects a Plan/Package or manually selects features
→ Approves the restaurant
→ Restaurant can only access the approved features.

FEATURE SELECTION:

Show all available system features with enable/disable toggles or checkboxes.

Example:

☑ Dashboard
☑ Orders
☑ Tables
☑ Cash Drawer
☑ Kitchen
☑ Menu Management
☑ Inventory
☐ Purchase Orders
☐ GRN / Purchasing
☐ Supplier Management
☐ Staff Management
☐ Shift Handover
☐ Reservations
☐ Multi-Branch
☐ Inter-Branch Transfer
☐ Advanced Reports
☐ Customer Management
☐ QR Ordering
☐ Kitchen Stations

The Super Admin must be able to:

- Enable all features
- Disable all features
- Select individual features
- Create reusable feature packages such as Basic, Standard, and Premium
- Modify feature access for an existing restaurant later
- Upgrade or downgrade a restaurant without deleting its existing data

IMPORTANT LOGIC:

If a feature is disabled:
- It must be hidden from the restaurant's sidebar and dashboard.
- Users must not access it through direct URLs.
- APIs and backend actions for that feature must also be protected.
- The restaurant's data must NOT be deleted; access is simply disabled.

When the feature is enabled again, the restaurant should regain access to its existing data.

FEATURE ACCESS MUST BE CHECKED ON:
- Frontend/sidebar
- Page routes
- Backend/API
- Role permissions

ACCESS LOGIC:

Super Admin Feature Access
        ↓
Restaurant Feature Availability
        ↓
Role Permission
        ↓
User Access

A user can access a feature only if:
1. The Super Admin has enabled the feature for that restaurant, AND
2. The user's role has permission to access that feature.

The Super Admin controls what features the restaurant owns.
The Restaurant Owner/Admin controls which roles inside the restaurant can use those enabled features.

Do not hardcode packages. Allow the Super Admin to create and manage feature packages and manually customize features for each restaurant.