<?php
declare(strict_types=1);
namespace Quill\Repository;

use Quill\Database\{Connection, RowMapper};
use Quill\Domain\Comment;

final class CommentRepository {
    public function __construct(private Connection $db, private RowMapper $map) {}

    /** Approved comments only: the public listing never shows unmoderated text. */
    public function approvedFor(int $articleId): array {
        $rows = $this->db->select(
            'SELECT * FROM comments WHERE article_id = ? AND approved = 1 ORDER BY created_at',
            [$articleId],
        );
        return array_map(fn (array $r) => $this->map->comment($r), $rows);
    }

    public function countApproved(int $articleId): int {
        $row = $this->db->selectOne('SELECT COUNT(*) AS n FROM comments WHERE article_id = ? AND approved = 1', [$articleId]);
        return (int) ($row['n'] ?? 0);
    }
}
