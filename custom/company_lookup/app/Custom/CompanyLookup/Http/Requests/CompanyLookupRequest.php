<?php

namespace App\Custom\CompanyLookup\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class CompanyLookupRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'query' => ['required', 'string', 'min:2'],
            'country' => ['nullable', 'string', 'size:2'],
        ];
    }

    public function authorize(): bool
    {
        return true;
    }
}
