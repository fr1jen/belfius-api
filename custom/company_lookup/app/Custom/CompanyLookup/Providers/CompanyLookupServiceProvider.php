<?php

namespace App\Custom\CompanyLookup\Providers;

use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

class CompanyLookupServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $this->registerRoutes();
    }

    private function registerRoutes(): void
    {
        Route::middleware(['throttle:api', 'token_auth', 'valid_json', 'locale'])
            ->prefix('api/v1')
            ->as('api.')
            ->group(function () {
                Route::get('company-lookup', [
                    \App\Custom\CompanyLookup\Http\Controllers\CompanyLookupController::class,
                    'index',
                ])->name('company_lookup.index');
            });
    }
}
