#!/usr/bin/env node
/**
 * Analyse Invoice Ninja SQL dump against bank statements.
 *
 * Usage: node apps/invoiceninja/reconcile-payments.js --sql "ninja-2025-10-10 19_37_48.sql"
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_SQL = "ninja-2025-10-10 19_37_48.sql";
const STATEMENTS_INDEX =
  process.env.OPERATIONS_INDEX_PATH ||
  path.join(__dirname, "..", "..", "data", "statements", "pdf", "operations-index.json");

function parseArgs(argv) {
  const options = {
    sql: DEFAULT_SQL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--sql") {
      options.sql = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--sql=")) {
      options.sql = arg.split("=")[1];
    }
  }

  return options;
}

function readFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return fs.readFileSync(resolved, "utf8");
}

function splitRows(insertBlock) {
  const valuesPart = insertBlock.substring(
    insertBlock.indexOf("VALUES") + "VALUES".length
  );
  const trimmed = valuesPart.trim();
  const withoutTrailingSemicolon = trimmed.endsWith(";")
    ? trimmed.slice(0, -1)
    : trimmed;

  const rows = [];
  let buffer = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < withoutTrailingSemicolon.length; i += 1) {
    const char = withoutTrailingSemicolon[i];
    const nextChar = withoutTrailingSemicolon[i + 1];

    if (char === "'" && (i === 0 || withoutTrailingSemicolon[i - 1] !== "\\")) {
      inString = !inString;
      buffer += char;
      continue;
    }

    if (!inString) {
      if (char === "(") {
        depth += 1;
        buffer += char;
        continue;
      }
      if (char === ")") {
        depth -= 1;
        buffer += char;
        if (depth === 0) {
          rows.push(buffer.trim());
          buffer = "";
          if (nextChar === ",") {
            i += 1;
          }
        }
        continue;
      }
    }

    buffer += char;
  }

  return rows;
}

function parseRow(row) {
  const inner = row.trim().replace(/^\(/, "").replace(/\)$/, "");
  const values = [];
  let token = "";
  let inString = false;

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    const prev = inner[i - 1];

    if (char === "'" && prev !== "\\") {
      inString = !inString;
      token += char;
      continue;
    }

    if (!inString && char === ",") {
      values.push(token.trim());
      token = "";
      continue;
    }

    token += char;
  }

  if (token.length) {
    values.push(token.trim());
  }

  return values.map((value) => {
    if (value === "NULL") {
      return null;
    }

    if (value.startsWith("'") && value.endsWith("'")) {
      const unquoted = value.slice(1, -1).replace(/\\'/g, "'");
      return unquoted;
    }

    if (value === "") {
      return "";
    }

    if (!Number.isNaN(Number(value))) {
      return Number(value);
    }

    return value;
  });
}

function buildRecords(rows, fields) {
  return rows.map((row) => {
    const parsed = parseRow(row);
    const record = {};
    fields.forEach((field, index) => {
      record[field] = parsed[index];
    });
    return record;
  });
}

function parseTable(sqlContent, tableName) {
  const regex = new RegExp(
    "INSERT INTO `" + tableName + "`\\s*\\(([^)]*)\\)\\s*VALUES([\\s\\S]*?);",
    "g"
  );

  const records = [];
  let match;

  while ((match = regex.exec(sqlContent)) !== null) {
    const block = match[0];
    const fieldsRaw = match[1];
    const fields = fieldsRaw
      .split(",")
      .map((field) => field.trim().replace(/`/g, ""));

    const rows = splitRows(block);
    records.push(...buildRecords(rows, fields));
  }

  if (!records.length) {
    throw new Error(`Insert blocks for table ${tableName} not found`);
  }

  return records;
}

function loadStatements(indexPath) {
  const resolved = path.resolve(indexPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Statements index not found at ${resolved}. Run the importer first.`
    );
  }
  const data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Array.isArray(data.operations) ? data.operations : [];
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function diffDays(dateA, dateB) {
  if (!dateA || !dateB) {
    return null;
  }
  const a = new Date(dateA);
  const b = new Date(dateB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    return null;
  }
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

function findMatches(payment, operations) {
  const amount = roundCurrency(payment.amount || 0);
  const paymentDate = payment.payment_date;
  const matches = operations
    .filter(
      (operation) =>
        operation &&
        operation.amount !== null &&
        roundCurrency(Number(operation.amount)) === amount
    )
    .map((operation) => ({
      statementId: operation.statementId,
      sequence: operation.sequence,
      bookingDate: operation.bookingDate || operation.valueDate,
      communication: operation.communication || "",
      counterpartyName: operation.counterpartyName || "",
      counterpartyAccount: operation.counterpartyAccount || "",
      bankReference: operation.bankReference || "",
      dateDelta: diffDays(operation.bookingDate || operation.valueDate, paymentDate),
    }))
    .filter((match) => {
      if (match.dateDelta === null) {
        return true;
      }
      return Math.abs(match.dateDelta) <= 365;
    });

  matches.sort((a, b) => {
    const ad = a.dateDelta === null ? Number.MAX_SAFE_INTEGER : Math.abs(a.dateDelta);
    const bd = b.dateDelta === null ? Number.MAX_SAFE_INTEGER : Math.abs(b.dateDelta);
    if (ad !== bd) return ad - bd;
    if (a.statementId !== b.statementId) {
      return String(a.statementId).localeCompare(String(b.statementId));
    }
    return String(a.sequence).localeCompare(String(b.sequence));
  });

  return matches.slice(0, 5);
}

function summariseBankTransfers(payments, operations, invoiceMap) {
  const results = [];
  payments.forEach((payment) => {
    const matches = findMatches(payment, operations);
    results.push({
      payment,
      invoice: invoiceMap.get(payment.invoice_id) || null,
      matches,
    });
  });
  return results;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sqlContent = readFile(options.sql);

  const payments = parseTable(sqlContent, "payments");
  const invoices = parseTable(sqlContent, "invoices");
  const operations = loadStatements(STATEMENTS_INDEX);

  const invoiceMap = new Map(invoices.map((invoice) => [invoice.id, invoice]));

  const bankTransfers = payments.filter(
    (payment) =>
      payment.payment_type_id === 2 &&
      payment.is_deleted === 0 &&
      payment.deleted_at === null &&
      (payment.credit_ids === null ||
        payment.credit_ids === "" ||
        payment.credit_ids.toString().trim() === "")
  );

  const summaries = summariseBankTransfers(
    bankTransfers,
    operations,
    invoiceMap
  );

  const unpaidInvoices = invoices.filter(
    (invoice) =>
      invoice &&
      (invoice.is_deleted === 0 || invoice.is_deleted === null) &&
      invoice.deleted_at === null &&
      Number(invoice.balance || 0) > 0.009
  );

  const unpaidSummary = unpaidInvoices.map((invoice) => {
    const amount = roundCurrency(Number(invoice.amount || 0));
    const matches = operations
      .filter(
        (operation) =>
          operation &&
          roundCurrency(Number(operation.amount)) === amount
      )
      .map((operation) => ({
        statementId: operation.statementId,
        sequence: operation.sequence,
        bookingDate: operation.bookingDate || operation.valueDate,
        amount: roundCurrency(Number(operation.amount)),
        communication: operation.communication || "",
        bankReference: operation.bankReference || "",
      }))
      .filter((match) => {
        const delta = diffDays(match.bookingDate, invoice.due_date || invoice.invoice_date);
        if (delta === null) {
          return true;
        }
        return Math.abs(delta) <= 365;
      });

    return {
      invoice,
      invoiceNumber: invoice.invoice_number,
      amount,
      matches: matches.slice(0, 5),
    };
  });

  console.log(
    JSON.stringify(
      {
        bankTransfers: summaries,
        unpaidInvoices: unpaidSummary,
      },
      null,
      2
    )
  );
}

main();
