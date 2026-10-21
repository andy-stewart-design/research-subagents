import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KETCH_SERVER, createKetchServerConfig, waitForKetchCapabilities } from "./lib/ketch.ts";

// Ketch-only entry point for now. Delegation is added after the isolated runner is verified.
export default function (pi: ExtensionAPI) {
  if (!pi.getMcpServers().some((server) => server.name === KETCH_SERVER)) {
    pi.registerMcpServer(KETCH_SERVER, createKetchServerConfig("codemode"));
  }
  let startup: AbortController | undefined;
  pi.on("session_start", (_event, ctx) => {
    startup?.abort();
    const current = new AbortController();
    startup = current;
    void waitForKetchCapabilities(pi, { mode: "parent", signal: current.signal })
      .then(() => {
        if (!current.signal.aborted && !pi.getActiveTools().includes("codemode")) {
          ctx.ui.notify("Ketch is available, but codemode is inactive. Enable Pi's native codemode tool to call Ketch programmatically.", "warning");
        }
      })
      .catch((error: unknown) => {
        if (!current.signal.aborted) {
          ctx.ui.notify(error instanceof Error ? error.message : "Ketch startup failed.", "warning");
        }
      });
  });
  pi.on("session_shutdown", () => {
    startup?.abort();
    startup = undefined;
  });
}
