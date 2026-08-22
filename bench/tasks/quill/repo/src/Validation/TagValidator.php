<?php
declare(strict_types=1);
namespace Quill\Validation;

/** at most five tags, each a known slug. */
final class TagValidator implements ValidatorInterface {
    public function validate(array $input): array {
        $tags = $input['tags'] ?? [];
        if (!is_array($tags)) return ['tags must be a list'];
        if (count($tags) > 5) return ['at most five tags'];
        foreach ($tags as $t) {
            if (!is_string($t) || !preg_match('/^[a-z0-9-]+$/', $t)) return ["invalid tag: " . var_export($t, true)];
        }
        return [];
    }
}
