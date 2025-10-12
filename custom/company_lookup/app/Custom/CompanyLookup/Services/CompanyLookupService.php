<?php

namespace App\Custom\CompanyLookup\Services;

use App\Models\User;
use App\Services\Tax\VatNumberCheck;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Auth;

class CompanyLookupService
{
    public function search(string $query, ?string $country = null): array
    {
        $query = trim($query);
        $results = [];

        if ($this->looksLikeVatNumber($query)) {
            $results = $this->searchByVatNumber($query, $country);
        }

        return [
            'query' => $query,
            'results' => $results,
        ];
    }

    private function looksLikeVatNumber(string $value): bool
    {
        $normalized = preg_replace('/[^A-Za-z0-9]/', '', $value);

        return strlen($normalized) >= 8;
    }

    private function searchByVatNumber(string $value, ?string $country): array
    {
        $normalized = strtoupper(preg_replace('/\s+/', '', $value));

        $countryCode = $this->resolveCountryCode($normalized, $country);
        $vatNumber = $this->stripCountryCode($normalized, $countryCode);

        if ($countryCode === null || $vatNumber === null) {
            return [];
        }

        $checker = new VatNumberCheck($vatNumber, $countryCode);
        $checker->run();

        if (!$checker->isValid()) {
            return [];
        }

        $addressLines = $this->parseAddressLines($checker->getAddress());

        return [[
            'source' => 'vies',
            'name' => $checker->getName(),
            'vat_number' => $countryCode . $vatNumber,
            'address' => [
                'line1' => Arr::get($addressLines, 'line1'),
                'line2' => Arr::get($addressLines, 'line2'),
                'postal_code' => Arr::get($addressLines, 'postal_code'),
                'city' => Arr::get($addressLines, 'city'),
                'country_code' => $countryCode,
            ],
        ]];
    }

    private function resolveCountryCode(string $value, ?string $country): ?string
    {
        if ($country && strlen($country) === 2) {
            return strtoupper($country);
        }

        if (preg_match('/^([A-Z]{2})/', $value, $matches)) {
            return $matches[1];
        }

        /** @var User|null $user */
        $user = Auth::user();

        return $user?->company()->country()?->iso_3166_2 ?? null;
    }

    private function stripCountryCode(string $value, string $countryCode): ?string
    {
        $pattern = sprintf('/^(%s)/', preg_quote($countryCode, '/'));
        $vatNumber = preg_replace($pattern, '', $value);

        $vatNumber = preg_replace('/[^0-9A-Za-z]/', '', $vatNumber ?? '');

        return strlen($vatNumber) ? $vatNumber : null;
    }

    private function parseAddressLines(?string $address): array
    {
        if (!$address) {
            return [];
        }

        $lines = array_values(array_filter(
            preg_split('/\r\n|\r|\n/', $address) ?: [],
            fn ($line) => strlen(trim($line)) > 0
        ));

        $parsed = [
            'line1' => $lines[0] ?? null,
            'line2' => $lines[1] ?? null,
            'postal_code' => null,
            'city' => null,
        ];

        $secondaryLine = $lines[1] ?? $lines[0] ?? '';

        if (preg_match('/^([0-9]{3,})\s*(.*)$/u', $secondaryLine, $matches)) {
            $parsed['postal_code'] = $matches[1];
            $parsed['city'] = trim($matches[2]);
        }

        return $parsed;
    }
}
