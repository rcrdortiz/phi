<?php
declare(strict_types=1);
namespace Quill\Validation;

/** a body is required and at least 20 words. */
final class BodyValidator implements ValidatorInterface {
    public function validate(array $input): array {
        $body = trim((string) ($input['body'] ?? ''));
        if ($body === '') return ['body is required'];
        if (\Quill\Support\Str::words($body) < 20) return ['body must be at least 20 words'];
        return [];
    }
}
