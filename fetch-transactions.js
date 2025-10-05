require("dotenv").config();
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");

const BASE_URL = "https://bankaccountdata.gocardless.com/api/v2";

const DEFAULT_RENT_CONFIG = "590:Unit 1,565:Unit 2,565:Unit 3,540:Unit 4";

function loadRentExpectations() {
  const rawConfig = (process.env.RENT_EXPECTED || DEFAULT_RENT_CONFIG).trim();

  if (!rawConfig) {
    return [];
  }

  return rawConfig.split(",").map((entry, index) => {
    const [amountPart, labelPart] = entry.split(":");
    const amount = parseFloat((amountPart || "").trim());

    if (Number.isNaN(amount)) {
      throw new Error(
        `Invalid RENT_EXPECTED entry at position ${index + 1}: "${entry}"`
      );
    }

    const label = (labelPart || `Unit ${index + 1}`).trim();

    return { amount, label };
  });
}

const RENT_EXPECTATIONS = loadRentExpectations();

function parseAccountsConfig() {
  const raw = process.env.GOCARDLESS_ACCOUNTS;
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);

    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("GOCARDLESS_ACCOUNTS must be a JSON object");
    }

    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse GOCARDLESS_ACCOUNTS: ${error.message}`);
  }
}

function getActiveAccountConfig(overrideAlias) {
  const accounts = parseAccountsConfig();

  if (!accounts) {
    return null;
  }

  const alias = overrideAlias || process.env.GOCARDLESS_ACTIVE_ACCOUNT;

  if (!alias) {
    throw new Error(
      "Set GOCARDLESS_ACTIVE_ACCOUNT to select one of the configured accounts"
    );
  }

  const entry = accounts[alias];

  if (!entry) {
    throw new Error(
      `No account configuration found for alias "${alias}" in GOCARDLESS_ACCOUNTS`
    );
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `Account configuration for alias "${alias}" must be a JSON object`
    );
  }

  return { alias, ...entry };
}

function normalizeIban(value) {
  return value ? value.replace(/\s+/g, "").toUpperCase() : null;
}

function extractIban(details) {
  return (
    details?.account?.iban ||
    details?.account?.cashAccount?.iban ||
    details?.account?.details?.iban ||
    details?.iban ||
    null
  );
}

class BankDataService {
  constructor(useLocalFile = false) {
    this.accessToken = null;
    this.useLocalFile = useLocalFile;
  }

  async initialize() {
    if (!this.useLocalFile) {
      try {
        const tokenResponse = await axios.post(`${BASE_URL}/token/new/`, {
          secret_id: process.env.GOCARDLESS_SECRET_ID,
          secret_key: process.env.GOCARDLESS_SECRET_KEY,
        });

        this.accessToken = tokenResponse.data.access;
        console.log("Successfully obtained access token");
        return this.accessToken;
      } catch (error) {
        console.error("Error getting access token:");
        if (error.response) {
          console.error("Response data:", error.response.data);
          console.error("Response status:", error.response.status);
        } else {
          console.error(error.message);
        }
        throw error;
      }
    }
  }

  async getLatestTransactionFile() {
    const dirPath = path.join(process.cwd(), "transactions");
    try {
      const files = await fs.readdir(dirPath);
      const jsonFiles = files.filter((file) => file.endsWith(".json"));

      if (jsonFiles.length === 0) {
        throw new Error("No transaction files found");
      }

      // Sort files by creation date (newest first)
      const sortedFiles = jsonFiles.sort().reverse();
      return path.join(dirPath, sortedFiles[0]);
    } catch (error) {
      console.error("Error reading transaction files:", error.message);
      throw error;
    }
  }

  async getRequisitionAccounts(requisitionId) {
    try {
      const response = await axios.get(
        `${BASE_URL}/requisitions/${requisitionId}/`,
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        }
      );

      return response.data.accounts || [];
    } catch (error) {
      console.error("Error fetching requisition accounts:");
      if (error.response) {
        console.error("Response data:", error.response.data);
        console.error("Response status:", error.response.status);
      } else {
        console.error(error.message);
      }
      throw error;
    }
  }

  async getAccountDetails(accountId) {
    try {
      const response = await axios.get(
        `${BASE_URL}/accounts/${accountId}/details/`,
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        }
      );

      return response.data;
    } catch (error) {
      console.error("Error fetching account details:");
      if (error.response) {
        console.error("Response data:", error.response.data);
        console.error("Response status:", error.response.status);
      } else {
        console.error(error.message);
      }
      throw error;
    }
  }

  async getAccountTransactions(accountId, dateFrom, dateTo) {
    if (this.useLocalFile) {
      try {
        console.log("Using local transaction file...");
        const filePath = await this.getLatestTransactionFile();
        console.log(`Reading from: ${filePath}`);

        const fileContent = await fs.readFile(filePath, "utf8");
        return JSON.parse(fileContent);
      } catch (error) {
        console.error("Error reading local file:", error.message);
        throw error;
      }
    } else {
      try {
        console.log("Fetching transactions from API...");
        console.log("Account:", accountId);
        console.log("Date range:", dateFrom, "to", dateTo);

        const response = await axios.get(
          `${BASE_URL}/accounts/${accountId}/transactions/`,
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            params: {
              date_from: dateFrom,
              date_to: dateTo,
            },
          }
        );

        // Save the response to a file
        await this.saveTransactionsToFile(response.data, dateFrom, dateTo);

        return response.data;
      } catch (error) {
        console.error("Error getting transactions from API:");
        if (error.response) {
          console.error("Response data:", error.response.data);
          console.error("Response status:", error.response.status);
        } else {
          console.error(error.message);
        }
        throw error;
      }
    }
  }

  async saveTransactionsToFile(data, dateFrom, dateTo) {
    try {
      // Create a transactions directory if it doesn't exist
      const dirPath = path.join(process.cwd(), "transactions");
      await fs.mkdir(dirPath, { recursive: true });

      // Create filename with current timestamp and date range
      const filename = `transactions_${dateFrom}_to_${dateTo}_${Date.now()}.json`;
      const filePath = path.join(dirPath, filename);

      // Save the data
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");

      console.log(`\nTransactions saved to: ${filePath}`);
    } catch (error) {
      console.error("Error saving transactions to file:", error.message);
      throw error;
    }
  }
}

function checkRentPayments(transactions, month, year) {
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 0);

  // Filter transactions for the specific month
  const monthTransactions = transactions.filter((tx) => {
    const txDate = new Date(tx.bookingDate);
    return (
      txDate >= startDate &&
      txDate <= endDate &&
      parseFloat(tx.transactionAmount.amount) > 0
    );
  });

  // Track used transactions to avoid duplicates
  const usedTransactionIds = new Set();

  // Check each expected rent amount
  const rentStatus = RENT_EXPECTATIONS.map(({ amount, label }) => {
    // Find matching transaction that hasn't been used yet
    const payment = monthTransactions.find(
      (tx) =>
        Math.abs(parseFloat(tx.transactionAmount.amount) - amount) < 0.01 &&
        !usedTransactionIds.has(tx.transactionId)
    );

    if (payment) {
      usedTransactionIds.add(payment.transactionId);
    }

    return {
      amount,
      label,
      paid: !!payment,
      date: payment ? payment.bookingDate : null,
      description: payment ? payment.remittanceInformationUnstructured : null,
      payer: payment?.debtorName || payment?.creditorName || "Unknown",
      transactionId: payment?.transactionId,
    };
  });

  return rentStatus;
}

function getMonthName(month) {
  return new Date(2000, month, 1).toLocaleString("en-US", { month: "long" });
}

function parseCliOptions(argv) {
  const options = {
    useLocal: false,
    accountAlias: null,
    accountId: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--local") {
      options.useLocal = true;
      continue;
    }

    if (arg === "--account" || arg === "-a") {
      options.accountAlias = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg.startsWith("--account=")) {
      options.accountAlias = arg.split("=")[1] || null;
      continue;
    }

    if (arg === "--account-id") {
      options.accountId = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg.startsWith("--account-id=")) {
      options.accountId = arg.split("=")[1] || null;
      continue;
    }
  }

  return options;
}

async function resolveAccountIdFromIban(service, requisitionId, targetIban) {
  const normalizedTargetIban = normalizeIban(targetIban);

  if (!normalizedTargetIban) {
    throw new Error(
      "Active account configuration requires an IBAN when accountId is not provided"
    );
  }

  const accounts = await service.getRequisitionAccounts(requisitionId);

  if (!accounts.length) {
    throw new Error(
      `No accounts returned for requisition ${requisitionId}. Check consent status.`
    );
  }

  for (const accountId of accounts) {
    const details = await service.getAccountDetails(accountId);
    const candidateIban = normalizeIban(extractIban(details));

    if (candidateIban === normalizedTargetIban) {
      return accountId;
    }
  }

  throw new Error(
    `No account with IBAN ${targetIban} found for requisition ${requisitionId}`
  );
}

async function resolveAccountSelection(
  service,
  useLocalFile,
  selectionOverrides = {}
) {
  const aliasOverride = selectionOverrides.alias || null;
  const accountIdOverride = selectionOverrides.accountId || null;
  const requisitionOverride = selectionOverrides.requisitionId || null;
  const ibanOverride = selectionOverrides.iban || null;

  if (accountIdOverride) {
    return {
      alias: aliasOverride,
      accountId: accountIdOverride,
      requisitionId: requisitionOverride,
      iban: ibanOverride,
    };
  }

  const activeAccount = getActiveAccountConfig(aliasOverride);

  if (useLocalFile) {
    return {
      alias: activeAccount?.alias || null,
      accountId: null,
      requisitionId: activeAccount?.requisitionId || null,
      iban: activeAccount?.iban || null,
    };
  }

  if (activeAccount) {
    if (activeAccount.accountId) {
      return {
        alias: activeAccount.alias,
        accountId: activeAccount.accountId,
        requisitionId: activeAccount.requisitionId || null,
        iban: activeAccount.iban || null,
      };
    }

    if (!activeAccount.requisitionId) {
      throw new Error(
        `Account "${activeAccount.alias}" is missing requisitionId in GOCARDLESS_ACCOUNTS`
      );
    }

    const accountId = await resolveAccountIdFromIban(
      service,
      activeAccount.requisitionId,
      activeAccount.iban
    );

    return {
      alias: activeAccount.alias,
      accountId,
      requisitionId: activeAccount.requisitionId,
      iban: activeAccount.iban,
    };
  }

  const fallbackAccountId = process.env.GOCARDLESS_ACCOUNT_ID;

  if (fallbackAccountId) {
    return { alias: null, accountId: fallbackAccountId };
  }

  throw new Error(
    "Configure GOCARDLESS_ACCOUNTS/GOCARDLESS_ACTIVE_ACCOUNT or set GOCARDLESS_ACCOUNT_ID"
  );
}

async function main() {
  try {
    // Get mode from command line argument
    const cliOptions = parseCliOptions(process.argv.slice(2));
    const useLocalFile = cliOptions.useLocal;
    console.log(
      `Starting rent payment check in ${
        useLocalFile ? "local" : "API"
      } mode...\n`
    );

    const service = new BankDataService(useLocalFile);
    await service.initialize();

    const accountSelection = await resolveAccountSelection(service, useLocalFile, {
      alias: cliOptions.accountAlias,
      accountId: cliOptions.accountId,
    });
    const accountId = accountSelection.accountId;

    if (!useLocalFile) {
      const descriptor = accountSelection.alias
        ? `${accountSelection.alias} (${accountSelection.iban || accountId})`
        : accountId;
      console.log(`Using account ${descriptor}`);
    }

    // Calculate dates for last 3 months
    const currentDate = new Date();
    const threeMonthsAgo = new Date(currentDate);
    threeMonthsAgo.setMonth(currentDate.getMonth() - 3);

    const dateFrom = threeMonthsAgo.toISOString().split("T")[0];
    const dateTo = currentDate.toISOString().split("T")[0];

    const transactionsData = await service.getAccountTransactions(
      accountId,
      dateFrom,
      dateTo
    );

    if (!transactionsData.transactions?.booked) {
      console.log("No transactions found");
      return;
    }

    // Get current date for summary
    const currentMonth = currentDate.getMonth();
    const currentYear = currentDate.getFullYear();

    // Check last 3 months
    console.log("\n=== Rent Payment Summary for Last 3 Months ===\n");
    for (let i = 0; i < 3; i++) {
      const checkMonth = currentMonth - i;
      const checkYear = currentYear + Math.floor(checkMonth / 12);
      const normalizedMonth = ((checkMonth % 12) + 12) % 12;

      const monthName = getMonthName(normalizedMonth);
      const rentStatus = checkRentPayments(
        transactionsData.transactions.booked,
        normalizedMonth,
        checkYear
      );

      console.log(`${monthName} ${checkYear}:`);
      rentStatus.forEach((status) => {
        const statusSymbol = status.paid ? "✅" : "❌";
        const labelInfo = status.label ? ` (${status.label})` : "";
        const dateInfo = status.date ? ` paid on ${status.date}` : "";
        const payerInfo = status.payer ? ` by ${status.payer}` : "";
        console.log(`${statusSymbol} €${status.amount}${labelInfo}${dateInfo}${payerInfo}`);
      });
      console.log(""); // Empty line between months
    }
  } catch (error) {
    console.error("Main process failed:", error.message);
  }
}

main();
