import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SERVER_NAME, SERVER_VERSION } from '../../src/version.js';

describe('version', () => {
  it('SERVER_VERSION equals package.json version', () => {
    // dist/test/unit/version.test.js -> package root is three levels up
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    expect(SERVER_VERSION).to.equal(pkg.version);
    expect(SERVER_NAME).to.equal('cql-mcp');
  });
});
