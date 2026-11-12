# Motionex on the web (Cloudflare Pages) + printer bridge

Motionex runs entirely in the browser: design, motions, slicing, print physics and the preview all use the
computer of whoever has the page open (its processor, graphics card and memory). Cloudflare only hands out
the app files. Printers are reached through the **Motionex printer bridge**, a small program you run on one
computer on the same network as your printers.

```
 your browser (Motionex web app) ──ws://127.0.0.1:47800──▶ printer bridge ──LAN──▶ A1 · P1S · U1 · Neptune 4 Max
          ▲
          └── files only ── Cloudflare Pages (motionex.pages.dev), behind Cloudflare Access (private)
```

## 1. Build

```bash
npm ci
```

```bash
npm run build:web
```

This writes `dist-web/` (the site, plus `motionex-bridge.cjs` so the Printers page can offer it as a
download). `npm run dev:web` runs the web app locally; `npm run bridge` builds and starts the bridge.

## 2. Put it on Cloudflare Pages — pick one

**A. Connected to GitHub (recommended: every push redeploys)**
1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → choose `studionexify/Motionex`.
2. Project name: `motionex` (gives `https://motionex.pages.dev`).
3. Production branch: the branch you want live (e.g. `main` after merging, or `claude/elegant-hamilton-epih70`).
4. Build command: `npm ci && npm run build:web` · Build output directory: `dist-web` · Root directory: (leave empty).
5. Environment variables: `NODE_VERSION` = `20`, `ELECTRON_SKIP_BINARY_DOWNLOAD` = `1` (skips the desktop-app download, faster builds).
6. Save and deploy.

**B. Upload from your computer (no Git connection)**

```bash
npm run build:web
```

```bash
npx wrangler pages deploy dist-web --project-name motionex
```

(The first run asks you to log in to Cloudflare in the browser.)

## 3. Make it private — Cloudflare Access (free for up to 50 users)

1. Cloudflare dashboard → Zero Trust (first time: pick a team name, the Free plan).
2. Access → Applications → Add an application → Self-hosted.
3. Application domain: `motionex.pages.dev` — add a second entry `*.motionex.pages.dev` so preview builds are private too.
4. Add a policy: Action **Allow**, Include → **Emails** → your email(s) (or "Emails ending in" your domain).
5. Login method: One-time PIN (a code is emailed) — or add Google / GitHub login under Settings → Authentication.
6. Save. Opening the site now asks for sign-in first; nobody else gets the app files.

Shortcut: Pages project → Settings → General → **Enable access policy** creates a similar Access application for preview deployments; add `motionex.pages.dev` itself as above for the main site.

## 4. Printer bridge — run it on a computer next to your printers

Needs [Node.js 18 or newer](https://nodejs.org).
1. In Motionex → **Printers**, download `motionex-bridge.cjs`.
2. Run it:

```bash
node motionex-bridge.cjs
```

3. It prints a **pairing code**. Type it on the Printers page and press Connect (once per browser).
4. If the browser asks to allow this site to reach devices on your local network, choose **Allow**.
5. Add printers on the same page (or **Find printers on the network**):
   - **Bambu Lab A1 / P1S**: Bambu LAN — IP address, serial number, access code (printer screen → Settings → WLAN / LAN only).
   - **Elegoo Neptune 4 Max**, **Snapmaker U1**: Klipper / Moonraker — IP address.
   - Any OctoPrint printer: IP address and API key.

Options:

```bash
node motionex-bridge.cjs --port 47800 --origin https://your-own-domain.example
```

- `--origin` adds another site allowed to use the bridge (`https://motionex.pages.dev`, its preview builds and `localhost` are allowed by default).
- `--lan` listens on the whole network instead of this computer only (not recommended; only for running the bridge on another machine, e.g. a Raspberry Pi — browsers may block an `ws://` address that isn't `localhost`).
- Settings, printers and the pairing code live in `~/.motionex-bridge/` (readable only by your user). Delete `config.json` there to get a new pairing code.

Start it automatically (pick one):
- **Windows**: Task Scheduler → Create task → "At log on" → Program `node`, Arguments `C:\path\motionex-bridge.cjs`.
- **macOS**: a LaunchAgent plist in `~/Library/LaunchAgents` running `node /path/motionex-bridge.cjs`.
- **Linux / Raspberry Pi**: a systemd user service with `ExecStart=/usr/bin/node /path/motionex-bridge.cjs`.

## 5. Good to know

- **Browsers**: Chrome or Edge recommended (they allow a secure site to reach the bridge on `localhost` and support USB printers). Safari and Firefox work for design and slicing; reaching the bridge can be blocked there.
- **Storage**: designs and settings stay in the browser on each computer (library in IndexedDB). Clearing site data deletes them; use Export STL / G-code for anything you want to keep elsewhere.
- **Security**: the bridge only listens on `127.0.0.1`, only accepts the Motionex site's origin, and only after pairing. Bambu access codes are stored in plain text in `~/.motionex-bridge/devices.json` with user-only permissions.
- **USB printers** connect straight from Chrome/Edge (Web Serial) without the bridge.
