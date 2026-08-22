<?php
declare(strict_types=1);
namespace Quill\Http;

use Quill\Query\{Criteria, Paginator, SortOrder};
use Quill\Repository\ArticleRepository;
use Quill\Rendering\RendererRegistry;

final class ArticleController extends Controller {
    public function __construct(
        RendererRegistry $renderers,
        private ArticleRepository $articles,
    ) {
        parent::__construct($renderers);
    }

    /**
     * The public listing.
     *
     * Pages are 1-based in the URL: /articles?page=1 is the first page.
     */
    public function index(Request $request): Response {
        $page = new Paginator(max(1, $request->queryInt('page', 1)), $request->queryInt('per_page', Paginator::DEFAULT_PER_PAGE));
        $criteria = Criteria::published();
        if (($tag = $request->queryString('tag')) !== null) $criteria = $criteria->withTag($tag);
        if (($q = $request->queryString('q')) !== null) $criteria = new Criteria($criteria->status, $criteria->tagSlug, null, $q);

        $articles = $this->articles->matching($criteria, $page, SortOrder::newest());
        $renderer = $this->rendererFor($request);
        return Response::ok($renderer->renderMany($articles), $renderer->contentType());
    }

    public function show(Request $request, string $slug): Response {
        $article = $this->articles->findBySlug($slug);
        if ($article === null || !$article->isVisible()) return Response::notFound();
        $renderer = $this->rendererFor($request);
        return Response::ok($renderer->render($article), $renderer->contentType());
    }
}
