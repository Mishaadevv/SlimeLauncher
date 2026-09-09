import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { detectLanIp } from './skin-server.js';

// NAT traversal helpers for the Network "Internet mode":
//  - STUN (RFC 5389) to learn the host's public IP from a free STUN server.
//  - UPnP IGD (SSDP + SOAP AddPortMapping) to open a port on the home
//    router automatically, like game consoles do.
// No third-party servers are required — Google runs free STUN servers, and
// the router itself handles the port mapping.

const STUN_SERVERS = ['stun.l.google.com', 'stun1.l.google.com', 'stun2.l.google.com'];
const STUN_PORT = 19302;
const MAGIC_COOKIE = 0x2112a442;
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// Learns the public (WAN) IPv4 address via a STUN binding request.
// Returns null when the network blocks STUN (then we can't know the IP).
export function getPublicIp(timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = dgram.createSocket('udp4');
    const txid = Buffer.from([...Array(12)].map(() => Math.floor(Math.random() * 256)));
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0); // binding request
    req.writeUInt16BE(0, 2); // no attributes
    req.writeUInt32BE(MAGIC_COOKIE, 4);
    txid.copy(req, 8);

    const done = (result: string | null) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('message', (msg) => {
      try {
        if (msg.length < 20) return;
        if (msg.readUInt16BE(0) !== 0x0101) return; // success response
        if (msg.readUInt32BE(4) !== MAGIC_COOKIE) return;
        if (!msg.subarray(8, 20).equals(txid)) return;
        let off = 20;
        while (off + 4 <= msg.length) {
          const type = msg.readUInt16BE(off);
          const len = msg.readUInt16BE(off + 2);
          const val = off + 4;
          if (type === 0x0020 && len >= 8) { // XOR-MAPPED-ADDRESS
            const family = msg.readUInt8(val + 1);
            if (family === 0x01) {
              const port = msg.readUInt16BE(val + 2) ^ (MAGIC_COOKIE >> 16);
              const addr = [
                msg.readUInt8(val + 4) ^ msg.readUInt8(8),
                msg.readUInt8(val + 5) ^ msg.readUInt8(9),
                msg.readUInt8(val + 6) ^ msg.readUInt8(10),
                msg.readUInt8(val + 7) ^ msg.readUInt8(11),
              ].join('.');
              if (addr !== '0.0.0.0' && addr !== '255.255.255.255' && port > 0) {
                clearTimeout(timer);
                done(addr);
                return;
              }
            }
          }
          off = val + len;
          if (len % 4 !== 0) off += 4 - (len % 4);
        }
      } catch { /* ignore malformed */ }
    });
    socket.on('error', () => done(null));

    // Try each STUN server in order.
    const tryServer = (i: number) => {
      if (settled || i >= STUN_SERVERS.length) return;
      socket.send(req, STUN_PORT, STUN_SERVERS[i], (err) => {
        if (err && !settled) tryServer(i + 1);
        // No response within the global timeout — give up.
      });
    };
    tryServer(0);
  });
}

interface IgdInfo {
  controlUrl: string;
}

// Discovers the router's UPnP InternetGatewayDevice and returns its
// WANIPConnection control URL (or null when UPnP is unavailable).
export async function findIgd(timeoutMs = 3500): Promise<IgdInfo | null> {
  const locations = await new Promise<string[]>((resolve) => {
    const urls = new Set<string>();
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { socket.close(); } catch { /* ignore */ } resolve([...urls]); }, timeoutMs);
    socket.on('message', (msg) => {
      const text = msg.toString('latin1');
      const m = /^LOCATION:\s*(\S+)/im.exec(text);
      if (m) urls.add(m[1]);
    });
    socket.on('error', () => { clearTimeout(timer); resolve([...urls]); });
    socket.bind(0, () => {
      const search =
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n' +
        '\r\n';
      socket.send(Buffer.from(search, 'latin1'), SSDP_PORT, SSDP_ADDR);
    });
  });

  for (const loc of locations) {
    try {
      const desc = await getText(loc, 2500);
      const m = /<serviceType>urn:schemas-upnp-org:service:(WANIPConnection|WANPPPConnection):1<\/serviceType>[\s\S]*?<controlURL>(.*?)<\/controlURL>/.exec(desc);
      if (m) {
        let controlUrl = m[2].trim();
        if (!controlUrl.startsWith('http')) {
          const base = new URL(loc);
          controlUrl = `${base.protocol}//${base.host}${controlUrl.startsWith('/') ? '' : '/'}${controlUrl}`;
        }
        return { controlUrl };
      }
    } catch { /* try next device */ }
  }
  return null;
}

// Adds a TCP/UDP port mapping on the router (external port -> internal host).
export async function upnpAddPortMapping(
  igd: IgdInfo,
  externalPort: number,
  internalPort: number,
  protocol: 'TCP' | 'UDP',
): Promise<boolean> {
  const internalIp = detectLanIp();
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
<NewRemoteHost></NewRemoteHost>
<NewExternalPort>${externalPort}</NewExternalPort>
<NewProtocol>${protocol}</NewProtocol>
<NewInternalPort>${internalPort}</NewInternalPort>
<NewInternalClient>${internalIp}</NewInternalClient>
<NewEnabled>1</NewEnabled>
<NewPortMappingDescription>SlimeLauncher</NewPortMappingDescription>
<NewLeaseDuration>0</NewLeaseDuration>
</u:AddPortMapping>
</s:Body>
</s:Envelope>`;
  return soapAction(igd, body, 'AddPortMapping').then((ok) => ok, () => false);
}

// Removes a previously added mapping.
export async function upnpDeletePortMapping(
  igd: IgdInfo,
  externalPort: number,
  protocol: 'TCP' | 'UDP',
): Promise<void> {
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:DeletePortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
<NewRemoteHost></NewRemoteHost>
<NewExternalPort>${externalPort}</NewExternalPort>
<NewProtocol>${protocol}</NewProtocol>
</u:DeletePortMapping>
</s:Body>
</s:Envelope>`;
  await soapAction(igd, body, 'DeletePortMapping').catch(() => { /* best effort */ });
}

function soapAction(igd: IgdInfo, body: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(igd.controlUrl);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"urn:schemas-upnp-org:service:WANIPConnection:1#${action}"`,
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.setTimeout(2500, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

function getText(urlStr: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(
      { host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, headers: { Connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString('latin1')));
        res.on('end', () => resolve(data));
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}