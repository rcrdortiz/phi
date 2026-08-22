<?php
declare(strict_types=1);
namespace Quill\Repository;

use Quill\Database\{Connection, RowMapper};
use Quill\Domain\Author;

final class AuthorRepository {
    public function __construct(private Connection $db, private RowMapper $map) {}

    public function findById(int $id): ?Author {
        $row = $this->db->selectOne('SELECT * FROM authors WHERE id = ?', [$id]);
        return $row === null ? null : $this->map->author($row);
    }

    /** @return Author[] */
    public function all(): array {
        return array_map(fn (array $r) => $this->map->author($r), $this->db->select('SELECT * FROM authors ORDER BY name'));
    }
}
