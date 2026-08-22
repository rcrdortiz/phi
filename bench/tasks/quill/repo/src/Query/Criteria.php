<?php
declare(strict_types=1);
namespace Quill\Query;

use Quill\Domain\Status;

/** What to filter an article listing by. Every field is optional. */
final class Criteria {
    public function __construct(
        public readonly ?Status $status = null,
        public readonly ?string $tagSlug = null,
        public readonly ?int $authorId = null,
        public readonly ?string $search = null,
        public readonly bool $includeDeleted = false,
    ) {}

    public function withStatus(Status $s): self {
        return new self($s, $this->tagSlug, $this->authorId, $this->search, $this->includeDeleted);
    }

    public function withTag(string $slug): self {
        return new self($this->status, $slug, $this->authorId, $this->search, $this->includeDeleted);
    }

    public static function published(): self { return new self(Status::Published); }
}
