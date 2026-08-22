<?php
declare(strict_types=1);
namespace Quill\Validation;

/** One rule. Returns a list of problems; an empty list means the input passed. */
interface ValidatorInterface {
    /** @return string[] */
    public function validate(array $input): array;
}
