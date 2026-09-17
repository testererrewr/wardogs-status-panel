# Update v3.12.15

The WARDOGS Management Bot now has a dedicated **Ban messages** settings block with an optional Discord server/invite link.

When configured, every ban automatically appends the invite after the reason:

- Permanent: `Teamkilling | Discord: https://discord.gg/example`
- Temporary: `Ban duration: 1 day | Teamkilling | Discord: https://discord.gg/example`

This applies to manual bans, ban templates and detection-rule bans. The invite is normalized to a `discord.gg` URL and is included in config export/import.

Ban time entry has also been cleaned up across the WARDOGS Management Bot. The web panel no longer asks for raw minutes: choose **Permanent**, **Hours** or **Days** and enter the amount only for temporary bans. Ban templates and temporary detection actions use the same Hours/Days controls. The Discord management panel now asks for Permanent/Hours/Days before opening the ban modal as well.

Database schema version: 26.
