<?php
declare(strict_types=1);
namespace Quill\Domain;

enum Status: string {
    case Draft = 'draft';
    case Published = 'published';
    case Archived = 'archived';

    /** Whether an article in this state is visible to the public. */
    public function isPublic(): bool { return $this === self::Published; }

    public static function fromString(string $raw): self {
        return self::tryFrom($raw) ?? throw new \InvalidArgumentException("unknown status: {$raw}");
    }
}
