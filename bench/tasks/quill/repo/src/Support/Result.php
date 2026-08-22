<?php
declare(strict_types=1);
namespace Quill\Support;

/**
 * Success or failure with a reason. Returned rather than thrown wherever the
 * failure is expected: a missing article is not exceptional, a broken database
 * is.
 */
final class Result {
    private function __construct(
        public readonly bool $ok,
        public readonly mixed $value,
        public readonly array $errors,
    ) {}

    public static function ok(mixed $value = null): self { return new self(true, $value, []); }
    public static function fail(string ...$errors): self { return new self(false, null, $errors); }

    public function isOk(): bool { return $this->ok; }
    public function errors(): array { return $this->errors; }
    public function orElse(mixed $default): mixed { return $this->ok ? $this->value : $default; }
}
