// NexSpiro desktop shell. Serves the built app over a privileged app:// protocol
// (so module workers and fetch behave exactly as on the web), exposes native file dialogs,
// printer connections (devices.ts) and USB serial port selection.
import { app, BrowserWindow, dialog, ipcMain, protocol, net, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { disconnectAll, registerDeviceIpc } from './devices';
import { registerDiscoveryIpc } from './discover';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { updateFromFile } from './updates';

// Post-processing scripts (post_process): each command runs with the G-code file path as its last
// argument and may rewrite the file. Commands come from settings, which projects can carry, so each new set of
// commands is shown to the user once for approval before it runs.
const approvedScripts = new Set<string>();
function runScript(cmd: string, file: string, env: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(`${cmd} "${file.replace(/"/g, '\\"')}"`, { shell: true, env: { ...process.env, ...env } });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`"${cmd}" exited with code ${code}${err ? `: ${err.trim().slice(0, 400)}` : ''}`))));
  });
}

const ROOT = path.join(__dirname, '..', '..');
const DEV_URL = process.env.NEXSPIRO_DEV_URL;
const DIST = path.join(ROOT, 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let serialPick: ((portId: string) => void) | null = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#142030',
    title: 'Motionex',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // USB serial (Web Serial API): let the renderer choose the port
  const ses = win.webContents.session;
  ses.on('select-serial-port', (event, portList, _wc, callback) => {
    event.preventDefault();
    serialPick = callback;
    win.webContents.send('nx:serial:ports', portList.map((p) => ({ portId: p.portId, portName: p.portName, displayName: p.displayName, vendorId: p.vendorId, productId: p.productId })));
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
  ses.setDevicePermissionHandler((d) => d.deviceType === 'serial');

  win.loadURL(DEV_URL || 'app://nexspiro/index.html');
  // open external links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  ipcMain.handle('nx:saveFile', async (ev, { defaultName, data, filters }) => {
    const win = BrowserWindow.fromWebContents(ev.sender)!;
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, typeof data === 'string' ? data : Buffer.from(data));
    return r.filePath;
  });

  ipcMain.handle('nx:postProcess', async (ev, { gcode, scripts, env, outputName }: { gcode: string; scripts: string[]; env: Record<string, string>; outputName: string }) => {
    const key = scripts.join('\n');
    if (!approvedScripts.has(key)) {
      const win = BrowserWindow.fromWebContents(ev.sender)!;
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['Run scripts', 'Skip'], defaultId: 1, cancelId: 1,
        message: 'Run post-processing scripts on the exported G-code?',
        detail: `These commands from the process settings will run on this computer:\n\n${scripts.join('\n')}`,
      });
      if (r.response !== 0) return { gcode, skipped: true };
      approvedScripts.add(key);
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexspiro-pp-'));
    const file = path.join(dir, outputName.replace(/[\\/]/g, '_') || 'plate.gcode');
    try {
      await fs.writeFile(file, gcode);
      for (const cmd of scripts) await runScript(cmd, file, { ...env, SLIC3R_PP_OUTPUT_NAME: outputName });
      return { gcode: await fs.readFile(file, 'utf8') };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  ipcMain.handle('nx:openFiles', async (ev, { filters }) => {
    const win = BrowserWindow.fromWebContents(ev.sender)!;
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(async (p) => {
      const buf = await fs.readFile(p);
      return { name: path.basename(p), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }));
  });

  ipcMain.handle('nx:serial:pick', (_e, portId: string) => {
    serialPick?.(portId ?? '');
    serialPick = null;
  });

  registerDeviceIpc();
  registerDiscoveryIpc();

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  } else if (process.platform === 'win32') {
    // the bar is auto-hidden and shows with Alt
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'help', submenu: [{ label: 'Update from file…', click: () => void updateFromFile() }] }]));
  } else {
    Menu.setApplicationMenu(null);
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { void disconnectAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
