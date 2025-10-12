# Custom Company Lookup Integration (LLM Field Guide)

This document explains the bespoke “company lookup” feature that now lives in this repository. It is written so an LLM—or any contributor who did not follow the original conversation—can reconstruct the architecture, dependencies, and workflows without guesswork.

---

## 1. Goals & Outcomes

- Auto-suggest company data (name, VAT, address) when creating a client in Invoice Ninja.
- Keep all custom code outside of the upstream Invoice Ninja sources so upgrades stay simple.
- Rebuild the Docker image with the customization baked in.
- Document the structure so future additions follow the same pattern.

---

## 2. Repository Layout

```
custom/
  agents.md              <-- this document
  company_lookup/
    README.md            <-- short operational notes
    app/                 <-- Laravel service/provider/etc.
    patches/             <-- changes applied to upstream templates/config
    public/js/           <-- custom browser script injected at runtime
vendor/
  invoiceninja-dockerfiles/
    debian/
      Dockerfile         <-- patched to copy + apply our custom assets
      docker-compose.yml <-- uses repo root as build context
```

Only the highlighted files are tracked in Git. Everything else in `vendor/invoiceninja-dockerfiles` remains upstream or ignored.

---

## 3. Backend Custom Module

Namespace: `App\Custom\CompanyLookup`.

### Key Files

- `Providers/CompanyLookupServiceProvider.php`
  - Auto-loaded via `config/app.php` patch.
  - Registers `GET /api/v1/company-lookup`.
  - Middleware stack matches other admin routes (`throttle`, `token_auth`, `valid_json`, `locale`).

- `Http/Controllers/CompanyLookupController.php`
  - Accepts validated query parameters.
  - Delegates to the service and returns JSON (`{ data: { query, results } }`).

- `Http/Requests/CompanyLookupRequest.php`
  - Ensures a minimum query string, optional 2-letter country override.

- `Services/CompanyLookupService.php`
  - Uses Invoice Ninja’s existing `VatNumberCheck`.
  - Normalises VAT numbers (handles prefixes like `BE`).
  - Parses VIES responses into a consistent structure.
  - Designed to be expanded with additional providers later.

### Routing Patch

`custom/company_lookup/patches/config-app-provider.patch` appends the service provider to `config/app.php`. The Dockerfile applies this patch during build.

---

## 4. Frontend Injection

File: `custom/company_lookup/public/js/company-lookup.js`

- Loaded via `<script defer src="/js/company-lookup.js"></script>` patch applied to `resources/views/react/index.blade.php`.
- Observes the React-rendered client form, reading labels rather than hard-coded IDs.
- Debounces input on the Name / VAT fields; calls `/api/v1/company-lookup`.
- Presents a dropdown (Tailwind-style classes) with suggestions; clicking auto-fills name/VAT/address.
- Works even as the upstream React build changes, because it relies on accessible labels (`Name`, `VAT number`, etc.) rather than DOM structure.

---

## 5. Docker Image Pipeline

File: `vendor/invoiceninja-dockerfiles/debian/Dockerfile`

- Build context is repository root (`docker-compose.yml` sets `context: ../../..`).
- Copies custom module and JS into both `/var/www/html` and the cached `/tmp/public` used by `init.sh`.
- Applies provider patch via `patch -p1`.
- Injects the extra `<script>` tag through an inline Python snippet (no dependence on `patch` for dynamic bundle names).

### Runtime init script

`vendor/invoiceninja-dockerfiles/debian/scripts/init.sh` wasn’t modified, but note:
- It repopulates `/var/www/html/public` from `/tmp/public` on container start. Hence the Dockerfile copies JS into both locations.

### Rebuild workflow

```bash
# From repo root:
cd vendor/invoiceninja-dockerfiles/debian
docker compose build app
docker compose up -d app
```

This rebuilds the custom image and restarts the application container with the latest assets.

---

## 6. API & Usage Summary

- Endpoint: `GET /api/v1/company-lookup`
  - Query params: `query` (required), `country` (optional, ISO 3166-1 alpha-2).
  - Response: `{"data":{"query":"…","results":[…]}}`
  - Authentication: same token/cookie requirements as other admin API calls.

