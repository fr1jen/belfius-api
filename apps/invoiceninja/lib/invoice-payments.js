const axios = require("axios");

function roundCurrency(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

function resolveInvoiceBalance(invoice) {
  if (!invoice || typeof invoice !== "object") {
    return 0;
  }

  const candidates = [
    invoice.balance,
    invoice.balance_due,
    invoice.amount,
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = Number(candidates[index]);
    if (Number.isFinite(candidate)) {
      return Math.abs(candidate);
    }
  }

  return 0;
}

function resolveInvoiceTotal(invoice) {
  if (!invoice || typeof invoice !== "object") {
    return 0;
  }

  const items = Array.isArray(invoice.invoice_items) ? invoice.invoice_items : [];
  const itemsTotal = items.reduce((sum, item) => {
    const cost = Number(item.cost);
    const qty = Number.isFinite(Number(item.qty)) ? Number(item.qty) : 1;
    if (!Number.isFinite(cost) || qty === 0) {
      return sum;
    }
    const lineTotal = Math.abs(cost) * Math.abs(qty);
    return sum + lineTotal;
  }, 0);

  if (itemsTotal > 0) {
    return itemsTotal;
  }

  const directCandidates = [
    invoice.subtotal,
    invoice.amount_without_tax,
    invoice.amount,
    invoice.total,
    invoice.amount_with_tax,
    Number(invoice.balance || 0) + Number(invoice.paid_to_date || invoice.paid || 0),
  ];

  for (let index = 0; index < directCandidates.length; index += 1) {
    const candidate = Number(directCandidates[index]);
    if (Number.isFinite(candidate) && Math.abs(candidate) > 0) {
      return Math.abs(candidate);
    }
  }

  return 0;
}

function resolveInvoiceGross(invoice) {
  if (!invoice || typeof invoice !== "object") {
    return 0;
  }

  const candidates = [
    invoice.amount,
    invoice.total,
    invoice.total_amount,
    invoice.amount_with_tax,
    Number(invoice.balance || 0) + Number(invoice.paid_to_date || invoice.paid || 0),
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = Number(candidates[index]);
    if (Number.isFinite(candidate) && Math.abs(candidate) > 0) {
      return Math.abs(candidate);
    }
  }

  return 0;
}

async function createPayment({ baseUrl, token, payload, httpsAgent }) {
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

  return response.data && response.data.data ? response.data.data : null;
}

module.exports = {
  roundCurrency,
  resolveInvoiceBalance,
  resolveInvoiceTotal,
  resolveInvoiceGross,
  createPayment,
};
