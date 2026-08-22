<?php
declare(strict_types=1);
namespace Quill\Domain;

final class Comment {
    public function __construct(
        public readonly int $id,
        public readonly int $articleId,
        public readonly string $authorName,
        public readonly string $body,
        public readonly bool $approved,
        public readonly int $createdAt,
    ) {}
}
