// Process trees: stop a server with everything it started, and measure what it uses. Launchers such as npx, uvx,
// cmd and wsl run the real server as a child of their own, so the direct child alone says little.
import { spawnSync } from "node:child_process";

// Every process with its parent and resident memory in bytes.
export function processTable() {
  if (process.platform === "win32") {
    const out = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)\" }"],
      { encoding: "utf8", windowsHide: true },
    ).stdout ?? "";
    return parse(out, 1);
  }
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }).stdout ?? "";
  return parse(out, 1024);
}

function parse(out, unit) {
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid]) => pid)
    .map(([pid, ppid, rss]) => ({ pid, ppid, bytes: (rss || 0) * unit }));
}

export function tree(root, table = processTable()) {
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
  for (const p of tree(pid).reverse()) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {}
  }
}
