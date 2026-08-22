<?php
declare(strict_types=1);
namespace Quill\Domain;

final class Tag {
    public function __construct(
        public readonly int $id,
        public readonly Slug $slug,
        public readonly string $name,
    ) {}
}
