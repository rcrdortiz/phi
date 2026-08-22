<?php
declare(strict_types=1);
namespace Quill\Service;

use Quill\Query\{Criteria, Paginator, SortOrder};
use Quill\Repository\ArticleRepository;

final class SearchService {
    public function __construct(private ArticleRepository $articles) {}

    /** @return array{results: array, total: int, pages: int} */
    public function search(string $term, Paginator $page): array {
        $criteria = new Criteria(\Quill\Domain\Status::Published, null, null, $term);
        $total = $this->articles->countMatching($criteria);
        return [
            'results' => $this->articles->matching($criteria, $page, SortOrder::newest()),
            'total' => $total,
            'pages' => $page->pagesFor($total),
        ];
    }
}
