<?php
declare(strict_types=1);
namespace Quill\Validation;

/** a slug is lowercase, hyphenated, and unique. */
final class SlugValidator implements ValidatorInterface {
    public function validate(array $input): array {
        $slug = trim((string) ($input['slug'] ?? ''));
        if ($slug === '') return ['slug is required'];
        if (!preg_match('/^[a-z0-9]+(-[a-z0-9]+)*$/', $slug)) return ['slug must be lowercase and hyphenated'];
        return [];
    }
}
