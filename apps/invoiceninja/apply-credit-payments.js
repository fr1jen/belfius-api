#!/usr/bin/env node
require("dotenv").config();

const axios = require("axios");
const https = require("https");

const {
  roundCurrency,
  resolveInvoiceBalance,
  createPayment,
} = require("./lib/invoice-payments");

function parseArgs(argv) {
  const options = {
    pairs: [],
    apply: false,
    insecure: process.env.INVOICE_NINJA_ALLOW_INSECURE === "1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--apply") {
      options.apply = true;
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

    if (!arg.startsWith("--")) {
      const parsed = parsePair(arg);
      if (!parsed) {
        console.error(`Invalid pair format "${arg}". Use invoiceNumber=creditNumber.`);
        process.exit(1);
      }
      options.pairs.push(parsed);
    }
  }

  if (options.pairs.length === 0) {
    console.error(
      "Provide at least one pair (invoiceNumber=creditNumber). Example: node apps/invoiceninja/apply-credit-payments.js 180784=110062"
    );
    process.exit(1);
  }

  return options;
}

function printHelp() {
  console.log("Usage: node apps/invoiceninja/apply-credit-payments.js [options] invoice=credit [invoice=credit...]");
  console.log("");
  console.log("Options:");
  console.log("  --apply        Execute the API calls (default: dry-run)");
  console.log("  --insecure     Skip TLS verification (self-hosted instances)");
  console.log("  -h, --help     Show this help message");
}

function parsePair(token) {
  const separator = token.includes("=") ? "=" : token.includes(":") ? ":" : null;
  if (!separator) {
    return null;
  }

  const [invoiceNumber, creditNumber] = token.split(separator);
  if (!invoiceNumber || !creditNumber) {
    return null;
  }

  return {
    invoiceNumber: invoiceNumber.trim(),
    creditNumber: creditNumber.trim(),
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function fetchInvoice({ baseUrl, token, invoiceNumber, httpsAgent }) {
  const response = await axios.get(
    `${baseUrl}/api/v1/invoices?invoice_number=${encodeURIComponent(invoiceNumber)}&include=client`,
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
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    return null;
  }
  return payload.data[0];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const token = requireEnv("INVOICE_NINJA_KEY");
  const baseUrl = (process.env.INVOICE_NINJA_BASE_URL || "https://ninja.lizoria.com").replace(/\/$/, "");
  const paymentDate = new Date().toISOString().split("T")[0];

  const httpsAgent =
    options.insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined;

  for (const pair of options.pairs) {
    const { invoiceNumber, creditNumber } = pair;
    console.log(`Invoice ${invoiceNumber}: applying credit note ${creditNumber}`);

    let invoice;
    try {
      invoice = await fetchInvoice({
        baseUrl,
        token,
        invoiceNumber,
        httpsAgent,
      });
    } catch (error) {
      console.error(`  !! Failed to fetch invoice ${invoiceNumber}:`, error.message);
      continue;
    }

    if (!invoice) {
      console.error(`  !! Invoice ${invoiceNumber} not found; skipping.`);
      continue;
    }

    const invoiceBalance = roundCurrency(resolveInvoiceBalance(invoice));
    const amountToApply = invoiceBalance;

    if (amountToApply <= 0) {
      console.log(
        `  -> No outstanding balance to clear (invoice balance €${invoiceBalance.toFixed(2)}); skipping.`
      );
      continue;
    }

    const paymentNote = `Paid by credit note ${creditNumber}`;
    const paymentPayload = {
      client_id: invoice.client_id,
      invoice_id: invoice.id,
      amount: amountToApply,
      payment_date: paymentDate,
      payment_type_id: 2,
      transaction_reference: `Credit note ${creditNumber}`,
      private_notes: paymentNote,
    };

    if (!options.apply) {
      console.log(
        `  -> Dry-run: would create payment dated ${paymentDate} for €${amountToApply.toFixed(
          2
        )} (${paymentNote})`
      );
      continue;
    }

    try {
      const payment = await createPayment({
        baseUrl,
        token,
        payload: paymentPayload,
        httpsAgent,
      });

      if (payment && payment.id) {
        console.log(
          `  -> Created payment ${payment.id} applying €${amountToApply.toFixed(
            2
          )} from credit note ${creditNumber}`
        );
      } else {
        console.log(
          `  -> Payment created for invoice ${invoiceNumber}, response: ${JSON.stringify(payment)}`
        );
      }
    } catch (error) {
      if (error.response) {
        console.error(
          `  !! Failed to create payment for invoice ${invoiceNumber}:`,
          error.response.status,
          JSON.stringify(error.response.data)
        );
      } else {
        console.error(
          `  !! Failed to create payment for invoice ${invoiceNumber}:`,
          error.message
        );
      }
    }
  }
}

main().catch((error) => {
  console.error("apply-credit-payments failed:", error);
  process.exit(1);
});
