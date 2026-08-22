<?php
declare(strict_types=1);
namespace Quill\Repository;

use Quill\Database\{Connection, RowMapper};
use Quill\Domain\Article;
use Quill\Query\{Criteria, Paginator, QueryBuilder, SortOrder};

final class SqlArticleRepository implements ArticleRepository {
    public function __construct(
        private Connection $db,
        private RowMapper $map,
        private TagRepository $tags,
    ) {}

    public function findBySlug(string $slug): ?Article {
        $row = $this->db->selectOne('SELECT * FROM articles WHERE slug = ? AND deleted_at IS NULL', [$slug]);
        return $row === null ? null : $this->map->article($row, $this->tags->forArticle((int) $row['id']));
    }

    public function findById(int $id): ?Article {
        $row = $this->db->selectOne('SELECT * FROM articles WHERE id = ? AND deleted_at IS NULL', [$id]);
        return $row === null ? null : $this->map->article($row, $this->tags->forArticle($id));
    }

    /**
     * Articles matching the criteria, with their tags where they have any.
     *
     * An article with no tags is still an article and must appear in the
     * listing: the tag join is there to filter when a tag is asked for, not to
     * decide which articles exist.
     */
    public function matching(Criteria $criteria, Paginator $page, ?SortOrder $order = null): array {
        $q = QueryBuilder::from('articles a', 'DISTINCT a.*')
            ->join('LEFT JOIN article_tags at ON at.article_id = a.id')
            ->join('LEFT JOIN tags t ON t.id = at.tag_id');

        if (!$criteria->includeDeleted) $q->where('a.deleted_at IS NULL');
        if ($criteria->status !== null) $q->where('a.status = ?', [$criteria->status->value]);
        if ($criteria->authorId !== null) $q->where('a.author_id = ?', [$criteria->authorId]);
        if ($criteria->tagSlug !== null) $q->where('t.slug = ?', [$criteria->tagSlug]);
        if ($criteria->search !== null) $q->where('(a.title LIKE ? OR a.body LIKE ?)', ["%{$criteria->search}%", "%{$criteria->search}%"]);

        $q->orderBy($order ?? SortOrder::newest())->paginate($page);

        $rows = $this->db->select($q->toSql(), $q->params());
        $out = [];
        foreach ($rows as $row) $out[] = $this->map->article($row, $this->tags->forArticle((int) $row['id']));
        return $out;
    }

    public function countMatching(Criteria $criteria): int {
        $q = QueryBuilder::from('articles a', 'COUNT(DISTINCT a.id) AS n')
            ->join('LEFT JOIN article_tags at ON at.article_id = a.id')
            ->join('LEFT JOIN tags t ON t.id = at.tag_id');
        if (!$criteria->includeDeleted) $q->where('a.deleted_at IS NULL');
        if ($criteria->status !== null) $q->where('a.status = ?', [$criteria->status->value]);
        if ($criteria->tagSlug !== null) $q->where('t.slug = ?', [$criteria->tagSlug]);
        $row = $this->db->selectOne($q->toSql(), $q->params());
        return (int) ($row['n'] ?? 0);
    }

    public function save(Article $article): Article {
        $this->db->execute(
            'UPDATE articles SET title = ?, body = ?, status = ?, published_at = ?, updated_at = ? WHERE id = ?',
            [$article->title, $article->body, $article->status->value, $article->publishedAt, $article->updatedAt, $article->id],
        );
        return $article;
    }
}
