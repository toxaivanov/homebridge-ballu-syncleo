import { Bonjour } from 'bonjour-service';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { EventEmitter } from 'node:events';

export function parseShareLink(value: string) {
  try {
    const url = new URL(value.trim());
    const match = /^\/rusclimate\/69\/([0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2})\/?$/i.exec(url.pathname);
    const token = url.searchParams.get('token') ?? '';
    if (url.protocol === 'rusklimat:' && url.hostname === 'device-share' && match && /^[0-9a-f]{32}$/i.test(token) && !/^0+$/.test(token)) {
      return { mac: match[1].replace(/:/g, '').toLowerCase(), token: Buffer.from(token, 'hex') };
    }
  } catch {
    // Report a generic validation error without including the URL.
  }
  throw new Error('Invalid HOMMYN share link for Ballu ASP-100');
}

function frame(seq: number, type: number, data: Buffer) {
  const header = Buffer.alloc(4);
  header[0] = seq;
  header[1] = type;
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function rotate(bytes: Buffer, offset: number) {
  return Buffer.concat([bytes.subarray(offset), bytes.subarray(0, offset)]);
}

export class Syncleo extends EventEmitter {
  private bonjour?: Bonjour;
  private browser?: ReturnType<Bonjour['find']>;
  private endpoint?: { address: string; port: number; key: string };
  private stopped = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly credentials;

  constructor(link: string) {
    super();
    this.credentials = parseShareLink(link);
  }

  start() {
    this.bonjour = new Bonjour({}, () => this.emit('networkError'));
    this.browser = this.bonjour.find({ type: 'syncleo', protocol: 'udp' }, device => {
      const txt = device.txt ?? {};
      const address = device.addresses?.find(isIPv4) ?? device.referer?.address;
      if (String(txt.macaddr).replace(/:/g, '').toLowerCase() !== this.credentials.mac ||
          String(txt.devtype) !== '69' || String(txt.protocol) !== '2' ||
          String(txt.curve) !== '29' || !/^[0-9a-f]{64}$/i.test(String(txt.public)) ||
          !address || !isIPv4(address)) return;
      this.endpoint = { address, port: device.port, key: String(txt.public) };
      this.emit('discovered');
    });
  }

  stop() {
    this.stopped = true;
    this.browser?.stop();
    this.bonjour?.destroy();
  }

  exchange(commands: ReadonlyArray<readonly [number, number]> = []) {
    const operation = this.tail.then(() => this.session(commands));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async session(commands: ReadonlyArray<readonly [number, number]>) {
    const endpoint = this.endpoint;
    if (this.stopped || !endpoint) throw new Error('ASP-100 has not been discovered');
    const pair = generateKeyPairSync('x25519');
    const key = createPublicKey({
      format: 'der', type: 'spki',
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(endpoint.key, 'hex').reverse()]),
    });
    const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: key });
    const digest = createHash('sha256').update(shared.reverse()).digest();
    const incoming = digest.subarray(0, 16);
    const outgoing = digest.subarray(16);
    const cipher = createCipheriv('aes-128-cbc', outgoing, incoming).setAutoPadding(false);
    const publicKey = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).reverse();
    const handshake = frame(0, 1, Buffer.concat([Buffer.from([0]), publicKey, cipher.update(this.credentials.token), cipher.final()]));
    const socket = createSocket('udp4');
    let sequence = 1;
    let authenticated = false;
    let firmware: string | undefined;
    let socketError: Error | undefined;
    let onUpdate: (() => void) | undefined;
    const fields = new Map<number, Buffer>();

    const send = (packet: Buffer) => socket.send(packet, error => {
      if (error) {
        socketError = error;
        onUpdate?.();
      }
    });
    const encryptedSend = (seq: number, type: number, body: number[]) => {
      const cipher = createCipheriv('aes-128-cbc', rotate(outgoing, seq & 15), rotate(incoming, seq >> 4));
      send(frame(seq, type, Buffer.concat([cipher.update(Buffer.from([seq, ...body])), cipher.final()])));
    };

    socket.on('error', error => {
      socketError = error;
      onUpdate?.();
    });
    socket.on('message', packet => {
      if (packet.length < 4 || packet[1] !== 1 || packet.readUInt16LE(2) !== packet.length - 4) return;
      const seq = packet[0];
      let data: Buffer;
      try {
        const decipher = createDecipheriv('aes-128-cbc', rotate(incoming, seq & 15), rotate(outgoing, seq >> 4));
        data = Buffer.concat([decipher.update(packet.subarray(4)), decipher.final()]);
      } catch {
        return;
      }
      if (data.length < 2 || data[0] !== seq) return;
      encryptedSend(seq, 0, []);
      if (data[1] === 0 && data.length >= 23) {
        firmware = `${data[4]}.${data[5]}`;
        authenticated = data.subarray(7, 23).some(byte => byte !== 0);
        if (!authenticated) socketError = new Error('ASP-100 rejected the HOMMYN token');
      } else if (authenticated) {
        fields.set(data[1], data.subarray(2));
      }
      onUpdate?.();
    });

    const waitFor = (ready: () => boolean, timeout: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('ASP-100 did not confirm state')), timeout);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        onUpdate = undefined;
        if (error) reject(error);
        else resolve();
      };
      onUpdate = () => {
        if (socketError) finish(socketError);
        else if (ready()) finish();
      };
      onUpdate();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.connect(endpoint.port, endpoint.address, () => {
          socket.removeListener('error', reject);
          resolve();
        });
      });
      send(handshake);
      await waitFor(() => authenticated && fields.has(1) && fields.has(15), 3000);
      if (!commands.length && !fields.has(0x16)) {
        await new Promise<void>(resolve => setTimeout(resolve, 300));
      }
      for (const [command, value] of commands) {
        if (fields.get(command)?.[0] === value) continue;
        fields.delete(command);
        encryptedSend(sequence++, 1, [command, value]);
        await waitFor(() => fields.get(command)?.[0] === value, 2500);
      }
      const co2Field = fields.get(0x16);
      const co2 = co2Field?.length === 2 ? co2Field.readUInt16LE() : undefined;
      return {
        mode: fields.get(1)![0], speed: fields.get(15)![0], firmware,
        co2: co2 && co2 < 0xffff ? co2 : undefined,
      };
    } catch (error) {
      this.browser?.update();
      throw error;
    } finally {
      try { socket.close(); } catch { /* Socket did not bind. */ }
    }
  }
}
