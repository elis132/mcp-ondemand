// Memory limits. Off unless configured: a server's "maxMemory" (MB) in servers.json, or "memoryBudget" (MB) for all
// servers together in settings.json. Checked every minute while servers run. A server over its own limit is
// restarted on its next call; over the budget, the least recently used idle servers are stopped first.
// Never while a call is running.
import { loadSettings, log } from "./config.mjs";
import { processTable, treeMemory } from "./kill.mjs";

const EVERY = Number(process.env.MCP_ONDEMAND_WATCHDOG ?? 60) * 1000;

// hubs: a function returning the hubs to watch (their set changes as sessions come and go).
export function watchdog(hubs) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    const budget = loadSettings().memoryBudget;
    const running = hubs().flatMap((hub) => [...hub.live].filter(([, s]) => s.pid).map(([name, s]) => ({ hub, name, s })));
    if (!running.length || (!budget && !running.some((r) => r.hub.servers[r.name]?.maxMemory))) return;
    busy = true;
    try {
      const table = await processTable();
      for (const r of running) r.mb = treeMemory(r.s.pid, table);
      for (const r of running) {
        const max = r.hub.servers[r.name]?.maxMemory;
        if (max && r.mb > max && r.s.inFlight === 0) {
          r.stopped = true;
          await r.hub.stop(r.name, `memory ${r.mb} MB over its limit of ${max} MB`);
        }
      }
      if (budget) {
        let total = running.filter((r) => !r.stopped).reduce((sum, r) => sum + r.mb, 0);
        for (const r of running.filter((r) => !r.stopped && r.s.inFlight === 0).sort((a, b) => a.s.lastUsed - b.s.lastUsed)) {
          if (total <= budget) break;
          await r.hub.stop(r.name, `memory budget: ${total} MB of ${budget} MB in use, least recently used`);
          total -= r.mb;
        }
      }
    } catch (err) {
      log("watchdog:", err?.message ?? err);
    } finally {
      busy = false;
    }
  }, EVERY);
  timer.unref?.();
  return timer;
}
