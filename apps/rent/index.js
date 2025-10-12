#!/usr/bin/env node
const fs = require("fs").promises;
const path = require("path");

const { getLatestStatements } = require("../../core/snapshot-store");
const rentConfig = require("./rent-config");

function parseArgs(argv) {
  const options = {
    file: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--file" || arg === "-f") {
      options.file = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--file=")) {
      options.file = arg.split("=")[1];
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
  }

  return options;
}

function getMonthRange(anchorDate, offset) {
  const anchor = new Date(anchorDate);
  anchor.setDate(1);
  anchor.setHours(0, 0, 0, 0);
  anchor.setMonth(anchor.getMonth() - offset);

  const start = new Date(anchor);
  const end = new Date(anchor);
  end.setMonth(end.getMonth() + 1);
  end.setMilliseconds(-1);

  return { start, end };
}

function toIsoDate(date) {
  return date.toISOString().split("T")[0];
}

function analysePayments(transactions = []) {
  const tolerance = rentConfig.amountTolerance ?? 0.01;
  const expected = rentConfig.expectedPayments || [];

  const now = new Date();
  const months = rentConfig.monthsToCheck || 3;

  const summary = [];

  for (let i = 0; i < months; i += 1) {
    const { start, end } = getMonthRange(now, i);
    const monthLabel = start.toLocaleString("en-US", { month: "long", year: "numeric" });

    const monthTxs = transactions.filter((transaction) => {
      const bookingDate = new Date(transaction.bookingDate);
      return (
        bookingDate >= start &&
        bookingDate <= end &&
        parseFloat(transaction.transactionAmount?.amount || 0) > 0
      );
    });

    const used = new Set();
    const statuses = expected.map((expectedPayment) => {
      const targetAmount = expectedPayment.amount;
      const match = monthTxs.find((tx) => {
        const amount = parseFloat(tx.transactionAmount?.amount || 0);
        const id = tx.transactionId;
        return (
          Math.abs(amount - targetAmount) <= tolerance &&
          !used.has(id)
        );
      });

      if (match) {
        used.add(match.transactionId);
      }

      return {
        ...expectedPayment,
        paid: Boolean(match),
        bookingDate: match?.bookingDate || null,
        counterpart: match?.debtorName || match?.creditorName || null,
        remittance: match?.remittanceInformationUnstructured || null,
      };
    });

    summary.push({
      month: monthLabel,
      periodStart: toIsoDate(start),
      periodEnd: toIsoDate(end),
      statuses,
    });
  }

  return summary;
}

async function loadStatements(filePath) {
  if (filePath) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    const content = await fs.readFile(resolved, "utf8");
    return { data: JSON.parse(content), location: resolved };
  }

  const latest = await getLatestStatements();
  if (!latest) {
    throw new Error(
      "No statements available. Run node apps/fetch-statements.js to fetch or provide --file."
    );
  }

  const content = await fs.readFile(latest, "utf8");
  return { data: JSON.parse(content), location: latest };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`Usage: node ${path.relative(
      process.cwd(),
      __filename
    )} [--file <statements.json>]

Reads the latest saved statements (or the provided JSON file) and checks rent payments
against the expectations defined in apps/rent/rent-config.js.
`);
    return;
  }

  const { data, location } = await loadStatements(options.file);
  const booked = data?.transactions?.transactions?.booked || [];

  const summary = analysePayments(booked);

  console.log(`Analysing statements from ${location}`);
  summary.forEach((monthSummary) => {
    console.log(`\n${monthSummary.month} (${monthSummary.periodStart} -> ${monthSummary.periodEnd})`);
    monthSummary.statuses.forEach((status) => {
      const prefix = status.paid ? "✅" : "❌";
      const details = [];
      details.push(`€${status.amount.toFixed(2)} - ${status.label}`);
      if (status.bookingDate) {
        details.push(`paid on ${status.bookingDate}`);
      }
      if (status.counterpart) {
        details.push(`by ${status.counterpart}`);
      }
      console.log(`${prefix} ${details.join(" ")}`);
    });
  });
}

main().catch((error) => {
  console.error("Rent analysis failed:");
  console.error(error.message);
  process.exitCode = 1;
});
