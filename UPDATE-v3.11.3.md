# Update v3.11.3

Checkout, PayPal subscription setup clarity and custom-bot upload reliability.

## Premium checkout

- Premium cards now show only one **Buy / Kaufen** action.
- The new `/checkout/:planId` page is where the customer chooses:
  - one-time payment or monthly subscription
  - PayPal or Stripe
- Logged-out customers can log in with Discord and return directly to the selected checkout.
- Cancelled/failed provider checkouts return to the selected plan checkout.

## PayPal subscriptions

- The admin status now separates **saved monthly prices** from **created PayPal billing plans**.
- Example: `Prices saved 4/4` and `PayPal plans 0/4` clearly means the prices are stored but the PayPal billing plans still need to be created.
- PayPal subscription product/plans are created and persisted before webhook setup. A webhook failure no longer discards an otherwise successful subscription-plan setup.

## Custom bot uploads

- Default ZIP upload limit increased from 5 MB to 25 MB; `update.sh` migrates the old default value automatically.
- Up to 100 MB unpacked source is accepted.
- A single outer project folder in the ZIP is automatically stripped.
- Entrypoint can be left empty and is auto-detected for common Node.js/Python layouts.
- Admin upload and Docker build/start are now separate steps internally. A successful upload remains saved even if the Docker build/start fails.
- Upload errors show more specific messages, including the active size limit.
- Custom-bot Docker builds no longer force-pull the base image every time.
