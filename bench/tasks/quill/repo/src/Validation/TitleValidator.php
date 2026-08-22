<?php
declare(strict_types=1);
namespace Quill\Validation;

/** a title is required and at most 120 characters. */
final class TitleValidator implements ValidatorInterface {
    public function validate(array $input): array {
        $title = trim((string) ($input['title'] ?? ''));
        if ($title === '') return ['title is required'];
        if (mb_strlen($title) > 120) return ['title must be 120 characters or fewer'];
        return [];
    }
}
