import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

export interface ProxyRequest {
  kind: 'connect' | 'http';
  /** host:port the client asked the proxy to reach */
  target: string;
  hasProxyAuthorization: boolean;
  status: number;
}

export interface FakeProxyOptions {
  /** Require `Proxy-Authorization: Basic …` with these credentials; answer 407 otherwise. */
  requireAuth?: { user: string; pass: string };
}

/** A forward proxy handling plain HTTP (absolute-URI) proxying and CONNECT tunnelling. */
export class FakeProxy {
  readonly requests: ProxyRequest[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly server: http.Server;

  private constructor(private readonly options: FakeProxyOptions) {
    this.server = http.createServer((req, res) => this.forward(req, res));
    this.server.on('connect', (req, clientSocket, head) => this.tunnel(req, clientSocket as Socket, head));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  static async start(options: FakeProxyOptions = {}): Promise<FakeProxy> {
    const proxy = new FakeProxy(options);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    return proxy;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** `http://[user:pass@]127.0.0.1:<port>` for HTTP_PROXY / HTTPS_PROXY. */
  url(credentials?: { user: string; pass: string }): string {
    const userinfo = credentials ? `${credentials.user}:${credentials.pass}@` : '';
    return `http://${userinfo}127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private authorized(header: string | string[] | undefined): boolean {
    const required = this.options.requireAuth;
    if (!required) return true;
    return header === 'Basic ' + Buffer.from(`${required.user}:${required.pass}`).toString('base64');
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const record = (status: number): void => {
      this.requests.push({
        kind: 'http',
        target: target.host,
        hasProxyAuthorization: req.headers['proxy-authorization'] !== undefined,
        status,
      });
    };
    if (!this.authorized(req.headers['proxy-authorization'])) {
      record(407);
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fake-proxy"' }).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const upstream = http.request(
      { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers },
      (up) => {
        record(up.statusCode ?? 502);
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      record(502);
      res.writeHead(502).end();
    });
    req.pipe(upstream);
  }

  private tunnel(req: http.IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const target = req.url ?? '';
    const record = (status: number): void => {
      this.requests.push({
        kind: 'connect',
        target,
        hasProxyAuthorization: req.headers['proxy-authorization'] !== undefined,
        status,
      });
    };
    if (!this.authorized(req.headers['proxy-authorization'])) {
      record(407);
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fake-proxy"\r\n\r\n');
      return;
    }
    const [host, port] = target.split(':');
    const upstream = net.connect(Number(port), host, () => {
      record(200);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => {
      record(502);
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    clientSocket.on('error', () => upstream.destroy());
    this.sockets.add(upstream);
    upstream.on('close', () => this.sockets.delete(upstream));
  }
}
