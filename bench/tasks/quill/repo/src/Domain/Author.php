<?php
declare(strict_types=1);
namespace Quill\Domain;

final class Author {
    public function __construct(
        public readonly int $id,
        public readonly string $name,
        public readonly string $email,
        public readonly int $createdAt,
    ) {}

    public function displayName(): string { return $this->name !== '' ? $this->name : $this->email; }
}
