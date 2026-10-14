// Shared mode: one daemon per user runs the servers, and every session's proxy is a pipe to it. Five sessions using
// the same server then share one copy of it. Servers marked perSession (a browser, say) get one copy per session.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ensureHome, HOME, loadServers, log, SERVERS } from "./config.mjs";
import { killTree } from "./kill.mjs";
import { bind, CAPABILITIES, Hub, instructionsOf, notifyChanged, serveLocal, VERSION } from "./proxy.mjs";
import { SOCKET, SocketTransport } from "./socket.mjs";

const BIN = fileURLToPath(new URL("../bin/mcp-ondemand.mjs", import.meta.url));
export const PIDFILE = join(HOME, "daemon.pid");
// How long the daemon stays after the last session has gone and the last server has stopped.
const LINGER = Number(process.env.MCP_ONDEMAND_LINGER ?? 60) * 1000;

const pick = (servers, perSession) => Object.fromEntries(Object.entries(servers).filter(([, s]) => Boolean(s.perSession) === perSession));
const mtime = () => (existsSync(SERVERS) ? statSync(SERVERS).mtimeMs : 0);
const line = (value) => `${JSON.stringify({ ondemand: value })}\n`;

// Read one newline-terminated JSON line from a socket. Returns it and whatever came after it.
function readLine(socket, ms = 5000) {
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

// ---- the daemon ----

export async function runDaemon() {
  ensureHome();
  let seen = mtime();
  let servers = loadServers();
  const shared = new Hub(pick(servers, false));
  const sessions = new Set();
  let draining = false;
  let quietSince = Date.now();
  // A cache changed (a server ran and offered something new): every session sees it, whichever hub ran it.
  const changed = () => {
    shared.rebuild();
    for (const s of sessions) {
      s.own.rebuild();
      notifyChanged(s.server);
    }
  };
  shared.onChanged = changed;

  const listener = net.createServer((socket) => {
    // For the socket's whole life: a session that drops hard (ECONNRESET, EPIPE) must not become an uncaught error.
    socket.on("error", (err) => log("session socket:", err.code ?? err.message));
    accept(socket).catch((err) => {
      log("session refused:", err.message);
      socket.destroy();
    });
  });

  async function accept(socket) {
    const { message: hello, rest } = await readLine(socket);
    // A proxy of another version: let it start a daemon of its own version, and leave once our sessions end.
    if (hello?.version !== VERSION) {
      socket.end(line("restart"));
      if (!draining) {
        draining = true;
        listener.close();
        log("draining: a session runs version", hello?.version);
      }
      return;
    }
    // servers.json changed since the last session: changed servers are stopped, the rest keep running.
    if (mtime() !== seen) {
      seen = mtime();
      servers = loadServers();
      await shared.reload(pick(servers, false));
      log("config reloaded");
    } else shared.rebuild(); // caches rebuilt by "refresh" in the meantime
    const own = new Hub(pick(servers, true), { cwd: hello.cwd });
    const server = new Server({ name: "mcp-ondemand", version: VERSION }, { capabilities: CAPABILITIES, instructions: instructionsOf([shared, own]) });
    own.onChanged = changed;
    bind(server, [shared, own]);
    const session = { server, own };
    sessions.add(session);
    server.onclose = () => {
      sessions.delete(session);
      own.stopAll("session ended");
      log("session ended,", sessions.size, "left");
    };
    socket.write(line("ok"));
    await server.connect(new SocketTransport(socket, rest));
    log("session started,", sessions.size, "open");
  }

  await listen(listener);
  writeFileSync(PIDFILE, String(process.pid));
  log("daemon ready, pid", process.pid, "version", VERSION);
  shared.warmup();
  const warm = new Hub(pick(servers, true));
  warm.onChanged = changed;
  warm.warmup({ preload: false });

  // However the process ends (a clean exit, a signal, a fatal error), no server it started is left behind and the
  // pid file goes. Synchronous: nothing asynchronous runs during "exit".
  process.on("exit", () => {
    for (const hub of [shared, warm, ...[...sessions].map((s) => s.own)]) for (const s of hub.live.values()) killTree(s.pid);
    try {
      if (readFileSync(PIDFILE, "utf8") === String(process.pid)) unlinkSync(PIDFILE);
    } catch {}
  });
  // One misbehaving session or server must not take down every other session: log and carry on.
  process.on("uncaughtException", (err) => log("uncaught:", err?.stack ?? err));
  process.on("unhandledRejection", (err) => log("unhandled rejection:", err?.stack ?? err));

  let exiting = false;
  const exit = async (why) => {
    if (exiting) return;
    exiting = true;
    log("daemon exiting:", why);
    if (listener.listening) listener.close();
    await Promise.all([shared, warm, ...[...sessions].map((s) => s.own)].map((h) => h.stopAll(why)));
    process.exit(0);
  };
  process.on("SIGINT", () => exit("SIGINT"));
  process.on("SIGTERM", () => exit("SIGTERM"));
  // Not unref'd: this timer is what ends the daemon. Once draining has closed the listener and the last session
  // is gone, nothing else keeps the process alive, and it would end without cleaning up.
  setInterval(() => {
    if (sessions.size || shared.live.size || warm.live.size) quietSince = Date.now();
    else if (draining || Date.now() - quietSince >= LINGER) exit(draining ? "replaced by a newer version" : "no sessions");
  }, Math.min(5000, Math.max(250, LINGER / 4)));
}

async function listen(listener) {
  const attempt = () =>
    new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(SOCKET, () => {
        listener.off("error", reject);
        resolve();
      });
    });
  try {
    await attempt();
  } catch (err) {
    if (err.code !== "EADDRINUSE") throw err;
    // Another daemon answers: leave it be. A socket file nobody answers on is left over from a crash.
    if (await connect().then((s) => (s.destroy(), true), () => false)) {
      log("another daemon is running");
      process.exit(0);
    }
    if (process.platform !== "win32") unlinkSync(SOCKET);
    await attempt();
  }
}

// ---- the session side ----

function connect() {
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
    socket.write(line({ version: VERSION, cwd: process.cwd() }));
    const reply = await readLine(socket).catch(() => null);
    if (reply?.message === "ok") return { socket, rest: reply.rest };
    // An older daemon is stepping aside; the next round starts ours.
    socket.destroy();
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

export async function serve() {
  if (process.env.MCP_ONDEMAND_SHARED === "0") return serveLocal();
  const s = await session();
  if (!s) {
    log("daemon unavailable, running this session locally");
    return serveLocal();
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

export function stopDaemon() {
  const pid = daemonPid();
  if (pid) killTree(pid);
  return pid;
}
