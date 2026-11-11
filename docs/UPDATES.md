# Windows install and updates (works offline)

## Get the package
- GitHub → Actions → "Desktop installers" → Run workflow (or push a tag `v0.2.0`). Download `NexSpiro-<version>-Windows.zip` from the run's artifacts or the private Releases page.
- Local alternative on a Windows PC: `npm ci` then `npm run package:win` → `release/NexSpiro-<version>-Windows.zip`.
- Bump `version` in `package.json` for every release.

## Install
- Extract the zip, right-click `NexSpiro-Setup-<version>.exe` → Run as administrator.
- Installs for all users in Program Files, adds Start menu + desktop shortcuts and an uninstaller in Windows Settings → Apps.

## Update
- In NexSpiro press Alt → Help → Update from file…, pick the new zip (or the Setup .exe in it).
- Version is checked (same/older asks first); if the app is code-signed, the update must carry the same signature.
- "Restart now" → administrator prompt → silent install → NexSpiro reopens. "Later" → installs when NexSpiro is closed.
- Settings, printers and profiles are kept.
