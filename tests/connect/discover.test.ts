import { describe, it, expect, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }));
import { parseBambuSsdp } from '../../electron/src/discover';

describe('Bambu SSDP discovery', () => {
  it('parses a NOTIFY packet', () => {
    const pkt = 'NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nLocation: 192.168.1.42\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nUSN: 03919A123456789\r\nDevModel.bambu.com: N2S\r\nDevName.bambu.com: Workshop A1\r\n\r\n';
    expect(parseBambuSsdp(pkt, '192.168.1.42')).toEqual({ kind: 'bbl_lan', host: '192.168.1.42', serial: '03919A123456789', name: 'Workshop A1', model: 'N2S' });
  });
  it('ignores other SSDP traffic', () => {
    expect(parseBambuSsdp('NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\n', '1.2.3.4')).toBeNull();
  });
});
