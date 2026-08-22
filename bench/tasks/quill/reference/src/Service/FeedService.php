<?php
declare(strict_types=1);
namespace Quill\Service;

use Quill\Query\{Criteria, Paginator, SortOrder};
use Quill\Repository\ArticleRepository;
use Quill\Rendering\RendererRegistry;

final class FeedService {
    public function __construct(
        private ArticleRepository $articles,
        private RendererRegistry $renderers,
    ) {}

    public function render(string $format, int $limit = 20): string {
        $articles = $this->articles->matching(Criteria::published(), new Paginator(1, $limit), SortOrder::newest());
        return $this->renderers->get($format)->renderMany($articles);
    }

    /** @return string[] */
    public function availableFormats(): array { return $this->renderers->names(); }
}
