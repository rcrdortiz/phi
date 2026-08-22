<?php
declare(strict_types=1);
namespace Quill\Domain;

use Quill\Support\Str;

/** A short lead taken from the body. Never longer than the limit in words. */
final class Excerpt {
    private function __construct(public readonly string $text) {}

    public static function fromBody(string $body, int $words = 40): self {
        return new self(Str::truncateWords(Str::stripMarkup($body), $words));
    }

    public function __toString(): string { return $this->text; }
}
