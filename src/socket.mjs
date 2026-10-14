// MCP over a local socket (a named pipe on Windows), between session proxies and the shared daemon.
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

export { SOCKET } from "./config.mjs";

export class SocketTransport {
  // initial: bytes already read from the socket (after the daemon's handshake line).
  constructor(socket, initial) {
    this.socket = socket;
    this.buffer = new ReadBuffer();
    this.initial = initial;
  }

  async start() {
    const take = (chunk) => {
      this.buffer.append(chunk);
      for (;;) {
        let message;
        try {
          message = this.buffer.readMessage();
        } catch (err) {
          this.onerror?.(err);
          continue;
        }
        if (!message) break;
        this.onmessage?.(message);
      }
    };
    this.socket.on("data", take);
    if (this.initial?.length) queueMicrotask(() => take(this.initial));
    this.socket.on("error", (err) => this.onerror?.(err));
    this.socket.on("close", () => this.onclose?.());
  }

  send(message) {
    return new Promise((resolve) => (this.socket.write(serializeMessage(message)) ? resolve() : this.socket.once("drain", resolve)));
  }

  async close() {
    this.socket.end();
  }
}
