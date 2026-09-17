# Update v3.11.6

PayPal-Abo-Kündigung für offene und verzögerte Abozustände repariert.

- `APPROVAL_PENDING` zeigt unter **Your Account** jetzt einen Abbrechen-Button.
- Auch `APPROVED`, `ACTIVE_PENDING_PAYMENT` und `SUSPENDED` können über den Account beendet werden.
- Bei `APPROVAL_PENDING` wird zuerst versucht, die Subscription direkt bei PayPal zu stornieren. Falls PayPal eine noch nicht genehmigte Subscription nicht per Cancel-Endpunkt beendet, wird der lokale Checkout sicher als `CANCELLED_BEFORE_APPROVAL` verworfen.
- Ein abgebrochener Pending-Checkout blockiert danach keine neue Subscription mehr.
- Verzögerte PayPal-Returns oder Webhooks können ein bereits lokal gekündigtes Abo nicht erneut aktivieren.
- Wird ein zuvor abgebrochener Checkout später doch in PayPal bestätigt, versucht der Webhook/Return-Guard die Remote-Subscription automatisch wieder zu kündigen.
- Beim Kündigen wird nicht mehr pauschal ein künstlicher 32-Tage-Premiumzeitraum erzeugt, wenn noch keine bestätigte Zahlung vorliegt.
