import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import { ContentLengthReader, writeFramed } from '../../../src/dap/framing.js';

// Test only the reader side: feed it a Duplex-shaped PassThrough that we
// also control as a write source. No peer-piping (Node 25 hangs on a
// self-pipe loop).
function makeReadableStream(): PassThrough {
  return new PassThrough();
}

describe('dap/framing', () => {
  it('reads a single framed message', () => {
    const stream = makeReadableStream();
    const reader = new ContentLengthReader(stream);
    const received: string[] = [];
    reader.onMessage((json) => received.push(json));

    writeFramed(stream, JSON.stringify({ seq: 1, type: 'event', event: 'stopped' }));

    expect(received).to.have.length(1);
    expect(JSON.parse(received[0])).to.deep.equal({ seq: 1, type: 'event', event: 'stopped' });
    reader.dispose();
  });

  it('buffers partial frames and assembles them when the body arrives', () => {
    const stream = makeReadableStream();
    const reader = new ContentLengthReader(stream);
    const received: string[] = [];
    reader.onMessage((json) => received.push(json));

    const body = JSON.stringify({ seq: 7, type: 'response', success: true, body: { ok: true } });
    const full = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    const splitAt = 17;
    stream.write(full.slice(0, splitAt));
    expect(received).to.have.length(0);
    stream.write(full.slice(splitAt));

    expect(received).to.have.length(1);
    expect(JSON.parse(received[0]).seq).to.equal(7);
    reader.dispose();
  });

  it('accepts LF-only header terminator', () => {
    const stream = makeReadableStream();
    const reader = new ContentLengthReader(stream);
    const received: string[] = [];
    reader.onMessage((json) => received.push(json));

    const body = JSON.stringify({ seq: 2, type: 'event', event: 'continued' });
    stream.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\n\n${body}`);

    expect(received).to.have.length(1);
    expect(JSON.parse(received[0]).event).to.equal('continued');
    reader.dispose();
  });

  it('skips a malformed header prefix and continues scanning', () => {
    const stream = makeReadableStream();
    const reader = new ContentLengthReader(stream);
    const received: string[] = [];
    reader.onMessage((json) => received.push(json));

    const body = JSON.stringify({ seq: 3, type: 'event', event: 'output' });
    const garbage = 'X-No-Length-Here\r\n\r\n';
    const real = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    stream.write(garbage + real);

    expect(received).to.have.length(1);
    expect(JSON.parse(received[0]).event).to.equal('output');
    reader.dispose();
  });

  it('fires onEnd when the stream ends', (done) => {
    const stream = makeReadableStream();
    const reader = new ContentLengthReader(stream);
    reader.onEnd(() => {
      reader.dispose();
      done();
    });
    stream.end();
  });

  it('dispose() removes data listeners so no further frames are processed', () => {
    const stream = makeReadableStream();
    const reader = new ContentLengthReader(stream);
    const received: string[] = [];
    reader.onMessage((json) => received.push(json));

    reader.dispose();

    const body = JSON.stringify({ seq: 99, type: 'event', event: 'stopped' });
    writeFramed(stream, body);

    expect(received).to.have.length(0);
    expect(stream.listenerCount('data')).to.equal(0);
    expect(stream.listenerCount('end')).to.equal(0);
    expect(stream.listenerCount('close')).to.equal(0);
  });
});