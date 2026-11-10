import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Fake Maven repository for the network-integration layer (test/net). Serves `<path>.jar` and
 * `<path>.jar.sha1` according to a per-route behaviour and records every request. A route is
 * matched against the jar path (a `.sha1` request uses the route of its jar).
 */
export type RepoBehavior =
  | { kind: 'ok' }
  | { kind: '404' }
  /** The jar is fine, but its .sha1 holds a different digest. */
  | { kind: 'wrong-sha1' }
  /** The .sha1 body is `<digest>  <filename>\n`, as some repositories write it. */
  | { kind: 'sha1-with-filename-suffix' }
  | { kind: 'sha1-404' }
  | { kind: 'sha1-500' }
  /** HEAD is rejected with 405; GET works. */
  | { kind: 'head-405' }
  /** Sends headers advertising `totalBytes`, then `bytes` bytes, then keeps the connection open. */
  | { kind: 'stall-after'; bytes: number; totalBytes?: number }
  /** Advertises more bytes than it sends, then drops the connection. */
  | { kind: 'short-body' }
  /** 401 unless `Authorization: Basic user:pass` is sent; then behaves as `then` (default ok). */
  | { kind: '401-unless-basic-auth'; user: string; pass: string; then?: RepoBehavior };

export interface RecordedRequest {
  method: string;
  path: string;
  hasAuthorization: boolean;
  status: number;
}

export interface FakeMavenRepoOptions {
  jar?: Buffer;
  tls?: { key: Buffer; cert: Buffer };
}

export class FakeMavenRepo {
  readonly requests: RecordedRequest[] = [];
  readonly jar: Buffer;
  private readonly routes: Array<{ match: (path: string) => boolean; behavior: RepoBehavior }> = [];
  private readonly sockets = new Set<Socket>();
  private readonly server: http.Server | https.Server;
  private readonly scheme: 'http' | 'https';

  private constructor(options: FakeMavenRepoOptions) {
    this.jar = options.jar ?? FakeMavenRepo.tinyJar();
    this.scheme = options.tls ? 'https' : 'http';
    const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => this.handle(req, res);
    this.server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
    this.server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  static async start(options: FakeMavenRepoOptions = {}): Promise<FakeMavenRepo> {
    const repo = new FakeMavenRepo(options);
    await new Promise<void>((resolve) => repo.server.listen(0, '127.0.0.1', resolve));
    return repo;
  }

  /** A tiny blob that passes the ZIP-magic check in isValidJar() (PK\x03\x04 + padding). */
  static tinyJar(): Buffer {
    return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
  }

  get url(): string {
    return `${this.scheme}://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  get host(): string {
    return `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
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

  /** Serve every jar under this repo with `behavior`. */
  all(behavior: RepoBehavior): this {
    return this.route(/\.jar$/, behavior);
  }

  /** Requests for jar files only (excludes .sha1 sidecars). */
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
    const method = req.method ?? 'GET';
    const reqPath = (req.url ?? '/').split('?')[0];
    const isSha = reqPath.endsWith('.sha1');
    const jarPath = isSha ? reqPath.slice(0, -'.sha1'.length) : reqPath;
    const record = (status: number): void => {
      this.requests.push({ method, path: reqPath, hasAuthorization: req.headers['authorization'] !== undefined, status });
    };
    const send = (status: number, body?: Buffer | string, headers: http.OutgoingHttpHeaders = {}): void => {
      record(status);
      res.writeHead(status, headers);
      res.end(method === 'HEAD' ? undefined : body);
    };

    let behavior: RepoBehavior = this.routes.find((r) => r.match(jarPath))?.behavior ?? { kind: '404' };
    if (behavior.kind === '401-unless-basic-auth') {
      const expected = 'Basic ' + Buffer.from(`${behavior.user}:${behavior.pass}`).toString('base64');
      if (req.headers['authorization'] !== expected) {
        send(401, 'unauthorized', { 'www-authenticate': 'Basic realm="fake-repo"' });
        return;
      }
      behavior = behavior.then ?? { kind: 'ok' };
    }

    const digest = createHash('sha1').update(this.jar).digest('hex');
    if (isSha) {
      switch (behavior.kind) {
        case '404':
        case 'sha1-404':
          return send(404);
        case 'sha1-500':
          return send(500, 'boom');
        case 'wrong-sha1':
          return send(200, 'f'.repeat(40));
        case 'sha1-with-filename-suffix':
          return send(200, `${digest}  ${jarPath.split('/').pop()}\n`);
        default:
          return send(200, digest);
      }
    }

    switch (behavior.kind) {
      case '404':
        return send(404);
      case 'head-405':
        if (method === 'HEAD') return send(405);
        return send(200, this.jar, { 'content-length': this.jar.length });
      case 'stall-after': {
        record(200);
        res.writeHead(200, { 'content-length': behavior.totalBytes ?? 10 * 1024 * 1024 });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        const chunk = Buffer.concat([this.jar, Buffer.alloc(Math.max(0, behavior.bytes - this.jar.length))]).subarray(0, behavior.bytes);
        res.write(chunk);
        return; // never ends: the connection stays open until close()
      }
      case 'short-body': {
        record(200);
        res.writeHead(200, { 'content-length': this.jar.length + 100 });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        res.write(this.jar, () => res.socket?.destroy());
        return;
      }
      default:
        return send(200, this.jar, { 'content-length': this.jar.length });
    }
  }
}
