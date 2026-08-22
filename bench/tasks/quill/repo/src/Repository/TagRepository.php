<?php
declare(strict_types=1);
namespace Quill\Repository;

use Quill\Database\{Connection, RowMapper};
use Quill\Domain\Tag;

final class TagRepository {
    public function __construct(private Connection $db, private RowMapper $map) {}

    /** @return Tag[] */
    public function forArticle(int $articleId): array {
        $rows = $this->db->select(
            'SELECT t.* FROM tags t INNER JOIN article_tags at ON at.tag_id = t.id WHERE at.article_id = ? ORDER BY t.name',
            [$articleId],
        );
        return array_map(fn (array $r) => $this->map->tag($r), $rows);
    }

    /** @return Tag[] */
    public function all(): array {
        return array_map(fn (array $r) => $this->map->tag($r), $this->db->select('SELECT * FROM tags ORDER BY name'));
    }

    public function findBySlug(string $slug): ?Tag {
        $row = $this->db->selectOne('SELECT * FROM tags WHERE slug = ?', [$slug]);
        return $row === null ? null : $this->map->tag($row);
    }
}
