<?php
declare(strict_types=1);
namespace Quill\Http;

use Quill\Query\{Criteria, Paginator, SortOrder};
use Quill\Repository\ArticleRepository;
use Quill\Rendering\RendererRegistry;

/** The syndication endpoint. Always the newest articles, never paginated past
 *  the first page, in whichever format was asked for. */
final class FeedController extends Controller {
    public function __construct(RendererRegistry $renderers, private ArticleRepository $articles) {
        parent::__construct($renderers);
    }

    public function feed(Request $request): Response {
        $articles = $this->articles->matching(Criteria::published(), new Paginator(1, 20), SortOrder::newest());
        $renderer = $this->rendererFor($request);
        return Response::ok($renderer->renderMany($articles), $renderer->contentType());
    }
}
