#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs").promises;
const path = require("path");

const { createGocardlessClient } = require("../core/gocardless-client");
const {
  loadAccountsConfig,
  resolveAccount,
} = require("../core/config");
const {
  saveStatements,
  getLatestStatements,
} = require("../core/snapshot-store");

function parseArgs(argv) {
  const options = {
    accountAlias: process.env.GOCARDLESS_ACTIVE_ACCOUNT || null,
    accountId: process.env.GOCARDLESS_ACCOUNT_ID || null,
    dateFrom: null,
    dateTo: null,
    local: false,
    save: true,
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

    if (arg === "--account-id") {
      options.accountId = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--account-id=")) {
      options.accountId = arg.split("=")[1];
      continue;
    }

    if (arg === "--from") {
      options.dateFrom = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--from=")) {
      options.dateFrom = arg.split("=")[1];
      continue;
    }

    if (arg === "--to") {
      options.dateTo = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--to=")) {
      options.dateTo = arg.split("=")[1];
      continue;
    }

    if (arg === "--local") {
      options.local = true;
      continue;
    }

    if (arg === "--no-save") {
      options.save = false;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
  }

  return options;
}

function computeDefaultDateRange() {
  const today = new Date();
  const past = new Date(today);
  past.setMonth(today.getMonth() - 3);

  return {
    dateFrom: past.toISOString().split("T")[0],
    dateTo: today.toISOString().split("T")[0],
  };
}

function sanitizeIban(value) {
  return value ? value.replace(/\s+/g, "").toUpperCase() : null;
}

async function resolveAccountId(client, accountConfig, explicitAccountId) {
  if (explicitAccountId) {
    return explicitAccountId;
  }

  if (accountConfig.accountId) {
    return accountConfig.accountId;
  }

  if (!accountConfig.requisitionId) {
    throw new Error(
      "Account configuration is missing requisitionId; cannot resolve account without it"
    );
  }

  if (!accountConfig.iban) {
    throw new Error(
      "Account configuration needs either accountId or IBAN to resolve the account"
    );
  }

  const targetIban = sanitizeIban(accountConfig.iban);
  const requisition = await client.getRequisition(accountConfig.requisitionId);

  if (!Array.isArray(requisition.accounts) || requisition.accounts.length === 0) {
    throw new Error(
      `No accounts returned for requisition ${accountConfig.requisitionId}. Ensure the consent is completed.`
    );
  }

  for (const accountId of requisition.accounts) {
    const details = await client.getAccountDetails(accountId);
    const candidateIban = sanitizeIban(
      details?.account?.iban ||
        details?.account?.cashAccount?.iban ||
        details?.account?.details?.iban ||
        details?.iban
    );

    if (candidateIban === targetIban) {
      return accountId;
    }
  }

  throw new Error(
    `No account matching IBAN ${accountConfig.iban} found for requisition ${accountConfig.requisitionId}`
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`Usage: node ${path.relative(
      process.cwd(),
      __filename
    )} [options]

Options:
  --account <alias>    Account alias in config/accounts.json (defaults to GOCARDLESS_ACTIVE_ACCOUNT)
  --account-id <uuid>  Override account ID directly
  --from <YYYY-MM-DD>  Start date (defaults to 3 months ago)
  --to <YYYY-MM-DD>    End date (defaults to today)
  --local              Replay the latest saved statement instead of calling the API
  --no-save            Do not write a new statements file (API mode only)
  -h, --help           Show this help
`);
    return;
  }

  if (options.local) {
    const latest = await getLatestStatements();
    if (!latest) {
      console.log("No saved statements found in data/statements");
      return;
    }

    const content = await fs.readFile(latest, "utf8");
    const parsed = JSON.parse(content);

    console.log(`Loaded statements from ${latest}`);
    console.log(JSON.stringify(parsed.summary || parsed, null, 2));
    return;
  }

  const secretId = process.env.GOCARDLESS_SECRET_ID;
  const secretKey = process.env.GOCARDLESS_SECRET_KEY;
  const redirect = process.env.REDIRECT_URL;

  if (!secretId || !secretKey) {
    throw new Error("Set GOCARDLESS_SECRET_ID and GOCARDLESS_SECRET_KEY in your .env");
  }

  if (!redirect) {
    throw new Error("REDIRECT_URL is required in your .env");
  }

  const accountsConfig = await loadAccountsConfig();
  const alias = options.accountAlias;

  if (!alias) {
    throw new Error(
      "No account alias specified. Use --account or set GOCARDLESS_ACTIVE_ACCOUNT."
    );
  }

  const accountConfig = resolveAccount(accountsConfig, alias);

  if (!accountConfig.requisitionId) {
    throw new Error(
      `Account alias "${alias}" is missing requisitionId in config/accounts.json`
    );
  }

  const client = createGocardlessClient({ secretId, secretKey });

  const { dateFrom, dateTo } = {
    ...computeDefaultDateRange(),
    ...(options.dateFrom ? { dateFrom: options.dateFrom } : {}),
    ...(options.dateTo ? { dateTo: options.dateTo } : {}),
  };

  const accountId = await resolveAccountId(client, accountConfig, options.accountId);
  const [details, balances, transactions] = await Promise.all([
    client.getAccountDetails(accountId),
    client.getAccountBalances(accountId),
    client.getAccountTransactions(accountId, { dateFrom, dateTo }),
  ]);

  const result = {
    fetchedAt: new Date().toISOString(),
    accountAlias: alias,
    institutionId: accountConfig.institutionId,
    requisitionId: accountConfig.requisitionId,
    accountId,
    dateFrom,
    dateTo,
    details,
    balances,
    transactions,
  };

  console.log(`Fetched statements for ${alias} (${accountId}) from ${dateFrom} to ${dateTo}`);

  if (options.save) {
    const filePath = await saveStatements(`statements_${alias}`, result);
    console.log(`Saved statements to ${filePath}`);
  }

  console.log(
    JSON.stringify(
      {
        balances: balances.balances || balances,
        bookedTransactions: transactions?.transactions?.booked?.length || 0,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("Failed to fetch statements:");
  if (error.response?.data) {
    console.error(JSON.stringify(error.response.data, null, 2));
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
});
