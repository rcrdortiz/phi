<?php
declare(strict_types=1);
namespace Quill\Validation;

/** status must be one of the known states. */
final class StatusValidator implements ValidatorInterface {
    public function validate(array $input): array {
        $status = (string) ($input['status'] ?? 'draft');
        if (\Quill\Domain\Status::tryFrom($status) === null) return ["unknown status: {$status}"];
        return [];
    }
}
