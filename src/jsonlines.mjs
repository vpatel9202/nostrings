// JSON lines from a stream, with a cap on line length so a peer that never
// sends a newline cannot grow the buffer without bound. Emits "message" for
// each object, "invalid" for a line that is not JSON, and "overflow" once
// when a line passes the cap (then stops reading).
import { EventEmitter } from "node:events";

export const MAX_LINE = 32 * 1024 * 1024;

export class JsonLines extends EventEmitter {
  constructor(stream, { maxLine = MAX_LINE } = {}) {
    super();
    let buffer = "";
    let dead = false;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (dead) return;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (line.length > maxLine) {
          dead = true;
          buffer = "";
          this.emit("overflow");
          return;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.emit("invalid", line.slice(0, 200));
          continue;
        }
        this.emit("message", message);
      }
      if (buffer.length > maxLine) {
        dead = true;
        buffer = "";
        this.emit("overflow");
      }
    });
  }
}
