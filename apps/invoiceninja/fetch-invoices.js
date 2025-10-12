#!/usr/bin/env node
require("dotenv").config();

const axios = require("axios");

const STATUS_LABELS = {
  1: "Draft",
  2: "Sent",
  3: "Viewed",
  4: "Approved",
  5: "Partial",
  6: "Paid",
};

function parseArgs(argv) {
  const options = {
    page: 1,
    perPage: 50,
    status: null,
    raw: false,
    insecure: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--page") {
      options.page = Number(argv[i + 1] || options.page);
      i += 1;
      continue;
    }

    if (arg.startsWith("--page=")) {
      options.page = Number(arg.split("=")[1]);
      continue;
    }

    if (arg === "--per-page") {
      options.perPage = Number(argv[i + 1] || options.perPage);
      i += 1;
      continue;
    }

    if (arg.startsWith("--per-page=")) {
      options.perPage = Number(arg.split("=")[1]);
      continue;
    }

    if (arg === "--status") {
      options.status = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg.startsWith("--status=")) {
      options.status = arg.split("=")[1] || null;
      continue;
    }

    if (arg === "--raw") {
      options.raw = true;
      continue;
    }

    if (arg === "--insecure") {
      options.insecure = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
  }

  return options;
}

function printHelp() {
  console.log("Usage: node apps/invoiceninja/fetch-invoices.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --page <number>        Page number to fetch (default: 1)");
  console.log("  --per-page <number>    Items per page (default: 50)");
  console.log("  --status <id>          Filter by status_id (as defined by Invoice Ninja)");
  console.log("  --raw                  Print full JSON payload");
  console.log("  --insecure             Skip TLS certificate verification (self-hosted only)");
  console.log("  -h, --help             Show this help message");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const apiToken = process.env.INVOICE_NINJA_KEY;
  if (!apiToken) {
    console.error(
      "Missing INVOICE_NINJA_KEY in environment; update your .env before running this script"
    );
    process.exit(1);
  }

  const baseUrl =
    (process.env.INVOICE_NINJA_BASE_URL || "https://ninja.lizoria.com").replace(
      /\/$/,
      ""
    );

  const params = {
    page: options.page,
    per_page: options.perPage,
    include: "client",
  };

  if (options.status) {
    params.status_id = options.status;
  }

  const https = require("https");
  const httpsAgent =
    options.insecure || process.env.INVOICE_NINJA_ALLOW_INSECURE === "1"
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;

  try {
    const response = await axios.get(`${baseUrl}/api/v1/invoices`, {
      params,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        "X-API-TOKEN": apiToken,
        "X-Ninja-Token": apiToken,
        Authorization: `Bearer ${apiToken}`,
      },
      httpsAgent,
      timeout: 15000,
    });

    const payload = response.data || {};
    const invoices = Array.isArray(payload.data) ? payload.data : [];

    if (options.raw) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    const pagination =
      payload.meta && payload.meta.pagination ? payload.meta.pagination : null;

    console.log(
      `Fetched ${invoices.length} invoices from ${baseUrl} (page ${
        pagination ? pagination.current_page : options.page
      } of ${pagination ? pagination.total_pages : "?"}).`
    );

    invoices.forEach((invoice) => {
      const client = invoice?.client?.display_name || invoice?.client?.name;
      const statusId = invoice?.invoice_status_id || invoice?.status_id;
      const status =
        STATUS_LABELS[statusId] ||
        invoice?.status ||
        (statusId !== undefined ? `status:${statusId}` : "unknown");
      const amount =
        invoice?.amount !== undefined ? Number(invoice.amount).toFixed(2) : "?";
      const balance =
        invoice?.balance !== undefined
          ? Number(invoice.balance).toFixed(2)
          : "?";

      console.log(
        `- #${invoice?.number || invoice?.id} (${status}) • amount ${amount} • balance ${balance}${
          client ? ` • client ${client}` : ""
        }`
      );
    });
  } catch (error) {
    if (error.response) {
      console.error(
        `Invoice Ninja API error ${error.response.status}:`,
        error.response.data && error.response.data.message
          ? error.response.data.message
          : error.response.data || error.message
      );
    } else if (error.request) {
      console.error(
        "No response received from Invoice Ninja API:",
        error.message
      );
    } else {
      console.error("Unexpected error while calling Invoice Ninja API:", error);
    }
    process.exit(1);
  }
}

main();
