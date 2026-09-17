# Update v3.11.0

## Stripe integration

- Stripe Test/Live configuration in Admin → Settings
- Encrypted Stripe Secret Key and Webhook Secret
- Automatic Stripe webhook creation/test
- One-time Premium checkout
- Monthly Premium subscriptions
- Stripe subscription cancellation in Your Account
- PayPal and Stripe can be enabled at the same time

## Update

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

After the update open **Admin → Settings → Premium & Stripe**, enter a Stripe Test or Live Secret Key, set prices and click **Save & automatically set up / test Stripe**.
