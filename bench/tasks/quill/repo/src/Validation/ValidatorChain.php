<?php
declare(strict_types=1);
namespace Quill\Validation;

use Quill\Support\Result;

/** Runs every rule and collects every problem, rather than stopping at the
 *  first: a form should report all of its errors at once. */
final class ValidatorChain implements ValidatorInterface {
    /** @var ValidatorInterface[] */
    private array $rules;

    public function __construct(ValidatorInterface ...$rules) { $this->rules = $rules; }

    public function add(ValidatorInterface $rule): self {
        $this->rules[] = $rule;
        return $this;
    }

    public function validate(array $input): array {
        $problems = [];
        foreach ($this->rules as $rule) {
            foreach ($rule->validate($input) as $problem) $problems[] = $problem;
        }
        return $problems;
    }

    public function check(array $input): Result {
        $problems = $this->validate($input);
        return $problems === [] ? Result::ok($input) : Result::fail(...$problems);
    }

    public static function forArticle(): self {
        return new self(new TitleValidator(), new SlugValidator(), new BodyValidator(), new TagValidator(), new StatusValidator());
    }
}
