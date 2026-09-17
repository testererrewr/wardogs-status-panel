# Update v3.12.6

## WARDOGS status-bot seeding range

The normal WARDOGS status bot now shows the automatic **Seeding** presence only while the server has **1 through 20 players**.

- 0 players: no Seeding
- 1-20 players: Seeding can be shown when the option is enabled
- 21+ players: no Seeding

An exact `Seeding` rotation entry is filtered while the automatic WARDOGS seeding option is enabled, so it cannot remain visible outside the allowed player range.
