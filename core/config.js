const fs = require("fs").promises;
const path = require("path");

const ACCOUNTS_PATH = path.join(process.cwd(), "config", "accounts.json");

async function loadAccountsConfig() {
  try {
    const raw = await fs.readFile(ACCOUNTS_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("accounts.json must be a JSON object keyed by account alias");
    }

    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "config/accounts.json not found. Copy config/accounts.sample.json and populate your account metadata."
      );
    }
    throw error;
  }
}

function resolveAccount(accountsConfig, alias) {
  if (!alias) {
    throw new Error("Account alias is required");
  }

  const entry = accountsConfig[alias];

  if (!entry) {
    throw new Error(`Account alias "${alias}" not found in config/accounts.json`);
  }

  if (!entry.institutionId) {
    throw new Error(
      `Account alias "${alias}" is missing institutionId in config/accounts.json`
    );
  }

  return entry;
}

module.exports = {
  ACCOUNTS_PATH,
  loadAccountsConfig,
  resolveAccount,
};
