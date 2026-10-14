// Process trees: stop a server with everything it started, and measure what it uses. Launchers such as npx, uvx,
// cmd and wsl run the real server as a child of their own, so the direct child alone says little.
import { execFile, spawnSync } from "node:child_process";

const WIN_TABLE = ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)\" }"];

// Every process with its parent and resident memory in bytes. Asynchronous: on Windows this takes seconds, and
// the proxy must keep serving calls meanwhile.
export function processTable() {
  const [cmd, args, unit] = process.platform === "win32" ? ["powershell", WIN_TABLE, 1] : ["ps", ["-A", "-o", "pid=,ppid=,rss="], 1024];
  return new Promise((resolve) =>
    execFile(cmd, args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_err, out) => resolve(parse(out ?? "", unit))),
  );
}

// Only for stopping on Linux and macOS, where ps is fast and the parent must be found before it dies.
const processTableSync = () => parse(spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }).stdout ?? "", 1024);

function parse(out, unit) {
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid]) => pid)
    .map(([pid, ppid, rss]) => ({ pid, ppid, bytes: (rss || 0) * unit }));
}

export function tree(root, table) {
  const children = new Map();
  for (const p of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const found = table.filter((p) => p.pid === root);
  for (let i = 0; i < found.length; i++) found.push(...(children.get(found[i].pid) ?? []));
  return found;
}

// Resident memory of a process and all its descendants, in MB.
export const treeMemory = (pid, table) => Math.round(tree(pid, table).reduce((sum, p) => sum + p.bytes, 0) / 1048576);

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  // Children first, collected before the parent dies and they are re-parented.
  for (const p of tree(pid, processTableSync()).reverse()) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {}
  }
}
