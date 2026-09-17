# Update v3.9.8

Fixes status bots not starting because the internal status-node work request was redirected to the public domain. The internal node API is now exempt from canonical-domain redirects.

PayPal Sandbox authentication errors now explicitly indicate when Sandbox credentials are rejected.

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

After the update:

```bash
docker compose logs --tail=100 status-node
```

The log should no longer show 401 errors for `/api/status-nodes/work`.
