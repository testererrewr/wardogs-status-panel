# Update v3.12.12

- Fixed WARDOGS join welcome whispers that could be lost when the player appeared with a faction slightly before the whisper endpoint was ready.
- Welcome delivery is now recorded only after WARDOGS confirms the message request.
- Clear spawn/readiness HTTP failures retry up to four attempts for the same join session.
- A successful whisper is never repeated for that join session.
- Unsupported/auth failures and ambiguous transport failures are not retried blindly, avoiding duplicate messages.
- Faction parsing accepts both string and object-shaped values.
- Database version remains 24.
