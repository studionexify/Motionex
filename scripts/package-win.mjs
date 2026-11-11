// Wraps release/NexSpiro-Setup-<version>.exe into release/NexSpiro-<version>-Windows.zip with install notes.
// The same .zip installs NexSpiro (unzip, run Setup as administrator) and updates it (Help → Update from file…).
import fs from 'node:fs/promises';
import JSZip from 'jszip';

const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const setup = `NexSpiro-Setup-${version}.exe`;
const out = `release/NexSpiro-${version}-Windows.zip`;

const notes = `NexSpiro ${version} for Windows

INSTALL
  1. Extract this .zip.
  2. Right-click ${setup} and choose "Run as administrator".
  3. Follow the installer. NexSpiro is added to the Start menu and the desktop.

UPDATE (no internet needed)
  1. Open NexSpiro, press Alt, then Help > Update from file...
  2. Select this .zip (or the ${setup} inside it).
  3. Choose "Restart now" and allow the administrator prompt.
  Settings, printers and profiles are kept.

UNINSTALL
  Windows Settings > Apps > NexSpiro > Uninstall.
`;

const zip = new JSZip();
zip.file(setup, await fs.readFile(`release/${setup}`));
zip.file('README.txt', notes.replace(/\n/g, '\r\n'));
await fs.writeFile(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
console.log(`${out} built`);
