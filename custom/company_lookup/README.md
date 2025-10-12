# Company Lookup Custom Module

This directory keeps all customisations for the company lookup feature:

- PHP backend lives under `app/Custom/CompanyLookup`.
- Frontend assets go in `public/js`.
- Template/config tweaks are stored as patch files in `patches/` and applied during the image build (see `Dockerfile`).

To test locally without rebuilding the Docker image you can copy the `app` and `public` directories into the running container and run `php artisan config:clear` + `php artisan route:clear`.
