require("dotenv").config();
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");

const BASE_URL = "https://bankaccountdata.gocardless.com/api/v2";
const DEFAULT_INSTITUTION_ID = "BELFIUS_GKCCBEBB"; // Used unless env overrides
const SNAPSHOT_DIR = path.join(process.cwd(), "snapshots");

async function persistSnapshot(prefix, payload) {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  const filePath = path.join(
    SNAPSHOT_DIR,
    `${prefix}_${timestamp}_${Date.now()}.json`
  );
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\nSnapshot stored at: ${filePath}`);
}

class BankLinkService {
  constructor(institutionId) {
    this.accessToken = null;
    this.institutionId = institutionId;
  }

  async initialize() {
    try {
      const tokenResponse = await axios.post(`${BASE_URL}/token/new/`, {
        secret_id: process.env.GOCARDLESS_SECRET_ID,
        secret_key: process.env.GOCARDLESS_SECRET_KEY,
      });

      this.accessToken = tokenResponse.data.access;
      console.log("Successfully obtained access token");
      return this.accessToken;
    } catch (error) {
      console.error(
        "Error getting access token:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async createEndUserAgreement() {
    try {
      const response = await axios.post(
        `${BASE_URL}/agreements/enduser/`,
        {
          institution_id: this.institutionId,
          max_historical_days: "90",
          access_valid_for_days: "90",
          access_scope: ["balances", "details", "transactions"],
        },
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        }
      );

      console.log("Successfully created end user agreement");
      return response.data;
    } catch (error) {
      console.error(
        "Error creating agreement:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async createRequisition(agreementId) {
    try {
      const response = await axios.post(
        `${BASE_URL}/requisitions/`,
        {
          redirect: process.env.REDIRECT_URL,
          institution_id: this.institutionId,
          reference: `${this.institutionId
            .replace(/[^A-Za-z0-9]/g, "")
            .toLowerCase()}_${Date.now()}`,
          agreement: agreementId,
          user_language: "EN",
        },
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        }
      );

      console.log("Successfully created requisition");
      return response.data;
    } catch (error) {
      console.error(
        "Error creating requisition:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async getAccounts(requisitionId) {
    try {
      const response = await axios.get(
        `${BASE_URL}/requisitions/${requisitionId}/`,
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        }
      );
      return response.data.accounts;
    } catch (error) {
      console.error(
        "Error getting accounts:",
        error.response?.data || error.message
      );
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
      console.error(
        "Error getting account details:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async getAccountTransactions(accountId) {
    try {
      const response = await axios.get(
        `${BASE_URL}/accounts/${accountId}/transactions/`,
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        }
      );
      return response.data;
    } catch (error) {
      console.error(
        "Error getting transactions:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async getAccountBalances(accountId) {
    try {
      const response = await axios.get(
        `${BASE_URL}/accounts/${accountId}/balances/`,
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        }
      );
      return response.data;
    } catch (error) {
      console.error(
        "Error getting balances:",
        error.response?.data || error.message
      );
      throw error;
    }
  }
}

async function main() {
  try {
    const institutionId =
      process.env.GOCARDLESS_INSTITUTION_ID || DEFAULT_INSTITUTION_ID;

    if (!process.env.GOCARDLESS_INSTITUTION_ID) {
      console.log(
        "Using default institution ID; set GOCARDLESS_INSTITUTION_ID in .env to override."
      );
    }

    const service = new BankLinkService(institutionId);

    // Initialize and get access token
    await service.initialize();

    const shouldCreateConsent =
      process.argv.includes("--create-consent") ||
      !process.env.GOCARDLESS_REQUISITION_ID;

    if (shouldCreateConsent) {
      // Create end user agreement
      const agreement = await service.createEndUserAgreement();

      // Create requisition and get link
      const requisition = await service.createRequisition(agreement.id);

      console.log(
        "\nPlease open this link in your browser to connect your account:"
      );
      console.log(requisition.link);
      console.log("\nRequisition ID (store this in your .env as GOCARDLESS_REQUISITION_ID):");
      console.log(requisition.id);

      if (!process.env.GOCARDLESS_REQUISITION_ID) {
        console.log(
          "\nTip: re-run the script after updating GOCARDLESS_REQUISITION_ID to fetch account data."
        );
        return;
      }
    }

    const requisitionId = process.env.GOCARDLESS_REQUISITION_ID;

    if (!requisitionId) {
      console.log(
        "No GOCARDLESS_REQUISITION_ID set. Update your .env to continue beyond consent creation."
      );
      return;
    }

    // Get all accounts linked to the requisition
    const accounts = await service.getAccounts(requisitionId);
    console.log("\nFound accounts:", accounts);

    const snapshot = {
      fetchedAt: new Date().toISOString(),
      institutionId,
      requisitionId,
      accounts: [],
    };

    // For each account, get details, balances and transactions
    for (const accountId of accounts) {
      console.log(`\n=== Account ${accountId} ===`);

      const details = await service.getAccountDetails(accountId);
      console.log("\nAccount Details:", JSON.stringify(details, null, 2));

      const balances = await service.getAccountBalances(accountId);
      console.log("\nAccount Balances:", JSON.stringify(balances, null, 2));

      const transactions = await service.getAccountTransactions(accountId);
      console.log("\nTransactions:", JSON.stringify(transactions, null, 2));

      snapshot.accounts.push({
        accountId,
        details,
        balances,
        transactions,
      });
    }

    if (snapshot.accounts.length) {
      await persistSnapshot("account_snapshot", snapshot);
    }
  } catch (error) {
    console.error("Main process failed:", error.message);
  }
}

main();
