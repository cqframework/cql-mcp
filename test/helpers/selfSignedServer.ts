import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * TLS material for an HTTPS fake repository that stands in for a corporate server with a private
 * CA. The files are checked-in, test-only fixtures (see test/fixtures/net/tls/README.md): Node's
 * crypto module cannot mint certificates, and the CA key is intentionally discarded.
 */
export interface TlsFixture {
  /** Path to the CA certificate, for NODE_EXTRA_CA_CERTS. */
  caPemPath: string;
  key: Buffer;
  cert: Buffer;
}

export function tlsFixture(): TlsFixture {
  const dir = path.resolve(process.cwd(), 'test', 'fixtures', 'net', 'tls');
  return {
    caPemPath: path.join(dir, 'ca.pem'),
    key: fs.readFileSync(path.join(dir, 'server.key')),
    cert: fs.readFileSync(path.join(dir, 'server.pem')),
  };
}