- Frontend behaviour:
  - Triggered automatically on `/clients/create` when typing in Name or VAT number field.
  - Dropdown shows VIES-derived data.
  - Selecting fills in name/VAT/address fields; country still requires manual verification (can be extended later).

---

## 7. Extending the Feature

### Add another data provider

1. Update `CompanyLookupService::search` to branch on non-VAT input.
2. Implement a new helper (e.g., `searchByName`) that calls the provider API.
3. Merge results into the existing array format (`[{ source, name, vat_number, address: {...} }]`).

### Modify UI behaviour

- All frontend logic lives in `public/js/company-lookup.js`. Keep it declarative and label-driven to remain resilient to upstream layout changes.
- After edits, rebuild the Docker image (step 5) to pick up the new bundle.

### Change patching logic

- Additional Laravel patches go in `custom/company_lookup/patches/` and referenced from the Dockerfile.
- Keep patches small and additive; avoid editing core files directly in the repository root.

---

## 8. Testing & Validation

Recommended manual checks:

- `docker compose logs app nginx` for routing errors.
- `php artisan route:list --name=company_lookup.index` inside the container to confirm registration.
- Browser-side: hard refresh `/clients/create`, open dev tools network tab, type a VAT number, ensure the `/company-lookup` request succeeds and the dropdown renders.

Potential automated tests (future work):
- Feature test hitting `/api/v1/company-lookup` with a mocked VIES client.
- Cypress/E2E script verifying drop-down injection (would need a stubbed API response).

---

## 9. File Checklist (Tracked in Git)

- `.gitignore` (now ignores everything under `vendor/invoiceninja-dockerfiles` except the two managed files).
- `custom/company_lookup/**/*`
- `vendor/invoiceninja-dockerfiles/debian/Dockerfile`
- `vendor/invoiceninja-dockerfiles/debian/docker-compose.yml`

Everything else in `vendor/invoiceninja-dockerfiles` stays untracked.

---

## 10. Quick Start for New Contributors

1. **Pull latest code.**
2. **Rebuild the image**: `cd vendor/invoiceninja-dockerfiles/debian && docker compose build app && docker compose up -d app`.
3. **Test locally**: open `http://localhost:8012/clients/create`, type a VAT number (`0600971814`)—you should see suggestions.
4. **Modify backend**: edit files in `custom/company_lookup/app/…`; rebuild the container to apply changes.
5. **Modify frontend**: edit `custom/company_lookup/public/js/company-lookup.js`; rebuild to propagate to `/public` and `/tmp/public`.

Keep any new customization inside `custom/` (and update the Dockerfile accordingly) to maintain the upgrade-friendly separation.

---

## 11. Digging Deeper When You’re Unsure

- **Inspect the running API code**: jump into the container with  
  `cd vendor/invoiceninja-dockerfiles/debian && docker compose exec app bash`.  
  The upstream Laravel application lives under `/var/www/html`. Controllers, middleware, and services that our custom code relies on can be inspected there (for example `app/Http/Middleware/TokenAuth.php`, `app/Services/Tax/VatNumberCheck.php`). Prefer reading the actual source instead of inferring behaviour.

- **Check the official React app**: the Invoice Ninja UI is open source at [github.com/invoiceninja/ui](https://github.com/invoiceninja/ui). The client create flow is implemented in:
  - `src/pages/clients/create/Create.tsx`
  - `src/pages/clients/create/ common/components/CreatePage.tsx` (note the leading space in the directory name—it's intentional upstream)
  - Shared widgets such as address/name inputs under `src/pages/clients/edit/components/`.

  When you need to understand how a field works (e.g. which props fire `setClient`), consult those files. You can browse with `curl`/`jq` (examples in earlier investigations) or clone the repo locally.

- **Confirm DOM structure before coding**: inspect `/clients/create` in the browser DevTools after each rebuild. The React app evolves, so double-check label text, CSS classes, and input names whenever selectors are updated.

- **Log safely when debugging**: if you need to add `console.debug`/`console.log`, strip them before shipping. The dropdown script should stay lightweight to avoid cluttering the production console.

Following these steps keeps changes grounded in the actual upstream behaviour rather than assumptions.

---

Happy hacking! If you need to reset context, this document + the file tree will get an LLM (or human) back to full awareness quickly. 
