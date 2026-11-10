import * as fs from 'node:fs';
import * as path from 'node:path';

// dist/src/version.js sits two levels below the package root.
function readPackageVersion(): string {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

export const SERVER_NAME = 'cql-mcp';
export const SERVER_VERSION = readPackageVersion();
