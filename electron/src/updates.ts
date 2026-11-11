// App updates without any server: Help → "Update from file…" takes the NexSpiro Windows .zip (or the Setup .exe
// inside it), checks its version and signature, then asks to restart. The installer runs silently (elevated, since
// the app is installed for all users) when NexSpiro closes, and relaunches it when the user chose "Restart now".
import { app, BrowserWindow, dialog } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

function parentWin() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function box(opts: Electron.MessageBoxOptions) {
  const win = parentWin();
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

// "1.2.10" > "1.2.9"; pre-release suffixes are ignored
function cmpVersion(a: string, b: string) {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

type InstallerInfo = { version: string; signer: string | null; status: string };

// ProductVersion and Authenticode signer of an .exe, via PowerShell (available on every supported Windows)
function inspectExe(file: string) {
  const script = `$ErrorActionPreference='Stop';$f=$env:NX_FILE;$s=Get-AuthenticodeSignature -LiteralPath $f;`
    + `@{version=(Get-Item -LiteralPath $f).VersionInfo.ProductVersion;status=[string]$s.Status;`
    + `signer=$(if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null})}|ConvertTo-Json -Compress`;
  return new Promise<InstallerInfo>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, NX_FILE: file }, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const j = JSON.parse(stdout.trim());
          resolve({ version: String(j.version ?? '').trim(), signer: j.signer ?? null, status: String(j.status ?? '') });
        } catch (e) { reject(e); }
      });
  });
}

// the Setup .exe inside a release .zip, extracted to a temp folder
async function extractSetup(zipFile: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(zipFile));
  const entries = Object.values(zip.files).filter((f) => !f.dir && /\.exe$/i.test(f.name));
  const entry = entries.find((f) => /setup/i.test(path.basename(f.name))) ?? entries[0];
  if (!entry) throw new Error('The .zip does not contain a NexSpiro Setup .exe.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexspiro-update-'));
  const out = path.join(dir, path.basename(entry.name));
  await fs.writeFile(out, await entry.async('nodebuffer'));
  return out;
}

let pending: string | null = null;

// Start-Process -Verb RunAs shows the UAC prompt; if it is declined the app is started again so it never just vanishes
function runInstaller(setup: string, relaunch: boolean) {
  const script = `try{Start-Process -FilePath $env:NX_SETUP -ArgumentList $env:NX_ARGS -Verb RunAs -ErrorAction Stop}`
    + `catch{if($env:NX_APP){Start-Process -FilePath $env:NX_APP}}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, NX_SETUP: setup, NX_ARGS: relaunch ? '--updated /S --force-run' : '--updated /S', NX_APP: relaunch ? process.execPath : '' },
  });
  child.unref();
}

export async function updateFromFile() {
  if (process.platform !== 'win32') {
    void box({ type: 'info', message: 'Update from file is available on Windows only.', detail: 'Open the new installer directly on this system.' });
    return;
  }
  const win = parentWin();
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose a Motionex update', properties: ['openFile'],
    filters: [{ name: 'Motionex update (.zip, .exe)', extensions: ['zip', 'exe'] }],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return;

  let setup: string;
  let info: InstallerInfo;
  let own: InstallerInfo | null = null;
  try {
    setup = /\.zip$/i.test(r.filePaths[0]) ? await extractSetup(r.filePaths[0]) : r.filePaths[0];
    info = await inspectExe(setup);
    if (app.isPackaged) own = await inspectExe(process.execPath);
  } catch (e) {
    void box({ type: 'error', message: 'Could not read the update file.', detail: String((e as Error)?.message ?? e) });
    return;
  }

  if (!/nexspiro/i.test(path.basename(setup))) {
    void box({ type: 'error', message: 'This is not a Motionex update.', detail: r.filePaths[0] });
    return;
  }

  // the installer must be signed by the same publisher as the running app (when the app itself is signed)
  const ownSigned = own?.status === 'Valid' && own.signer;
  if (ownSigned && (info.status !== 'Valid' || info.signer !== own!.signer)) {
    void box({
      type: 'error', message: 'The update signature does not match NexSpiro.',
      detail: `Expected: ${own!.signer}\nFound: ${info.signer ?? 'not signed'} (${info.status})\n\nThe file may be damaged or not genuine.`,
    });
    return;
  }

  const current = app.getVersion();
  const cmp = info.version ? cmpVersion(info.version, current) : 1;
  if (cmp <= 0) {
    const res = await box({
      type: 'warning', buttons: [cmp === 0 ? 'Reinstall' : 'Install older version', 'Cancel'], defaultId: 1, cancelId: 1,
      message: cmp === 0 ? 'This version is already installed.' : 'This update is older than the installed version.',
      detail: `Installed: ${current}\nUpdate: ${info.version}`,
    });
    if (res.response !== 0) return;
  }

  const first = !pending;
  pending = setup;
  if (first) app.once('will-quit', () => { if (pending) runInstaller(pending, false); });

  const res = await box({
    type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
    message: `NexSpiro ${info.version || ''} is ready to install.`.replace('  ', ' '),
    detail: `Installed: ${current}\n\nRestart NexSpiro to finish the update. If you choose Later, it is installed the next time you close NexSpiro.`
      + (ownSigned ? '' : '\n\nNote: this build is not code-signed, so the update file could not be verified.')
      + '\n\nWindows will ask for administrator permission.',
  });
  if (res.response === 0) {
    runInstaller(setup, true);
    pending = null;
    app.quit();
  }
}
