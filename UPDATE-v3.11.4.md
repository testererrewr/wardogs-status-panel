# Update v3.11.4

- Custom-Bot ZIP-Upload robuster gemacht.
- `node_modules`, `.git`, `venv`, `.venv`, `__pycache__` und macOS-Metadaten werden beim Upload ignoriert.
- Bis zu 5000 relevante Quelldateien pro ZIP, weiterhin 25 MB Upload- und 100 MB Entpack-Limit.
- Maximal 20.000 rohe ZIP-Einträge als Schutz vor missbräuchlichen Archiven.
- Normale ZIPs mit äußerem Projektordner werden weiterhin automatisch erkannt.
