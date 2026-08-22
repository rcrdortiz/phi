<?php
declare(strict_types=1);
namespace Quill\Domain;

/**
 * An article. Immutable; state changes return a new instance, so a rendered
 * article can never be mutated underneath the renderer.
 */
final class Article {
    /** @param Tag[] $tags */
    public function __construct(
        public readonly int $id,
        public readonly int $authorId,
        public readonly Slug $slug,
        public readonly string $title,
        public readonly string $body,
        public readonly Status $status,
        public readonly ?int $publishedAt,
        public readonly ?int $deletedAt,
        public readonly int $createdAt,
        public readonly int $updatedAt,
        public readonly array $tags = [],
    ) {}

    public function isVisible(): bool {
        return $this->status->isPublic() && $this->deletedAt === null;
    }

    /** Minutes to read at 200 words per minute, rounded up, never less than 1. */
    public function readingTime(): int {
        return max(1, (int) ceil(\Quill\Support\Str::words($this->body) / 200));
    }

    public function excerpt(int $words = 40): Excerpt {
        return Excerpt::fromBody($this->body, $words);
    }

    public function withTags(array $tags): self {
        return new self($this->id, $this->authorId, $this->slug, $this->title, $this->body,
            $this->status, $this->publishedAt, $this->deletedAt, $this->createdAt, $this->updatedAt, $tags);
    }

    public function publish(int $at): self {
        return new self($this->id, $this->authorId, $this->slug, $this->title, $this->body,
            Status::Published, $at, $this->deletedAt, $this->createdAt, $at, $this->tags);
    }

    /** @return string[] */
    public function tagSlugs(): array {
        return array_map(static fn (Tag $t) => $t->slug->value, $this->tags);
    }
}
