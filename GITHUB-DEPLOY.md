# GitHub Deploy

## Bestehendes GitHub Repository aktualisieren

Entpacke die neue Version lokal und ersetze die Projektdateien im Repository. **Nicht** hochladen:

```text
.env
data/
custom-bots/
backups/
```

Dann committen/pushen.

Auf dem VPS:

```bash
cd /opt/wardogs-status-panel   # oder dein Clone-Pfad
./update.sh
```

`update.sh` zieht GitHub, korrigiert automatisch die Schreibrechte der persistenten Ordner und baut Panel + Runner neu.

## Neuinstallation

```bash
sudo apt update
sudo apt install -y git
cd /opt
sudo git clone https://github.com/USER/REPO.git server-status-hub
cd server-status-hub
sudo chmod +x *.sh
sudo ./setup-vps.sh
```

Für private Repositories SSH Deploy Key verwenden.
