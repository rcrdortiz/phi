<?php
declare(strict_types=1);
namespace Quill\Query;

/**
 * Assembles SELECT statements with bound parameters.
 *
 * Deliberately small: it exists so the repositories are not concatenating SQL
 * by hand, not to be an ORM.
 */
final class QueryBuilder {
    private array $wheres = [];
    private array $params = [];
    private array $joins = [];
    private ?string $order = null;
    private ?int $limit = null;
    private ?int $offset = null;

    public function __construct(private string $table, private string $columns = '*') {}

    public static function from(string $table, string $columns = '*'): self { return new self($table, $columns); }

    public function join(string $sql): self { $this->joins[] = $sql; return $this; }

    public function where(string $sql, array $params = []): self {
        $this->wheres[] = $sql;
        foreach ($params as $p) $this->params[] = $p;
        return $this;
    }

    public function orderBy(SortOrder $order): self { $this->order = $order->toSql(); return $this; }

    public function paginate(Paginator $p): self {
        $this->limit = $p->limit();
        $this->offset = $p->offset();
        return $this;
    }

    public function toSql(): string {
        $sql = "SELECT {$this->columns} FROM {$this->table}";
        foreach ($this->joins as $j) $sql .= ' ' . $j;
        if ($this->wheres) $sql .= ' WHERE ' . implode(' AND ', $this->wheres);
        if ($this->order !== null) $sql .= ' ORDER BY ' . $this->order;
        if ($this->limit !== null) $sql .= ' LIMIT ' . $this->limit;
        if ($this->offset !== null) $sql .= ' OFFSET ' . $this->offset;
        return $sql;
    }

    public function params(): array { return $this->params; }
}
