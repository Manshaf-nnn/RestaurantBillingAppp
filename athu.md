AUTHENTICATION SESSION AUDIT & FIX

Users are being logged out too quickly / login is not persisting for a reasonable period.

First inspect the entire existing authentication implementation before changing anything.

Check:

- Login API
- Session/token creation
- Cookies
- Cookie expiry/max-age
- Secure and SameSite settings
- Domain/path configuration
- Middleware/auth guards
- Session validation
- Token refresh/renewal
- Logout logic
- Browser refresh behavior
- Production vs development environment variables
- Netlify/serverless compatibility
- Database/session storage if used
- Multiple-tab behavior

Identify the actual root cause before making changes.

Then implement secure persistent authentication so that:

1. A successful login remains active across page refreshes.
2. Closing and reopening the browser does not unnecessarily log the user out.
3. Sessions are renewed safely when appropriate.
4. Expired/revoked sessions still force a login.
5. Logout immediately invalidates the session.
6. Authentication works correctly in production on Netlify.
7. Do not store sensitive authentication tokens insecurely in localStorage if the current architecture can use secure HttpOnly cookies.
8. Do not weaken authentication security just to keep users logged in longer.
9. Respect existing RBAC, tenant isolation and branch permissions.
10. Super Admin sessions should use stronger security controls than normal staff accounts.

Also test:

- Login
- Page refresh
- Browser close/reopen
- Session expiry
- Logout
- Multiple tabs
- Invalid/expired session
- Production deployment
- Different user roles

Do not rewrite the authentication system unnecessarily. Reuse the existing architecture and fix the root cause.

After fixing it, explain:
- Root cause
- What was changed
- Session lifetime
- Cookie/session configuration
- Production environment requirements
- Tests performed