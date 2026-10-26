import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const config = loadConfig(option("--config"));
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const outputRoot = path.resolve(option("--output", path.join(config.stateDir, "backups")));
const destination = path.join(outputRoot, timestamp);
fs.mkdirSync(outputRoot, { recursive: true });
fs.mkdirSync(destination, { recursive: false });

const databaseBackup = path.join(destination, "state.sqlite3");
const db = new DatabaseSync(config.databaseFile);
try {
  db.exec("PRAGMA wal_checkpoint(FULL)");
  db.exec(`VACUUM INTO '${databaseBackup.replaceAll("'", "''")}'`);
} finally {
  db.close();
}
if (fs.existsSync(config.configFile)) fs.copyFileSync(config.configFile, path.join(destination, "config.json"));
const manifest = {
  createdAt: new Date().toISOString(),
  projectStateOnly: true,
  database: databaseBackup,
  config: fs.existsSync(config.configFile) ? path.join(destination, "config.json") : null,
  excluded: ["knowledge vault", "media", "transcripts", "knowledge artifacts", "credentials"],
};
fs.writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
