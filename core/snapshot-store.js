const fs = require("fs").promises;
const path = require("path");

const SNAPSHOT_ROOT = path.join(process.cwd(), "data", "snapshots");
const STATEMENT_ROOT = path.join(process.cwd(), "data", "statements");

function buildFileName(prefix) {
  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  return `${prefix}_${timestamp}_${Date.now()}.json`;
}

async function persistJson(targetDir, prefix, payload) {
  await fs.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, buildFileName(prefix));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

async function readDirectory(targetDir) {
  try {
    return await fs.readdir(targetDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function getLatestJson(targetDir) {
  const files = await readDirectory(targetDir);
  const jsonFiles = files.filter((file) => file.endsWith(".json"));

  if (jsonFiles.length === 0) {
    return null;
  }

  const sorted = jsonFiles.sort().reverse();
  return path.join(targetDir, sorted[0]);
}

module.exports = {
  SNAPSHOT_ROOT,
  STATEMENT_ROOT,
  async saveSnapshot(prefix, payload) {
    return persistJson(SNAPSHOT_ROOT, prefix, payload);
  },
  async saveStatements(prefix, payload) {
    return persistJson(STATEMENT_ROOT, prefix, payload);
  },
  async getLatestSnapshot() {
    return getLatestJson(SNAPSHOT_ROOT);
  },
  async getLatestStatements() {
    return getLatestJson(STATEMENT_ROOT);
  },
};
