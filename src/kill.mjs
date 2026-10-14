// Stop a server and everything it started. Launchers such as npx, uvx, cmd and wsl run the real server as a
// child of their own, so killing only the direct child leaves the server running.
import { spawnSync } from "node:child_process";

function descendants(root) {
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout ?? "";
  const children = new Map();
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  // Children first, collected before the parent dies and they are re-parented.
  for (const p of [...descendants(pid).reverse(), pid]) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
}
