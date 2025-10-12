#!/usr/bin/env node
require("dotenv").config();

const crypto = require("crypto");
const path = require("path");

const { createGocardlessClient } = require("../core/gocardless-client");
const {
  loadAccountsConfig,
  resolveAccount,
  ACCOUNTS_PATH,
} = require("../core/config");

function parseArgs(argv) {
  const options = {
    accountAlias: process.env.GOCARDLESS_ACTIVE_ACCOUNT || null,
    institutionId: process.env.GOCARDLESS_INSTITUTION_ID || null,
    redirect: process.env.REDIRECT_URL,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--account" || arg === "-a") {
      options.accountAlias = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--account=")) {
      options.accountAlias = arg.split("=")[1];
      continue;
    }

    if (arg === "--institution") {
      options.institutionId = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--institution=")) {
      options.institutionId = arg.split("=")[1];
      continue;
    }

    if (arg === "--redirect") {
      options.redirect = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--redirect=")) {
      options.redirect = arg.split("=")[1];
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
  }

  return options;
}

function assertEnv(value, name) {
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function buildReference(institutionId) {
  const sanitized = institutionId.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const randomSuffix = crypto.randomUUID().split("-")[0];
  return `${sanitized}_${randomSuffix}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`Usage: node ${path.relative(process.cwd(), __filename)} [options]

Options:
  --account <alias>       Account alias in config/accounts.json (defaults to GOCARDLESS_ACTIVE_ACCOUNT)
  --institution <id>      Institution ID override
  --redirect <url>        Redirect URL override (defaults to REDIRECT_URL env)
  -h, --help              Show this help message
`);
    return;
  }

  const secretId = assertEnv(process.env.GOCARDLESS_SECRET_ID, "GOCARDLESS_SECRET_ID");
  const secretKey = assertEnv(process.env.GOCARDLESS_SECRET_KEY, "GOCARDLESS_SECRET_KEY");
  const redirect = assertEnv(options.redirect, "REDIRECT_URL");

  let institutionId = options.institutionId;

  if (!institutionId) {
    try {
      const accountsConfig = await loadAccountsConfig();
      const alias = options.accountAlias;

      if (!alias) {
        throw new Error(
          "No account alias specified. Use --account or set GOCARDLESS_ACTIVE_ACCOUNT."
        );
      }

      const accountConfig = resolveAccount(accountsConfig, alias);
      institutionId = accountConfig.institutionId;
    } catch (error) {
      if (error.message.includes("config/accounts.json")) {
        console.error(error.message);
        console.error(
          `Hint: copy ${path.relative(
            process.cwd(),
            path.join(process.cwd(), "config", "accounts.sample.json")
          )} to ${path.relative(process.cwd(), ACCOUNTS_PATH)} and fill in your details.`
        );
        process.exitCode = 1;
        return;
      }

      throw error;
    }
  }

  const client = createGocardlessClient({ secretId, secretKey });

  const agreement = await client.createEndUserAgreement({ institutionId });
  const requisition = await client.createRequisition({
    redirect,
    institutionId,
    reference: buildReference(institutionId),
    agreementId: agreement.id,
  });

  console.log("Successfully created end user agreement and requisition\n");
  console.log("Institution:", institutionId);
  console.log("Agreement ID:", agreement.id);
  console.log("Requisition ID:", requisition.id);
  console.log("\nOpen this link to complete the consent:");
  console.log(requisition.link);
  console.log(
    "\nRemember to update config/accounts.json (and .env if you keep a fallback) with the new requisition ID."
  );
}

main().catch((error) => {
  console.error("Failed to create consent:");
  if (error.response?.data) {
    console.error(JSON.stringify(error.response.data, null, 2));
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
});
