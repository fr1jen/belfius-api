# Repository Guidelines

## Project Structure & Module Organization
The repository hosts a Node.js integration for the GoCardless Bank Account Data API. `index.js` exchanges secrets for a token, creates the end-user agreement and requisition, then lists accounts, balances, and transactions. Every API run saves a JSON snapshot under `snapshots/` (ignored by git) so you can replay results without burning requests. `fetch-transactions.js` pulls a three-month window and can replay the newest saved JSON from `transactions/` when `--local` is set. Store `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY`, and `REDIRECT_URL` in a local `.env` before running scripts. By default the sample `.env` targets a Belfius account (`GOCARDLESS_ACTIVE_ACCOUNT=belfius`); adjust `GOCARDLESS_ACCOUNTS` (JSON object with optional `accountId` + `iban`) and the active alias to point at the requisition you need. The script falls back to `GOCARDLESS_ACCOUNT_ID` for legacy setups. Adjust rent tracking labels with `RENT_EXPECTED` (comma-separated `amount:label` entries).

## Build, Test, and Development Commands
- `npm install` — install `axios`, `dotenv`, and related dependencies.
- `node index.js` — run the consent flow; open the printed link and capture the requisition ID.
- `node fetch-transactions.js` — fetch fresh data for the configured account (or override with `--account <alias>`/`--account-id <uuid>`), saving JSON into `transactions/transactions_<from>_to_<to>_<timestamp>.json`.
- `node fetch-transactions.js --local` — replay the newest saved snapshot instead of calling the API.
- `node fetch-transactions.js --account bnppf` — temporarily select a different account alias without editing `.env` (combine with `--local` if you just want reporting).
- `node fetch-transactions.js --account-id <uuid>` — bypass alias lookup and hit a specific account ID.

## Configuring Multiple Accounts
1. Add each requisition to the JSON payload in `GOCARDLESS_ACCOUNTS`, using a unique alias (e.g. `{ "belfius": { "requisitionId": "…", "accountId": "…", "iban": "…" }, "bnppf": { … } }`).
2. Set `GOCARDLESS_ACTIVE_ACCOUNT` to the alias you want as the default for scripts.
3. To switch temporarily at runtime, pass `--account <alias>` to `fetch-transactions.js`; to bypass the alias table, pass `--account-id <uuid>`.
4. If your alias entry omits `accountId`, provide the IBAN and the script will resolve it against the requisition (requires API access, so run sparingly).

## Coding Style & Naming Conventions
Stick to CommonJS `require`/`module.exports`, two-space indentation, and descriptive constants for URLs and institution IDs. Use `async`/`await` and `console.error` to keep error paths clear. Name saved files with snake_case and timestamps to mirror existing snapshots.

## Testing Guidelines
Automated tests are not yet wired (`npm test` fails intentionally), so lean on scripted runs: execute `node fetch-transactions.js --local` against stored fixtures, then re-run without `--local` after HTTP-facing changes. When you add tests, place them under `tests/` or `__tests__/` and stub HTTP requests to protect credentials. Note any manual validation in the PR so reviewers know what was exercised.

## Commit & Pull Request Guidelines
Use a concise `<type>: <summary>` commit style (for example, `feat: add rent status report`) until a formal convention lands. Keep commits focused, update `.env.example` when configuration changes, and call out which script you touched. Pull requests should explain the behaviour change, list manual verification (e.g., `node fetch-transactions.js --local`), link issues, and attach redacted output when helpful.

## Security & Configuration Tips
Never commit `.env` files or raw transaction exports; keep them local. Prefer `--local` mode during demos to avoid hitting live accounts, and rotate secrets if they ever leak to logs. Scrub IBANs, payer names, and requisition IDs from shared diagnostics.
