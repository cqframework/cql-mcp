import type { Duplex } from 'node:stream';

/**
 * Minimal DAP/LS framing layer. DAP uses Content-Length headers (same family
 * as LSP) but its own message shape, so we don't reuse vscode-jsonrpc's
 * StreamMessageReader (whose 'message' event yields JSON-RPC parsed objects).
 */
export class ContentLengthReader {
  private buffer: Buffer = Buffer.alloc(0);
  private messageHandlers: Array<(json: string) => void> = [];
  private endHandlers: Array<() => void> = [];

  // Stable arrow-function references so dispose() can unregister the exact
  // listeners it registered in the constructor. Previously these were inline
  // closures, which made .off() a no-op and leaked sockets.
  private readonly handleData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.tryConsume()) {
      /* keep draining */
    }
  };

  private readonly handleEnd = (): void => {
    for (const h of this.endHandlers) h();
  };

  private readonly handleClose = (): void => {
    for (const h of this.endHandlers) h();
  };

  constructor(private readonly socket: Duplex) {
    socket.on('data', this.handleData);
    socket.on('end', this.handleEnd);
    socket.on('close', this.handleClose);
  }

  onMessage(handler: (json: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onEnd(handler: () => void): void {
    this.endHandlers.push(handler);
  }

  private tryConsume(): boolean {
    let headerEnd = -1;
    let terminatorLen = 0;
    const crlfIdx = this.buffer.indexOf('\r\n\r\n');
    const lfIdx = this.buffer.indexOf('\n\n');
    if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
      headerEnd = crlfIdx;
      terminatorLen = 4;
    } else if (lfIdx !== -1) {
      headerEnd = lfIdx;
      terminatorLen = 2;
    } else {
      return false;
    }

    const header = this.buffer.slice(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      this.buffer = this.buffer.slice(headerEnd + terminatorLen);
      return true;
    }
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + terminatorLen;
    if (this.buffer.length < bodyStart + len) {
      return false;
    }
    const body = this.buffer.slice(bodyStart, bodyStart + len).toString('utf8');
    this.buffer = this.buffer.slice(bodyStart + len);
    for (const h of this.messageHandlers) {
      h(body);
    }
    return true;
  }

  dispose(): void {
    this.messageHandlers = [];
    this.endHandlers = [];
    this.socket.off('data', this.handleData);
    this.socket.off('end', this.handleEnd);
    this.socket.off('close', this.handleClose);
  }
}

export function writeFramed(socket: Duplex, json: string): boolean {
  const data = Buffer.from(json, 'utf8');
  const header = Buffer.from(`Content-Length: ${data.byteLength}\r\n\r\n`, 'utf8');
  return socket.write(Buffer.concat([header, data]));
}
