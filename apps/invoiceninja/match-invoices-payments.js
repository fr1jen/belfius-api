#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const https = require("https");

const STATUS_LABELS = {
  1: "Draft",
  2: "Sent",
  3: "Viewed",
  4: "Approved",
  5: "Partial",
  6: "Paid",
};

const OPEN_STATUS_IDS = new Set([1, 2, 3, 4, 5]);
const MAX_DATE_DIFF_DAYS = Number(
  process.env.INVOICE_MATCH_MAX_DAYS || 120
);

function parseOptions(argv) {
  const opts = {
    perPage: Number(process.env.INVOICE_FETCH_PER_PAGE || 200),
    insecure:
      process.env.INVOICE_NINJA_ALLOW_INSECURE === "1" ? true : false,
    verbose: false,
    since: process.env.INVOICE_MATCH_SINCE || null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--per-page") {
      opts.perPage = Number(argv[i + 1] || opts.perPage);
      i += 1;
      continue;
    }

    if (arg.startsWith("--per-page=")) {
      opts.perPage = Number(arg.split("=")[1]);
      continue;
    }

    if (arg === "--insecure") {
      opts.insecure = true;
      continue;
    }

    if (arg === "--verbose") {
      opts.verbose = true;
      continue;
    }

    if (arg === "--since") {
      opts.since = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg.startsWith("--since=")) {
      opts.since = arg.split("=")[1] || null;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node apps/invoiceninja/match-invoices-payments.js [options]");
  console.log("");
  console.log("Options:");
  console.log(
    "  --per-page <number>    Invoices per API page (default: 200)"
  );
  console.log(
    "  --insecure             Skip TLS verification (self-hosted only)"
  );
  console.log("  --verbose              Show detailed match candidates");
  console.log(
    "  --since <YYYY-MM-DD>   Limit invoices with invoice_date on/after this date"
  );
  console.log("  -h, --help             Show this help message");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function sanitize(str) {
  return (str || "").toString().trim();
}

function normalize(str) {
  return sanitize(str).replace(/\s+/g, "").toUpperCase();
}

function tokenize(str) {
  return sanitize(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function diffDays(a, b) {
  if (!a || !b) {
    return Infinity;
  }
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs((a.getTime() - b.getTime()) / msPerDay);
}

async function fetchAllInvoices({
  baseUrl,
  token,
  perPage,
  insecure,
}) {
  const invoices = [];
  let currentPage = 1;
  let totalPages = 1;

  const httpsAgent = insecure
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

  while (currentPage <= totalPages) {
    const params = {
      page: currentPage,
      per_page: perPage,
      include: "client",
    };

    const response = await axios.get(`${baseUrl}/api/v1/invoices`, {
      params,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        "X-API-TOKEN": token,
        "X-Ninja-Token": token,
        Authorization: `Bearer ${token}`,
      },
      timeout: 20000,
      httpsAgent,
    });

    const payload = response.data || {};
    const pageData = Array.isArray(payload.data) ? payload.data : [];
    const pagination =
      payload.meta && payload.meta.pagination
        ? payload.meta.pagination
        : null;

    invoices.push(
      ...pageData.filter((invoice) => {
        const statusId =
          invoice.invoice_status_id || invoice.status_id || 0;
        const balance = parseNumber(invoice.balance);
        return (
          OPEN_STATUS_IDS.has(statusId) &&
          balance !== null &&
          balance > 0.0001
        );
      })
    );

    if (pagination) {
      totalPages = pagination.total_pages || totalPages;
    } else {
      totalPages = currentPage;
    }

    currentPage += 1;
  }

  return invoices;
}

function loadOperations(indexPath) {
  const resolvedPath = path.resolve(indexPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Statements index not found at ${resolvedPath}. Run the importer first.`
    );
  }

  const data = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  const operations = Array.isArray(data.operations)
    ? data.operations
    : [];

  return operations
    .filter(
      (operation) =>
        sanitize(operation.direction).toLowerCase() === "credit" &&
        operation.amount !== null &&
        operation.amount !== undefined
    )
    .map((operation) => ({
      ...operation,
      amount: Number(operation.amount),
      bookingDate: operation.bookingDate || operation.valueDate || null,
    }));
}

function buildReferenceString(operation) {
  return normalize(
    [
      operation.communication,
      operation.orderReference,
      operation.bankReference,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function computeNameScore(invoiceClientName, counterpartyName) {
  if (!invoiceClientName || !counterpartyName) {
    return 0;
  }

  const invoiceTokens = new Set(tokenize(invoiceClientName));
  const counterTokens = tokenize(counterpartyName);

  if (!invoiceTokens.size || !counterTokens.length) {
    return 0;
  }

  let matches = 0;
  counterTokens.forEach((token) => {
    if (invoiceTokens.has(token)) {
      matches += 1;
    }
  });

  return matches;
}

function computeConfidence({ daysDiff, refScore, nameScore, targetLabel }) {
  let score = 50;

  if (typeof daysDiff === "number") {
    if (daysDiff <= 2) {
      score += 30;
    } else if (daysDiff <= 7) {
      score += 25;
    } else if (daysDiff <= 14) {
      score += 22;
    } else if (daysDiff <= 30) {
      score += 15;
    } else if (daysDiff <= 60) {
      score += 10;
    } else if (daysDiff <= 90) {
      score += 6;
    } else if (daysDiff <= 120) {
      score += 4;
    } else {
      score += 1;
      score -= Math.min(10, Math.max(0, daysDiff - 120) * 0.1);
    }
  } else {
    score += 5;
  }

  if (refScore >= 3) {
    score += 15;
  } else if (refScore === 2) {
    score += 12;
  } else if (refScore === 1) {
    score += 8;
  }

  if (nameScore >= 3) {
    score += 10;
  } else if (nameScore === 2) {
    score += 8;
  } else if (nameScore === 1) {
    score += 6;
  } else if (nameScore === 0) {
    score -= 2;
  }

  if (targetLabel && targetLabel.toLowerCase().includes("partial")) {
    score -= 5;
  }

  return Math.max(10, Math.min(99, Math.round(score)));
}

function findMatchesForInvoice(invoice, operations) {
  const amount = parseNumber(invoice.amount) || 0;
  const balance = parseNumber(invoice.balance) || 0;
  const paidAmount = amount - balance;

  const invoiceDate =
    parseDate(invoice.invoice_date) ||
    parseDate(invoice.due_date) ||
    null;

  const invoiceNumber = sanitize(invoice.invoice_number || invoice.number);
  const invoiceNumberDigits = invoiceNumber
    ? invoiceNumber.replace(/\D+/g, "")
    : "";

  const clientName =
    (invoice.client && (invoice.client.display_name || invoice.client.name)) ||
    "";

  const targets = [];
  if (amount > 0) {
    targets.push({ value: roundCurrency(amount), label: "invoice amount" });
  }
  if (paidAmount > 0.01) {
    targets.push({
      value: roundCurrency(paidAmount),
      label: "recorded partial payment",
    });
  }

  const seenOperationIds = new Set();
  const candidates = [];

  targets.forEach((target) => {
    operations.forEach((operation) => {
      const opAmount = roundCurrency(operation.amount);
      if (Math.abs(opAmount - target.value) > 0.001) {
        return;
      }

      const operationKey = `${operation.statementId}:${operation.sequence || operation.bankReference || operation.bookingDate}:${target.label}`;
      if (seenOperationIds.has(operationKey)) {
        return;
      }

      const bookingDate = parseDate(operation.bookingDate);
      const days = diffDays(invoiceDate, bookingDate);
      if (days > MAX_DATE_DIFF_DAYS) {
        return;
      }

      const referenceString = buildReferenceString(operation);

      let refScore = 0;
      if (invoiceNumberDigits && referenceString.includes(invoiceNumberDigits)) {
        refScore = 3;
      } else if (invoiceNumber && referenceString.includes(normalize(invoiceNumber))) {
        refScore = 2;
      }

      const nameScore = computeNameScore(clientName, operation.counterpartyName);

      const candidate = {
        targetLabel: target.label,
        operation,
        daysDiff: days === Infinity ? null : days,
        refScore,
        nameScore,
      };

      candidate.confidence = computeConfidence(candidate);

      candidates.push(candidate);
      seenOperationIds.add(operationKey);
    });
  });

  candidates.sort((a, b) => {
    const dayA = a.daysDiff === null ? Number.MAX_SAFE_INTEGER : a.daysDiff;
    const dayB = b.daysDiff === null ? Number.MAX_SAFE_INTEGER : b.daysDiff;

    if (dayA !== dayB) {
      return dayA - dayB;
    }

    if (a.refScore !== b.refScore) {
      return b.refScore - a.refScore;
    }

    if (a.nameScore !== b.nameScore) {
      return b.nameScore - a.nameScore;
    }

    return 0;
  });

  return candidates.slice(0, 5);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));

  const token = requireEnv("INVOICE_NINJA_KEY");
  const baseUrl = (process.env.INVOICE_NINJA_BASE_URL || "https://ninja.lizoria.com").replace(/\/$/, "");

  const operationsIndex =
    process.env.OPERATIONS_INDEX_PATH ||
    path.join(__dirname, "..", "..", "data", "statements", "pdf", "operations-index.json");

  const operations = loadOperations(operationsIndex);

  if (!operations.length) {
    console.error("No credit operations found in statements index.");
    process.exit(1);
  }

  const invoices = await fetchAllInvoices({
    baseUrl,
    token,
    perPage: options.perPage,
    insecure: options.insecure,
  });

  const sinceDate = parseDate(options.since);
  const filteredInvoices = sinceDate
    ? invoices.filter((invoice) => {
        const invDate =
          parseDate(invoice.invoice_date) || parseDate(invoice.due_date);
        if (!invDate) {
          return false;
        }
        return invDate >= sinceDate;
      })
    : invoices;

  if (!filteredInvoices.length) {
    console.log("No open or partially paid invoices retrieved.");
    return;
  }

  let matchedCount = 0;

  filteredInvoices.forEach((invoice) => {
    const matches = findMatchesForInvoice(invoice, operations);
    if (!matches.length) {
      return;
    }

    matchedCount += 1;

    const statusId = invoice.invoice_status_id || invoice.status_id || 0;
    const status =
      STATUS_LABELS[statusId] || (statusId ? `status:${statusId}` : "unknown");

    const invoiceDateStr = invoice.invoice_date || invoice.date || "?";
    const dueDateStr = invoice.due_date || "?";

    console.log(
      `Invoice #${invoice.invoice_number || invoice.number || invoice.id} (${status}) • amount ${roundCurrency(
        invoice.amount || 0
      ).toFixed(2)} • balance ${roundCurrency(
        invoice.balance || 0
      ).toFixed(2)} • issued ${invoiceDateStr} • due ${dueDateStr}${
        invoice.client && (invoice.client.display_name || invoice.client.name)
          ? ` • client ${invoice.client.display_name || invoice.client.name}`
          : ""
      }`
    );

    matches.forEach((candidate, index) => {
      const op = candidate.operation;
      const parts = [
        `  ${index === 0 ? "-" : " "} match ${index + 1}:`,
        `${candidate.targetLabel}`,
        `statement ${op.statementId || "?"} seq ${op.sequence || "?"}`,
        `date ${op.bookingDate || "?"}`,
        `amount ${roundCurrency(op.amount).toFixed(2)}`,
      ];

      if (candidate.daysDiff !== null && candidate.daysDiff !== Infinity) {
        parts.push(`Δ ${Math.round(candidate.daysDiff)}d`);
      }

      if (candidate.confidence !== undefined) {
        parts.push(`confidence ${candidate.confidence}%`);
      }

      if (candidate.refScore > 0) {
        parts.push(`reference match`);
      }

      if (candidate.nameScore > 0) {
        parts.push(`name overlap ${candidate.nameScore}`);
      }

      console.log(parts.join(" • "));

      if (options.verbose) {
        console.log(
          `    counterparty: ${op.counterpartyName || "n/a"} (${op.counterpartyAccount || "?"})`
        );
        console.log(
          `    communication: ${sanitize(op.communication) || "n/a"}`
        );
      }
    });

    console.log("");
  });

  if (matchedCount === 0) {
    console.log(
      "No candidate payments found for unpaid or partially paid invoices."
    );
  }
}

main().catch((error) => {
  console.error("Failed to match invoices:", error.message);
  process.exit(1);
});
