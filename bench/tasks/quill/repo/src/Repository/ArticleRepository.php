<?php
declare(strict_types=1);
namespace Quill\Repository;

use Quill\Domain\Article;
use Quill\Query\{Criteria, Paginator, SortOrder};

interface ArticleRepository {
    public function findBySlug(string $slug): ?Article;
    public function findById(int $id): ?Article;
    /** @return Article[] */
    public function matching(Criteria $criteria, Paginator $page, ?SortOrder $order = null): array;
    public function countMatching(Criteria $criteria): int;
    public function save(Article $article): Article;
}
