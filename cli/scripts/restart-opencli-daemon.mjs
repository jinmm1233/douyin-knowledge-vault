import { restartDaemon } from "../node_modules/@jackwener/opencli/dist/src/browser/daemon-lifecycle.js";
import { fetchDaemonStatus } from "../node_modules/@jackwener/opencli/dist/src/browser/daemon-transport.js";
import { PKG_VERSION } from "../node_modules/@jackwener/opencli/dist/src/version.js";

try {
  const existing = await fetchDaemonStatus();
  if (existing) {
    if (existing.daemonVersion && existing.daemonVersion !== PKG_VERSION) {
      console.error(`OpenCLI daemon v${existing.daemonVersion} is already running, but this workflow pins v${PKG_VERSION}.`);
      console.error("Stop the old daemon from a separate terminal, then rerun setup-browser-bridge.ps1.");
      process.exit(1);
    }
    console.log(`OpenCLI daemon already running on port ${existing.port}.`);
    console.log(existing.extensionConnected
      ? "Browser Bridge extension connected."
      : "Browser Bridge extension is not connected yet; load or enable the verified extension in Chrome.");
    process.exit(0);
  }
  const result = await restartDaemon();
  if (!result.stopped || !result.status) {
    const detail = !result.stopped
      ? "the existing daemon did not stop cleanly"
      : "the new daemon did not report status before timeout";
    console.error(`OpenCLI daemon restart failed: ${detail}.`);
    process.exit(1);
  }
  const action = result.previousStatus ? "restarted" : "started";
  console.log(`OpenCLI daemon ${action} on port ${result.status.port}.`);
  console.log(result.status.extensionConnected
    ? "Browser Bridge extension connected."
    : "Browser Bridge extension is not connected yet; load or enable the verified extension in Chrome.");
  process.exit(0);
} catch (error) {
  console.error(`OpenCLI daemon restart failed: ${error?.message || error}`);
  process.exit(1);
}
