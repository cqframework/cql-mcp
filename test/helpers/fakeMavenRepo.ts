import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Minimal fake Maven repository for the network-integration layer (test/net).
 * Serves `<path>.jar` per route behaviour and records every request. Step 2 extends the
 * behaviour union (401-unless-basic-auth, wrong-sha1, sha1-*, head-405, short-body, ...).
 */
export type RepoBehavior =
  | { kind: 'ok' }
  | { kind: '404' }
  /** Sends headers advertising `totalBytes`, then `bytes` bytes, then keeps the connection open. */
  | { kind: 'stall-after'; bytes: number; totalBytes?: number };

export interface RecordedRequest {
  method: string;
  path: string;
  hasAuthorization: boolean;
}

export class FakeMavenRepo {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Array<{ match: (path: string) => boolean; behavior: RepoBehavior }> = [];
  private readonly sockets = new Set<Socket>();
  private readonly server: http.Server;

  private constructor(private readonly jar: Buffer) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  static async start(jar: Buffer = FakeMavenRepo.tinyJar()): Promise<FakeMavenRepo> {
    const repo = new FakeMavenRepo(jar);
    await new Promise<void>((resolve) => repo.server.listen(0, '127.0.0.1', resolve));
    return repo;
  }

  /** A tiny blob that passes the ZIP-magic check in isValidJar() (PK\x03\x04 + padding). */
  static tinyJar(): Buffer {
    return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  /** The first matching route wins; unmatched requests get 404. */
  route(match: string | RegExp | ((path: string) => boolean), behavior: RepoBehavior): this {
    const fn =
      typeof match === 'function'
        ? match
        : typeof match === 'string'
          ? (p: string) => p === match
          : (p: string) => match.test(p);
    this.routes.push({ match: fn, behavior });
    return this;
  }

  /** Requests for jar files only (excludes .sha1 and other sidecars). */
  get jarRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.endsWith('.jar'));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const reqPath = (req.url ?? '/').split('?')[0];
    this.requests.push({
      method: req.method ?? 'GET',
      path: reqPath,
      hasAuthorization: req.headers['authorization'] !== undefined,
    });
    const behavior = this.routes.find((r) => r.match(reqPath))?.behavior ?? { kind: '404' as const };
    switch (behavior.kind) {
      case 'ok':
        res.writeHead(200, { 'content-length': this.jar.length });
        res.end(req.method === 'HEAD' ? undefined : this.jar);
        return;
      case 'stall-after': {
        const total = behavior.totalBytes ?? 10 * 1024 * 1024;
        res.writeHead(200, { 'content-length': total });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.write(Buffer.concat([this.jar, Buffer.alloc(Math.max(0, behavior.bytes - this.jar.length))]).subarray(0, behavior.bytes));
        return; // never ends: the connection stays open until close()
      }
      default:
        res.writeHead(404);
        res.end();
    }
  }
}
