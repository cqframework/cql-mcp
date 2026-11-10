import { expect } from 'chai';
import { peekEnv, readEnv, resetEnvWarnings } from '../../../src/workspace/env.js';

describe('workspace/env', () => {
  let stderrLines: string[];
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    resetEnvWarnings();
    stderrLines = [];
    origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = origWrite;
  });

  it('prefers the new name over the legacy one, without warning', () => {
    expect(readEnv('NEW', 'OLD', { NEW: 'n', OLD: 'o' })).to.equal('n');
    expect(stderrLines).to.have.length(0);
  });

  it('falls back to the legacy name', () => {
    expect(readEnv('NEW', 'OLD', { OLD: 'o' })).to.equal('o');
  });

  it('warns exactly once per legacy name per process', () => {
    readEnv('NEW', 'OLD', { OLD: 'o' });
    readEnv('NEW', 'OLD', { OLD: 'o' });
    expect(stderrLines).to.have.length(1);
    expect(stderrLines[0]).to.include('OLD').and.to.include('NEW');
    readEnv('NEW2', 'OLD2', { OLD2: 'o' });
    expect(stderrLines).to.have.length(2);
  });

  it('returns undefined when neither is set', () => {
    expect(readEnv('NEW', 'OLD', {})).to.equal(undefined);
    expect(readEnv('NEW', undefined, {})).to.equal(undefined);
  });

  it('peekEnv falls back silently', () => {
    expect(peekEnv('NEW', 'OLD', { OLD: 'o' })).to.equal('o');
    expect(stderrLines).to.have.length(0);
  });
});
