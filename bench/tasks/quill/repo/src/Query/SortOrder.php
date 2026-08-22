<?php
declare(strict_types=1);
namespace Quill\Query;

/** A whitelist of sortable columns. Anything not listed is rejected rather than
 *  interpolated, because this ends up in SQL. */
final class SortOrder {
    private const ALLOWED = ['published_at', 'created_at', 'updated_at', 'title'];

    private function __construct(public readonly string $column, public readonly string $direction) {}

    public static function of(string $column, string $direction = 'DESC'): self {
        if (!in_array($column, self::ALLOWED, true)) {
            throw new \InvalidArgumentException("cannot sort by {$column}");
        }
        $dir = strtoupper($direction) === 'ASC' ? 'ASC' : 'DESC';
        return new self($column, $dir);
    }

    public static function newest(): self { return new self('published_at', 'DESC'); }

    public function toSql(): string { return "{$this->column} {$this->direction}"; }
}
