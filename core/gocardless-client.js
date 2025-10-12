const axios = require("axios");

const DEFAULT_BASE_URL = "https://bankaccountdata.gocardless.com/api/v2";

function createError(message, cause) {
  const error = new Error(message);
  if (cause) {
    error.cause = cause;
    error.response = cause.response;
  }
  return error;
}

function createGocardlessClient({
  secretId,
  secretKey,
  baseUrl = DEFAULT_BASE_URL,
}) {
  if (!secretId || !secretKey) {
    throw new Error(
      "secretId and secretKey are required to initialise the GoCardless client"
    );
  }

  let accessToken = null;

  async function ensureAccessToken() {
    if (accessToken) {
      return accessToken;
    }

    try {
      const response = await axios.post(`${baseUrl}/token/new/`, {
        secret_id: secretId,
        secret_key: secretKey,
      });

      accessToken = response.data.access;
      return accessToken;
    } catch (error) {
      throw createError("Failed to exchange secrets for an access token", error);
    }
  }

  async function authorisedRequest(config) {
    const token = await ensureAccessToken();
    const headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` };

    try {
      const response = await axios({ ...config, baseURL: baseUrl, headers });
      return response.data;
    } catch (error) {
      throw createError("GoCardless API request failed", error);
    }
  }

  return {
    getAccessToken: ensureAccessToken,

    resetAccessToken() {
      accessToken = null;
    },

    async createEndUserAgreement({
      institutionId,
      maxHistoricalDays = 90,
      accessValidForDays = 90,
      accessScope = ["balances", "details", "transactions"],
    }) {
      if (!institutionId) {
        throw new Error("institutionId is required to create an agreement");
      }

      return authorisedRequest({
        method: "POST",
        url: `/agreements/enduser/`,
        data: {
          institution_id: institutionId,
          max_historical_days: String(maxHistoricalDays),
          access_valid_for_days: String(accessValidForDays),
          access_scope: accessScope,
        },
      });
    },

    async createRequisition({
      redirect,
      institutionId,
      reference,
      agreementId,
      userLanguage = "EN",
    }) {
      if (!redirect || !institutionId || !reference || !agreementId) {
        throw new Error(
          "redirect, institutionId, reference, and agreementId are required to create a requisition"
        );
      }

      return authorisedRequest({
        method: "POST",
        url: `/requisitions/`,
        data: {
          redirect,
          institution_id: institutionId,
          reference,
          agreement: agreementId,
          user_language: userLanguage,
        },
      });
    },

    async getRequisition(requisitionId) {
      if (!requisitionId) {
        throw new Error("requisitionId is required");
      }

      return authorisedRequest({
        method: "GET",
        url: `/requisitions/${requisitionId}/`,
      });
    },

    async getAccountDetails(accountId) {
      if (!accountId) {
        throw new Error("accountId is required");
      }

      return authorisedRequest({
        method: "GET",
        url: `/accounts/${accountId}/details/`,
      });
    },

    async getAccountBalances(accountId) {
      if (!accountId) {
        throw new Error("accountId is required");
      }

      return authorisedRequest({
        method: "GET",
        url: `/accounts/${accountId}/balances/`,
      });
    },

    async getAccountTransactions(accountId, { dateFrom, dateTo } = {}) {
      if (!accountId) {
        throw new Error("accountId is required");
      }

      return authorisedRequest({
        method: "GET",
        url: `/accounts/${accountId}/transactions/`,
        params: {
          ...(dateFrom ? { date_from: dateFrom } : {}),
          ...(dateTo ? { date_to: dateTo } : {}),
        },
      });
    },
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  createGocardlessClient,
};
