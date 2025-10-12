#!/usr/bin/env node
require("dotenv").config();

const axios = require("axios");
const https = require("https");

const TARGET_INVOICES = [
  { number: "250004", paymentDate: "2025-04-04" },
  { number: "250001", paymentDate: "2025-01-04" },
  { number: "240010", paymentDate: "2024-07-04" },
  { number: "240005", paymentDate: "2024-04-04" },
  { number: "240002", paymentDate: "2024-01-04" },
  { number: "230025", paymentDate: "2023-10-04" },
  { number: "230022", paymentDate: "2023-07-04" },
  { number: "230011", paymentDate: "2023-04-04" },
  { number: "220059", paymentDate: "2022-10-04" },
  { number: "220049", paymentDate: "2022-07-04" },
  { number: "220038", paymentDate: "2022-04-04" },
];

function parseArgs(argv) {
  const options = {
    apply: false,
    invoice: null,
    insecure:
      process.env.INVOICE_NINJA_ALLOW_INSECURE === "1" ? true : false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--invoice") {
      options.invoice = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg.startsWith("--invoice=")) {
      options.invoice = arg.split("=")[1] || null;
      continue;
    }

    if (arg === "--insecure") {
      options.insecure = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log("Usage: node apps/invoiceninja/pay-invoices.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --apply            Actually create payments (default is dry-run)");
  console.log("  --invoice <number> Process only the given invoice number");
  console.log("  --insecure         Skip TLS verification for self-hosted instances");
  console.log("  -h, --help         Show this help message");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

async function fetchInvoice({ baseUrl, token, invoiceNumber, httpsAgent }) {
  const response = await axios.get(
    `${baseUrl}/api/v1/invoices?invoice_number=${encodeURIComponent(
      invoiceNumber
    )}&include=client`,
    {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        "X-API-TOKEN": token,
        "X-Ninja-Token": token,
        Authorization: `Bearer ${token}`,
      },
      httpsAgent,
      timeout: 20000,
    }
  );

  const payload = response.data || {};
  const invoice = Array.isArray(payload.data) ? payload.data[0] : null;
  return invoice || null;
}

async function createPayment({
  baseUrl,
  token,
  payload,
  httpsAgent,
}) {
  const response = await axios.post(
    `${baseUrl}/api/v1/payments`,
    payload,
    {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-TOKEN": token,
        "X-Ninja-Token": token,
        Authorization: `Bearer ${token}`,
      },
      httpsAgent,
      timeout: 20000,
    }
  );

  return response.data;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const token = requireEnv("INVOICE_NINJA_KEY");
  const baseUrl = (process.env.INVOICE_NINJA_BASE_URL || "https://ninja.lizoria.com").replace(/\/$/, "");

  const httpsAgent =
    options.insecure || process.env.INVOICE_NINJA_ALLOW_INSECURE === "1"
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;

  const targets = options.invoice
    ? TARGET_INVOICES.filter((entry) => entry.number === options.invoice)
    : TARGET_INVOICES;

  if (!targets.length) {
    console.error("No matching invoices found in target list.");
    process.exit(1);
  }

  for (const entry of targets) {
    const invoice = await fetchInvoice({
      baseUrl,
      token,
      invoiceNumber: entry.number,
      httpsAgent,
    });

    if (!invoice) {
      console.error(
        `Invoice ${entry.number} not found via API; skipping.`
      );
      continue;
    }

    const balance = roundCurrency(Number(invoice.balance || 0));
    const statusId = invoice.invoice_status_id || invoice.status_id || 0;
    const clientName =
      (invoice.client && (invoice.client.display_name || invoice.client.name)) ||
      "unknown client";

    console.log(
      `Invoice ${entry.number}: status ${statusId} • balance €${balance.toFixed(
        2
      )} • client ${clientName}`
    );

    if (balance <= 0.01) {
      console.log(
        `  -> balance already zero; skipping payment creation.`
      );
      continue;
    }

    const payload = {
      client_id: invoice.client_id,
      invoice_id: invoice.id,
      amount: balance,
      payment_date: entry.paymentDate,
      payment_type_id: 2,
      transaction_reference: `Auto payment ${entry.number}`,
    };

    if (options.apply) {
      try {
        const response = await createPayment({
          baseUrl,
          token,
          payload,
          httpsAgent,
        });

        const created = response && response.data ? response.data : null;
        if (created && created.id) {
          console.log(
            `  -> Created payment ${created.id} for invoice ${entry.number}`
          );
        } else {
          console.log(
            `  -> Payment created, response: ${JSON.stringify(response)}`
          );
        }
      } catch (error) {
        if (error.response) {
          console.error(
            `  !! API error (${error.response.status}) for invoice ${entry.number}:`,
            JSON.stringify(error.response.data)
          );
        } else if (error.request) {
          console.error(
            `  !! No response when creating payment for invoice ${entry.number}:`,
            error.message
          );
        } else {
          console.error(
            `  !! Unexpected error for invoice ${entry.number}:`,
            error.message
          );
        }
      }
    } else {
      console.log(
        `  -> Dry-run: would create payment with payload ${JSON.stringify(payload)}`
      );
    }
  }
}

main().catch((error) => {
  console.error("Failed to process payments:", error.message);
  process.exit(1);
});
