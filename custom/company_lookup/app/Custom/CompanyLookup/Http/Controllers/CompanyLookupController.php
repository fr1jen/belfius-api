<?php

namespace App\Custom\CompanyLookup\Http\Controllers;

use App\Custom\CompanyLookup\Http\Requests\CompanyLookupRequest;
use App\Custom\CompanyLookup\Services\CompanyLookupService;
use Illuminate\Http\JsonResponse;

class CompanyLookupController
{
    public function __construct(private readonly CompanyLookupService $service)
    {
    }

    public function index(CompanyLookupRequest $request): JsonResponse
    {
        $results = $this->service->search(
            $request->input('query'),
            $request->input('country')
        );

        return response()->json([
            'data' => $results,
        ]);
    }
}
