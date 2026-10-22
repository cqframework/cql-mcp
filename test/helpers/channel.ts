import { PassThrough } from 'node:stream';
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';

export interface ChannelSide {
  read: PassThrough;
  write: PassThrough;
}

export interface TestChannel {
  client: ChannelSide;
  server: ChannelSide;
}

export function createChannel(): TestChannel {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  clientOut.pipe(serverIn);
  serverOut.pipe(clientIn);
  return {
    client: { read: clientIn, write: clientOut },
    server: { read: serverIn, write: serverOut },
  };
}

export function createServerConnection(side: ChannelSide): MessageConnection {
  const connection = createMessageConnection(
    new StreamMessageReader(side.read),
    new StreamMessageWriter(side.write),
  );
  connection.listen();
  return connection;
}