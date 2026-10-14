// Version and a fingerprint of the code. Kept free of the MCP SDK: a session's pipe loads only what it needs.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "1.4.1";
// A fingerprint of the code itself. Sessions and daemon compare it, so any change to the code (an update, a
// git pull, a local edit) replaces a running daemon, not only a new version number.
const SRC = dirname(fileURLToPath(import.meta.url));
export const BUILD = createHash("sha1")
  .update(readdirSync(SRC).filter((f) => f.endsWith(".mjs")).sort().map((f) => readFileSync(join(SRC, f), "utf8")).join("\n"))
  .digest("hex")
  .slice(0, 12);
