<?php
declare(strict_types=1);
namespace Quill\Domain;

use Quill\Support\Str;

/** A URL-safe identifier. Immutable, validated on construction. */
final class Slug {
    private function __construct(public readonly string $value) {}

    public static function fromTitle(string $title): self { return new self(Str::slugify($title)); }

    public static function fromString(string $raw): self {
        $slug = Str::slugify($raw);
        if ($slug === '') throw new \InvalidArgumentException('slug cannot be empty');
        return new self($slug);
    }

    public function equals(self $other): bool { return $this->value === $other->value; }
    public function __toString(): string { return $this->value; }
}
