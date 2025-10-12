#!/usr/bin/env node
require("dotenv").config();

const axios = require("axios");
const https = require("https");

const {
  roundCurrency,
  resolveInvoiceBalance,
  resolveInvoiceTotal,
  resolveInvoiceGross,
  createPayment,
} = require("./lib/invoice-payments");

const DEFAULT_VAT_RATE = 0.21;

function parseArgs(argv) {
  const options = {
    invoiceNumbers: [],
    startNumber: 11055,
    apply: false,
    insecure: process.env.INVOICE_NINJA_ALLOW_INSECURE === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--start-number") {
      options.startNumber = Number(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg.startsWith("--start-number=")) {
      options.startNumber = Number(arg.split("=")[1]);
      continue;
    }

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
      options.invoiceNumbers.push(arg);
    }
  }

  if (options.invoiceNumbers.length === 0) {
    console.error("Provide at least one invoice number (e.g. node apps/invoiceninja/create-credit-notes.js 220006 220009)");
    process.exit(1);
  }

  return options;
}

function printHelp() {
  console.log("Usage: node apps/invoiceninja/create-credit-notes.js [options] <invoiceNumber> [invoiceNumber...]");
  console.log("");
  console.log("Options:");
  console.log("  --start-number <value>   First credit note number to assign (default: 11055)");
  console.log("  --apply                  Execute the API calls (default: dry-run)");
  console.log("  --insecure               Skip TLS verification (self-hosted instances)");
  console.log("  -h, --help               Show this help message");
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

async function cloneInvoice({ baseUrl, token, invoiceId, httpsAgent }) {
  const response = await axios.post(
    `${baseUrl}/api/v1/invoices/bulk`,
    {
      ids: [invoiceId],
      action: "clone",
    },
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

  if (
    response.data &&
    response.data.data &&
    Array.isArray(response.data.data) &&
    response.data.data.length > 0
  ) {
    return response.data.data[0];
  }

  return null;
}

async function createCreditInvoice({
  baseUrl,
  token,
  source,
  creditNumber,
  creditAmount,
  invoiceNetTotal,
  invoiceGrossTotal,
  today,
  httpsAgent,
}) {
  const sourceItems = Array.isArray(source.invoice_items) ? source.invoice_items : [];
  const desiredTotalGross = roundCurrency(creditAmount);

  const baseNetTotal = sourceItems.reduce((sum, item) => {
    const costNumber = Number(item.cost);
    const qtyNumber = Number.isFinite(Number(item.qty)) ? Number(item.qty) : 1;
    const qty = qtyNumber === 0 ? 1 : qtyNumber;
    const lineTotal = Math.abs(Number.isFinite(costNumber) ? costNumber : 0) * qty;
    return sum + lineTotal;
  }, 0);

  const referenceNetTotal =
    Number.isFinite(invoiceNetTotal) && invoiceNetTotal > 0 ? invoiceNetTotal : baseNetTotal;

  const fallbackGross =
    Number.isFinite(Number(source.amount)) && Number(source.amount) > 0
      ? Math.abs(Number(source.amount))
      : referenceNetTotal > 0
      ? referenceNetTotal * (1 + DEFAULT_VAT_RATE)
      : 0;

  const grossTotal =
    Number.isFinite(invoiceGrossTotal) && invoiceGrossTotal > 0
      ? invoiceGrossTotal
      : fallbackGross;

  const closeToFull =
    grossTotal > 0 ? Math.abs(desiredTotalGross - grossTotal) <= 0.01 : false;

  let ratioRaw = grossTotal > 0 ? desiredTotalGross / grossTotal : 1;
  if (!Number.isFinite(ratioRaw) || ratioRaw < 0) {
    ratioRaw = 0;
  }
  if (ratioRaw > 1 && !closeToFull) {
    ratioRaw = 1;
  }
  const effectiveRatio = closeToFull ? 1 : ratioRaw;

  let targetNetTotal;
  if (referenceNetTotal > 0) {
    targetNetTotal = roundCurrency(referenceNetTotal * effectiveRatio);
  } else if (grossTotal > 0) {
    targetNetTotal = roundCurrency(
      desiredTotalGross *
        (referenceNetTotal > 0 ? referenceNetTotal / grossTotal : 1 / (1 + DEFAULT_VAT_RATE))
    );
  } else {
    targetNetTotal = roundCurrency(desiredTotalGross / (1 + DEFAULT_VAT_RATE));
  }

  if ((!Number.isFinite(targetNetTotal) || targetNetTotal <= 0) && desiredTotalGross > 0) {
    targetNetTotal = roundCurrency(desiredTotalGross / (1 + DEFAULT_VAT_RATE));
  }

  const netRatio =
    referenceNetTotal > 0 ? Math.min(1, Math.max(0, targetNetTotal / referenceNetTotal)) : 1;
  const isPartial = referenceNetTotal > 0 ? netRatio > 0 && netRatio < 0.999 : !closeToFull;

  let accumulated = 0;
  const items = sourceItems.map((item) => {
    const costNumber = Number(item.cost);
    const qtyNumber = Number.isFinite(Number(item.qty)) ? Number(item.qty) : 1;
    const qty = qtyNumber === 0 ? 1 : qtyNumber;
    const basePerUnit = Math.abs(Number.isFinite(costNumber) ? costNumber : 0);
    const baseLineNet = basePerUnit * qty;
    const targetLineNet = Number((baseLineNet * netRatio).toFixed(4));
    const perUnit = qty !== 0 ? Number((targetLineNet / qty).toFixed(4)) : Number(targetLineNet.toFixed(4));
    accumulated = Number((accumulated + perUnit * qty).toFixed(4));

    return {
      originalQty: item.qty,
      product_key: item.product_key,
      notes: item.notes,
      qty,
      perUnit,
      tax_name1: item.tax_name1,
      tax_rate1: item.tax_rate1,
      tax_name2: item.tax_name2,
      tax_rate2: item.tax_rate2,
      discount: item.discount,
    };
  });

  const difference = roundCurrency(targetNetTotal - accumulated);

  if (Math.abs(difference) >= 0.01 && items.length > 0) {
    const last = items[items.length - 1];
    const qty = last.qty || 1;
    const adjustmentPerUnit = difference / qty;
    last.perUnit = Number((last.perUnit + adjustmentPerUnit).toFixed(4));
  }

  let creditItems = items.map((item) => ({
    product_key: item.product_key,
    notes: item.notes,
    cost: -Number(Math.abs(item.perUnit).toFixed(4)),
    qty: item.originalQty != null ? item.originalQty : item.qty,
    tax_name1: item.tax_name1,
    tax_rate1: item.tax_rate1,
    tax_name2: item.tax_name2,
    tax_rate2: item.tax_rate2,
    discount: item.discount,
  }));

  if (creditItems.length === 0 && targetNetTotal > 0) {
    creditItems = [
      {
        product_key: source.invoice_number || `credit-${creditNumber}`,
        notes: `Ajustement de crédit pour la facture ${source.invoice_number}`,
        cost: -Number(targetNetTotal.toFixed(2)),
        qty: 1,
        tax_name1: source.tax_name1 || null,
        tax_rate1:
          Number.isFinite(Number(source.tax_rate1)) && Number(source.tax_rate1) >= 0
            ? Number(source.tax_rate1)
            : DEFAULT_VAT_RATE * 100,
        tax_name2: source.tax_name2 || null,
        tax_rate2:
          Number.isFinite(Number(source.tax_rate2)) && Number(source.tax_rate2) >= 0
            ? Number(source.tax_rate2)
            : 0,
        discount: 0,
      },
    ];
  }

  const terms = isPartial
    ? `Annulation partielle de la facture ${source.invoice_number} (arrangement à l'amiable)`
    : `Annulation de la facture ${source.invoice_number} (arrangement à l'amiable)`;

  const payload = {
    client_id: source.client_id,
    invoice_number: creditNumber,
    invoice_date: today,
    due_date: today,
    terms,
    invoice_items: creditItems,
    tax_name1: source.tax_name1,
    tax_rate1: source.tax_rate1,
    tax_name2: source.tax_name2,
    tax_rate2: source.tax_rate2,
    discount: source.discount || 0,
    po_number: source.po_number || "",
    public_notes: source.public_notes || "",
    private_notes: source.private_notes || "",
    custom_value1: source.custom_value1,
    custom_value2: source.custom_value2,
    custom_value3: source.custom_value3,
    custom_value4: source.custom_value4,
    currency_id: source.currency_id,
    exchange_rate: source.exchange_rate,
    invoice_type_id: 4,
    is_credit: true,
    invoice_status_id: 2,
  };

  const response = await axios.post(
    `${baseUrl}/api/v1/invoices`,
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

  return response.data && response.data.data ? response.data.data : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = requireEnv("INVOICE_NINJA_KEY");
  const baseUrl = (process.env.INVOICE_NINJA_BASE_URL || "https://ninja.lizoria.com").replace(/\/$/, "");
  const today = new Date().toISOString().split("T")[0];

  const httpsAgent =
    options.insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined;

  for (let index = 0; index < options.invoiceNumbers.length; index += 1) {
    const invoiceNumber = options.invoiceNumbers[index];
    const creditNumber = String(options.startNumber + index);

    let source;
    try {
      source = await fetchInvoice({
        baseUrl,
        token,
        invoiceNumber,
        httpsAgent,
      });
    } catch (error) {
      console.error(`Failed to fetch invoice ${invoiceNumber}:`, error.message);
      continue;
    }

    if (!source) {
      console.error(`Invoice ${invoiceNumber} not found; skipping.`);
      continue;
    }

    console.log(`Invoice ${invoiceNumber}: preparing credit note ${creditNumber}`);

    const amountToPay = roundCurrency(resolveInvoiceBalance(source));
    const invoiceNetTotal = roundCurrency(resolveInvoiceTotal(source));
    const invoiceGrossTotal = roundCurrency(resolveInvoiceGross(source));
    const inferredGrossTotal =
      invoiceGrossTotal > 0
        ? invoiceGrossTotal
        : invoiceNetTotal > 0
        ? roundCurrency(invoiceNetTotal * (1 + DEFAULT_VAT_RATE))
        : 0;
    const closeToFullCredit =
      inferredGrossTotal > 0
        ? Math.abs(inferredGrossTotal - amountToPay) <= 0.01
        : false;
    const isPartialCredit = !closeToFullCredit && amountToPay > 0;
    const paymentNote = `Paid by credit note ${creditNumber}`;
    const paymentPayload = {
      client_id: source.client_id,
      invoice_id: source.id,
      amount: amountToPay,
      payment_date: today,
      payment_type_id: 2,
      transaction_reference: `Credit note ${creditNumber}`,
      private_notes: paymentNote,
    };

    if (!options.apply) {
      console.log(
        `  -> Dry-run: would create credit note ${creditNumber} from invoice ${source.id}, copy items with negative amounts, set dates to ${today}, and set status to Sent`
      );
      if (amountToPay > 0) {
        console.log(
          `  -> Dry-run: would create payment dated ${today} for €${amountToPay.toFixed(
            2
          )} to mark invoice ${invoiceNumber} as paid (${paymentNote})`
        );
      } else {
        console.log(
          `  -> Dry-run: outstanding balance already zero; payment not required`
        );
      }
      if (isPartialCredit) {
        console.log(
          `  -> Invoice total €${inferredGrossTotal.toFixed(
            2
          )}; outstanding balance €${amountToPay.toFixed(
            2
          )} so credit items would be scaled proportionally`
        );
        const previewNet = amountToPay / (1 + DEFAULT_VAT_RATE);
        console.log(
          `     (net line total preview €${previewNet.toFixed(
            2
          )} assuming ${Math.round(DEFAULT_VAT_RATE * 100)}% VAT)`
        );
      }
      continue;
    }

    let creditCreated = null;
    let creditReady = false;
    try {
      creditCreated = await createCreditInvoice({
        baseUrl,
        token,
        source,
        creditNumber,
        creditAmount: amountToPay,
        invoiceNetTotal,
        invoiceGrossTotal,
        today,
        httpsAgent,
      });
      creditReady = true;
    } catch (error) {
      if (
        error.response &&
        error.response.status === 422 &&
        error.response.data &&
        error.response.data.invoice_number
      ) {
        console.warn(
          `  !! Credit number ${creditNumber} already exists; attempting to mark existing credit as sent`
        );
        try {
          const existing = await fetchInvoice({
            baseUrl,
            token,
            invoiceNumber: creditNumber,
            httpsAgent,
          });
          if (existing) {
            console.log(
              `  -> Credit note ${creditNumber} already exists (invoice id ${existing.id}); skipped creation`
            );
            creditReady = true;
          } else {
            console.error(
              `  !! Could not locate existing credit note ${creditNumber} despite duplicate invoice number`
            );
            continue;
          }
        } catch (innerError) {
          if (innerError.response) {
            console.error(
              `  !! Failed while checking existing credit ${creditNumber}:`,
              innerError.response.status,
              JSON.stringify(innerError.response.data)
            );
          } else {
            console.error(
              `  !! Failed while checking existing credit ${creditNumber}:`,
              innerError.message
            );
          }
          continue;
        }
      } else {
        if (error.response) {
          console.error(
            `  !! Credit creation failed for invoice ${invoiceNumber}:`,
            error.response.status,
            JSON.stringify(error.response.data)
          );
        } else {
          console.error(`  !! Credit creation failed for invoice ${invoiceNumber}:`, error.message);
        }
        continue;
      }
    }

    if (!creditReady) {
      console.error(`  !! API returned no credit note for invoice ${invoiceNumber}`);
      continue;
    }

    if (creditCreated) {
      console.log(
        `  -> Created credit note ${creditNumber} from invoice ${invoiceNumber} (new invoice id ${creditCreated.id})`
      );
      if (isPartialCredit) {
        console.log(
          `     (partial credit: invoice total €${inferredGrossTotal.toFixed(
            2
          )}, credited €${amountToPay.toFixed(2)})`
        );
        const previewNet = amountToPay / (1 + DEFAULT_VAT_RATE);
        console.log(
          `     (net line total applied ≈ €${previewNet.toFixed(
            2
          )} before ${Math.round(DEFAULT_VAT_RATE * 100)}% VAT)`
        );
      }
    }

    if (amountToPay <= 0) {
      console.log(`  -> Outstanding balance already zero; skipping payment creation`);
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
          `  -> Created payment ${payment.id} for invoice ${invoiceNumber} (€${amountToPay.toFixed(
            2
          )}, ${paymentNote})`
        );
      } else {
        console.log(
          `  -> Payment created for invoice ${invoiceNumber}, response: ${JSON.stringify(payment)}`
        );
      }
    } catch (paymentError) {
      if (paymentError.response) {
        console.error(
          `  !! Failed to create payment for invoice ${invoiceNumber}:`,
          paymentError.response.status,
          JSON.stringify(paymentError.response.data)
        );
      } else {
        console.error(
          `  !! Failed to create payment for invoice ${invoiceNumber}:`,
          paymentError.message
        );
      }
    }
  }
}

main().catch((error) => {
  console.error("create-credit-notes failed:", error);
  process.exit(1);
});
