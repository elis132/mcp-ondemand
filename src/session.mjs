// A session's side of shared mode: a plain byte pipe between the client and the daemon. It loads no MCP code at
// all, since it runs once per open session: the daemon does the MCP work once for everyone.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { BUILD, VERSION } from "./build.mjs";
import { HOME, log, PIDFILE, SOCKET } from "./config.mjs";

const BIN = fileURLToPath(new URL("../bin/mcp-ondemand.mjs", import.meta.url));
export const line = (value) => `${JSON.stringify({ ondemand: value })}\n`;

// Read one newline-terminated JSON line from a socket. Returns it and whatever came after it.
export function readLine(socket, ms = 5000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error("no handshake")), ms);
    const done = (err, value) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", done);
      socket.off("close", onClose);
      err ? reject(err) : resolve(value);
    };
    const onClose = () => done(new Error("closed"));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf(10);
      if (i < 0) return;
      try {
        done(null, { message: JSON.parse(buf.subarray(0, i).toString("utf8")).ondemand, rest: buf.subarray(i + 1) });
      } catch (err) {
        done(err);
      }
    };
    socket.on("data", onData);
    socket.on("error", done);
    socket.on("close", onClose);
  });
}

export function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

// Started through a short-lived launcher, so the daemon is not a child of this session's process: a client that
// kills the session's process tree must not take the daemon, and every other session, with it.
function launch() {
  spawn(process.execPath, [BIN, "daemon-launch"], { detached: true, stdio: "ignore", windowsHide: true, cwd: HOME }).unref();
}

export function launchDaemon() {
  spawn(process.execPath, [BIN, "daemon"], { detached: true, stdio: "ignore", windowsHide: true, cwd: HOME }).unref();
}

async function session() {
  for (let attempt = 0; attempt < 2; attempt++) {
    let socket = await connect().catch(() => null);
    if (!socket) {
      launch();
      for (let i = 0; i < 50 && !socket; i++) {
        await new Promise((r) => setTimeout(r, 200));
        socket = await connect().catch(() => null);
      }
    }
    if (!socket) return null;
    socket.write(line({ version: VERSION, build: BUILD, cwd: process.cwd() }));
    const reply = await readLine(socket).catch(() => null);
    if (reply?.message === "ok") return { socket, rest: reply.rest };
    // An older daemon is stepping aside; the next round starts ours.
    socket.destroy();
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

export async function serve() {
  if (process.env.MCP_ONDEMAND_SHARED === "0") return (await import("./proxy.mjs")).serveLocal();
  const s = await session();
  if (!s) {
    log("daemon unavailable, running this session locally");
    return (await import("./proxy.mjs")).serveLocal();
  }
  const { socket, rest } = s;
  if (rest.length) process.stdout.write(rest);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.on("end", () => socket.end());
  socket.on("close", () => process.exit(0));
  socket.on("error", () => process.exit(1));
}

// Running daemon's pid, if any.
export function daemonPid() {
  try {
    const pid = Number(readFileSync(PIDFILE, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

