# Update v3.12.2

- WARDOGS Steam64 IDs are read automatically from `/v1/players`; all currently online players are screened once when the managed bot starts, then new/reconnecting players are screened automatically.
- Steam ban/account lookups are batched; playtime lookups use bounded concurrency.
- WARDOGS Steam App ID is automatic (`1867240`) for the low-playtime rule.
- The complete WARDOGS Discord management UI, modals and action feedback are English.
- Detection alerts now include **Ignore**. Ignored players no longer generate detection alerts or auto-bans for that managed bot.
- The web panel includes a persistent Detection Ignore List with add/remove controls.
- Discord permission grants now include a separate `ignore` permission.
- Database schema 21 stores ignored players and preserves existing service/payment data.
