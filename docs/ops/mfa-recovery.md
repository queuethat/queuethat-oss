# MFA: owner lockout recovery

When an org turns on "Require 2FA for owners and admins" (`organizations.require_mfa_for_admins`), an
owner or admin whose session is not aal2 is treated as a manager (`private.has_role`). The floor keeps
running; configuration, export and deletion wait for a second factor.

Supabase TOTP has no recovery codes. Two ways out of a lost authenticator:

1. **Enrol two authenticators** (the account security page advises it). Either one signs in.
2. **Self-hosters** remove the lost factor with the Auth admin API, then the owner signs in and enrols again:

   ```sh
   # list the user's factors, then delete the lost one (service role key; never put it in the web app)
   curl -s "$API_URL/auth/v1/admin/users/$USER_ID/factors" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY"
   curl -s -X DELETE "$API_URL/auth/v1/admin/users/$USER_ID/factors/$FACTOR_ID" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY"
   ```

   Last resort when the whole org is locked out: `update app.organizations set require_mfa_for_admins = false where id = '<org>'`
   as the database owner, then sign in and enrol.

`api.set_require_mfa` needs an aal2 session, so an owner can never switch the requirement on without a working factor.
Hosted tenants contact the platform operator, who can clear a factor from the console.
