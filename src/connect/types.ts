// Printer connection layer. One interface for every printer family so the Device
// workspace never needs to know which protocol is underneath.
//
//   bbl_lan  — MQTT over TLS on :8883 (user "bblp", LAN access code) for status & commands,
//                implicit FTPS on :990 to upload files, JPEG stream on :6000 (A1/P1) for the camera.
//                Needs raw sockets → desktop app only (runs in the Electron main process).
//   moonraker  — Klipper's HTTP API on :7125 (Creality K/KE series, Elegoo Neptune 4, Voron…).
//   octoprint  — OctoPrint REST API with an API key.
//   serial     — USB serial (Marlin), streaming G-code line by line with ok-acknowledgement (Web Serial).

export type ConnectionKind = 'bbl_lan' | 'moonraker' | 'octoprint' | 'serial';

/** rfid: the printer identified the spool itself (RFID tag); otherwise type/colour are what someone set on the printer. */
export interface AmsTray { id: string; type: string; color: string; remain?: number; active?: boolean; rfid?: boolean }
export interface AmsUnit { id: string; humidity?: number; temp?: number; trays: AmsTray[] }
export interface HmsEntry { code: string; message: string; severity: 'info' | 'warning' | 'error' }

export interface PrinterStatus {
  state: 'offline' | 'connecting' | 'idle' | 'printing' | 'paused' | 'finished' | 'error';
  progress?: number; // 0..1
  layer?: number;
  totalLayers?: number;
  remainingSeconds?: number;
  fileName?: string;
  nozzleTemp?: number; nozzleTarget?: number;
  /** Tool changers / IDEX: every head's temperature (T0, T1, …) and the head in use. */
  heads?: { temp?: number; target?: number }[];
  activeHead?: number;
  bedTemp?: number; bedTarget?: number;
  chamberTemp?: number;
  fanPercent?: number;
  speedPercent?: number;
  light?: boolean;
  ams?: AmsUnit[];
  hms?: HmsEntry[];
  message?: string;
  firmware?: string;
}

export interface RemoteFile { name: string; size?: number; modified?: number }

export interface PrintOptions {
  /** A1/P1/X1/H2: plate inside the .gcode.3mf. */
  plate?: number;
  bedLevelling?: boolean;
  flowCalibration?: boolean;
  timelapse?: boolean;
  useAms?: boolean;
  /** A1/P1/X1/H2: AMS tray for each filament slot of the project (-1 = external spool). */
  amsMapping?: number[];
}

export interface PrinterConnection {
  readonly kind: ConnectionKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): PrinterStatus;
  onStatus(cb: (s: PrinterStatus) => void): () => void;
  upload(fileName: string, data: ArrayBuffer, onProgress?: (f: number) => void): Promise<void>;
  startPrint(fileName: string, opts?: PrintOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  sendGcode(line: string): Promise<void>;
  listFiles(): Promise<RemoteFile[]>;
  deleteFile(name: string): Promise<void>;
  setLight?(on: boolean): Promise<void>;
  /** Camera: either a URL the renderer can show, or JPEG frames pushed via onFrame. */
  cameraUrl?(): Promise<string | null>;
  onFrame?(cb: (jpeg: Uint8Array) => void): () => void;
}

export interface ConnectionConfig {
  kind: ConnectionKind;
  host?: string; // IP / hostname
  port?: number;
  serial?: string; // printer serial number (LAN access-code printers)
  accessCode?: string; // LAN access code
  apiKey?: string; // OctoPrint / Moonraker (optional)
  baudRate?: number;
  /** Stable network identity (Klipper host name) used to find the printer again when its IP changes. */
  hostname?: string;
}

/** A printer saved in the Device workspace. */
export interface SavedDevice {
  id: string;
  name: string;
  printerId: string; // profile id (src/profiles/printers.ts)
  config: ConnectionConfig;
}

export const CONNECTION_INFO: Record<ConnectionKind, { label: string; description: string; desktopOnly?: boolean }> = {
  bbl_lan: { label: 'LAN (access code)', description: 'Direct LAN control of A1, P1, X1 and H2 series using the printer access code (MQTT + FTPS + camera). Turn on LAN mode or note the access code under Settings → Network on the printer.', desktopOnly: true },
  moonraker: { label: 'Klipper / Moonraker', description: 'Creality Ender-3 V3 KE, K1/K2, Elegoo Neptune 4 series and any Klipper printer with Moonraker (port 7125).' },
  octoprint: { label: 'OctoPrint', description: 'Any printer managed by OctoPrint, using an API key (Settings → Application Keys).' },
  serial: { label: 'USB (serial)', description: 'Marlin printers connected by USB cable — NexSpiro streams the G-code itself, so keep this computer awake while printing.' },
};

/** Small listener helper shared by every connection implementation. */
export class Emitter<T> {
  private ls = new Set<(v: T) => void>();
  on(cb: (v: T) => void) { this.ls.add(cb); return () => { this.ls.delete(cb); }; }
  emit(v: T) { for (const l of this.ls) { try { l(v); } catch { /* listener errors never break a connection */ } } }
}
