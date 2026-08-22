<?php
declare(strict_types=1);
namespace Quill\Service;

use Quill\Database\Connection;

final class StatsService {
    public function __construct(private Connection $db) {}

    public function countByStatus(): array {
        $rows = $this->db->select('SELECT status, COUNT(*) AS n FROM articles WHERE deleted_at IS NULL GROUP BY status');
        $out = [];
        foreach ($rows as $r) $out[(string) $r['status']] = (int) $r['n'];
        return $out;
    }

    public function busiestAuthors(int $limit = 5): array {
        return $this->db->select(
            'SELECT au.name, COUNT(a.id) AS n FROM authors au
             LEFT JOIN articles a ON a.author_id = au.id AND a.deleted_at IS NULL
             GROUP BY au.id ORDER BY n DESC, au.name LIMIT ?',
            [$limit],
        );
    }
}
