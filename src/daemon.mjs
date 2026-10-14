// Shared mode: one daemon per user runs the servers, and every session's proxy is a pipe to it. Five sessions using
// the same server then share one copy of it. Servers marked perSession (a browser, say) get one copy per session.
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ensureHome, loadServers, log, PIDFILE, SERVERS, SOCKET, watchFiles } from "./config.mjs";
import { killTree } from "./kill.mjs";
import { BUILD, VERSION } from "./build.mjs";
import { bind, CAPABILITIES, Hub, instructionsOf, notifyChanged, signature } from "./proxy.mjs";
import { connect, daemonPid, line, readLine } from "./session.mjs";
import { watchdog } from "./watchdog.mjs";
import { SocketTransport } from "./socket.mjs";

// How long the daemon stays after the last session has gone and the last server has stopped.
const LINGER = Number(process.env.MCP_ONDEMAND_LINGER ?? 60) * 1000;

const pick = (servers, perSession) => Object.fromEntries(Object.entries(servers).filter(([, s]) => Boolean(s.perSession) === perSession));
const mtime = () => (existsSync(SERVERS) ? statSync(SERVERS).mtimeMs : 0);

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
      const before = s.seen;
      s.own.rebuild();
      s.seen = signature([shared, s.own]);
      if (s.seen !== before) notifyChanged(s.server);
    }
  };
  // servers.json edited, or caches rebuilt by "mcp-ondemand refresh": open sessions see it now, not next time.
  const reloadConfig = async () => {
    seen = mtime();
    servers = loadServers();
    await shared.reload(pick(servers, false));
    for (const s of sessions) await s.own.reload(pick(servers, true));
    changed();
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
    if (hello?.version !== VERSION || hello?.build !== BUILD) {
      socket.end(line("restart"));
      if (!draining) {
        draining = true;
        listener.close();
        log("draining: a session runs version", hello?.version, "build", hello?.build);
      }
      return;
    }
    // servers.json changed since the last session: changed servers are stopped, the rest keep running.
    if (mtime() !== seen) {
      await reloadConfig();
      log("config reloaded");
    } else shared.rebuild(); // caches rebuilt by "refresh" in the meantime
    const own = new Hub(pick(servers, true), { cwd: hello.cwd });
    const server = new Server({ name: "mcp-ondemand", version: VERSION }, { capabilities: CAPABILITIES, instructions: instructionsOf([shared, own]) });
    own.onChanged = changed;
    bind(server, [shared, own]);
    const session = { server, own, seen: signature([shared, own]) };
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
  log("daemon ready, pid", process.pid, "version", VERSION, "build", BUILD);
  shared.warmup();
  const warm = new Hub(pick(servers, true));
  warm.onChanged = changed;
  warm.warmup({ preload: false });
  watchdog(() => [shared, warm, ...[...sessions].map((s) => s.own)]);
  watchFiles(() => reloadConfig().catch((err) => log("reload failed:", err?.message ?? err)));

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

// Ask the running daemon what runs, as a short session of its own. Null when no daemon answers.
export async function liveStatus() {
  const socket = await connect().catch(() => null);
  if (!socket) return null;
  try {
    socket.write(line({ version: VERSION, build: BUILD, cwd: process.cwd() }));
    const reply = await readLine(socket);
    if (reply.message !== "ok") return null;
    const client = new Client({ name: "mcp-ondemand-status", version: VERSION });
    await client.connect(new SocketTransport(socket, reply.rest));
    const result = await client.callTool({ name: "ondemand_status", arguments: {} });
    await client.close();
    return result.content[0].text.split("\n").filter((l) => !l.endsWith("(this session)"));
  } catch {
    socket.destroy();
    return null;
  }
}

export function stopDaemon() {
  const pid = daemonPid();
  if (pid) killTree(pid);
  return pid;
}
