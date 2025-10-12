# Repository Guidelines

## Project Structure & Module Organization
The repository is organised around a small core plus task-specific CLIs. `core/gocardless-client.js` wraps token exchange, consent creation, and account endpoints. `core/snapshot-store.js` persists statement JSON into `data/statements/` (ignored by git) so subsequent scripts can replay results offline. Top-level scripts live under `apps/`: `create-consent.js` creates agreements/requisitions, `fetch-statements.js` fetches balances + transactions, and `rent/index.js` houses the rent checker logic with its own config in `apps/rent/rent-config.js`. Store `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY`, and `REDIRECT_URL` in a local `.env`. Bank metadata (institution IDs, requisitions, account IDs, IBANs) belongs in `config/accounts.json`—copy `config/accounts.sample.json` as a starting point.

## Build, Test, and Development Commands
- `npm install` — install `axios`, `dotenv`, and related dependencies.
- `node apps/create-consent.js --account belfius` — create an agreement/requisition for the given alias; prints the browser link and requisition ID.
- `node apps/fetch-statements.js --account belfius` — fetch balances + transactions for the alias, store the JSON under `data/statements/`, and print a short summary. Add `--local` to replay the most recent file instead of calling the API.
- `node apps/rent/index.js` — analyse rent payments using the latest saved statements (or pass `--file <path>` to target a specific JSON dump).

## Configuring Multiple Accounts
1. Copy `config/accounts.sample.json` to `config/accounts.json`.
2. For each alias (e.g. `"belfius"`, `"bnppf"`), populate `institutionId`, `requisitionId`, and optionally `accountId` + `iban` for lookup.
3. Set `GOCARDLESS_ACTIVE_ACCOUNT` in `.env` for the alias you use most often; override per-run with `--account <alias>`.
4. `apps/fetch-statements.js` resolves `accountId` automatically when provided. If you omit it, supply an `iban` so the script can match accounts to requisitions using the API.

## Coding Style & Naming Conventions
Stick to CommonJS `require`/`module.exports`, two-space indentation, and descriptive constants for URLs and institution IDs. Use `async`/`await` and `console.error` to keep error paths clear. Name saved files with snake_case and timestamps to mirror existing snapshots.

## Testing Guidelines
Automated tests are not yet wired (`npm test` fails intentionally), so lean on scripted runs: execute `node apps/fetch-statements.js --local` against stored fixtures, then re-run without `--local` after HTTP-facing changes. When you add tests, place them under `tests/` or `__tests__/` and stub HTTP requests to protect credentials. Note any manual validation in the PR so reviewers know what was exercised.

## Commit & Pull Request Guidelines
Use a concise `<type>: <summary>` commit style (for example, `feat: add rent status report`) until a formal convention lands. Keep commits focused, update `.env.example` when configuration changes, and call out which script you touched. Pull requests should explain the behaviour change, list manual verification (e.g., `node apps/fetch-statements.js --local`), link issues, and attach redacted output when helpful.

## Security & Configuration Tips
Never commit `.env` files or raw transaction exports; keep them local. Prefer `--local` mode during demos to avoid hitting live accounts, and rotate secrets if they ever leak to logs. Scrub IBANs, payer names, and requisition IDs from shared diagnostics.

## Statement Importer
- Run `node apps/import-statements.js --input . --output data/statements/pdf --overwrite` whenever new ZIPs/PDFs appear; it flattens every archive, parses each statement with `pdf-parse`, and emits one JSON per PDF plus a rolled-up `operations-index.json`.
- Each statement JSON captures metadata (`account`, `balances`, `statementId`) and a normalized `operations` array with booking/value dates, amounts, communications, counterparty IBAN/BIC, and preserved raw detail lines.
- `operations-index.json` is the preferred search surface for LLM queries: filter with `jq` (e.g., `jq '[.operations[] | select(.counterpartyName|ascii_downcase|contains(\"soficoest\"))]' data/statements/pdf/operations-index.json`) to aggregate by counterparty, amounts, or dates.
- The importer is idempotent; pass `--overwrite` for refreshes, `--no-standalone-pdf` if you only want ZIP contents, and adjust `--input` when scanning non-root folders.
