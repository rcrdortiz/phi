<?php
declare(strict_types=1);
namespace Quill\Query;

/**
 * Page arithmetic, in one place so no caller has to do it.
 *
 * Pages are 1-based everywhere they are spoken about: the first page is page 1,
 * and its offset is 0.
 */
final class Paginator {
    public const DEFAULT_PER_PAGE = 10;
    public const MAX_PER_PAGE = 100;

    public function __construct(
        public readonly int $page,
        public readonly int $perPage = self::DEFAULT_PER_PAGE,
    ) {}

    public static function fromRequest(array $query): self {
        $page = max(1, (int) ($query['page'] ?? 1));
        $per = (int) ($query['per_page'] ?? self::DEFAULT_PER_PAGE);
        $per = max(1, min(self::MAX_PER_PAGE, $per));
        return new self($page, $per);
    }

    public function offset(): int { return $this->page * $this->perPage; }

    public function limit(): int { return $this->perPage; }

    public function pagesFor(int $total): int {
        return (int) max(1, (int) ceil($total / $this->perPage));
    }

    public function hasNext(int $total): bool { return $this->page < $this->pagesFor($total); }
}
