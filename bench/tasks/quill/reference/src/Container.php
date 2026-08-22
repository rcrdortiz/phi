<?php
declare(strict_types=1);
namespace Quill;

use Quill\Database\{Connection, RowMapper};
use Quill\Event\EventDispatcher;
use Quill\Http\{ArticleController, FeedController, Router};
use Quill\Rendering\{HtmlRenderer, JsonFeedRenderer, MarkdownRenderer, PlainTextRenderer, RendererRegistry};
use Quill\Repository\{AuthorRepository, CommentRepository, SqlArticleRepository, TagRepository};
use Quill\Service\{FeedService, PublishService, SearchService, StatsService};
use Quill\Support\{Clock, SystemClock};
use Quill\Validation\ValidatorChain;

/**
 * Wiring. Everything is constructed here and nowhere else, so what depends on
 * what is readable in one file.
 *
 * A new output format is registered in renderers() and needs no other change.
 */
final class Container {
    private array $made = [];

    public function __construct(
        private string $dsn = 'sqlite::memory:',
        private ?Clock $clock = null,
    ) {}

    private function once(string $key, callable $make): mixed {
        return $this->made[$key] ??= $make();
    }

    public function clock(): Clock { return $this->clock ??= new SystemClock(); }

    public function db(): Connection { return $this->once('db', fn () => new Connection($this->dsn)); }
    public function mapper(): RowMapper { return $this->once('map', fn () => new RowMapper()); }
    public function events(): EventDispatcher { return $this->once('events', fn () => new EventDispatcher()); }

    public function tags(): TagRepository { return $this->once('tags', fn () => new TagRepository($this->db(), $this->mapper())); }
    public function authors(): AuthorRepository { return $this->once('authors', fn () => new AuthorRepository($this->db(), $this->mapper())); }
    public function comments(): CommentRepository { return $this->once('comments', fn () => new CommentRepository($this->db(), $this->mapper())); }

    public function articles(): SqlArticleRepository {
        return $this->once('articles', fn () => new SqlArticleRepository($this->db(), $this->mapper(), $this->tags()));
    }

    public function renderers(): RendererRegistry {
        return $this->once('renderers', fn () => (new RendererRegistry())
            ->register(new HtmlRenderer())
            ->register(new MarkdownRenderer())
            ->register(new PlainTextRenderer())
            ->register(new JsonFeedRenderer()));
    }

    public function rules(): ValidatorChain { return $this->once('rules', fn () => ValidatorChain::forArticle()); }

    public function publishing(): PublishService {
        return $this->once('publishing', fn () => new PublishService($this->articles(), $this->rules(), $this->events(), $this->clock()));
    }

    public function search(): SearchService { return $this->once('search', fn () => new SearchService($this->articles())); }
    public function feed(): FeedService { return $this->once('feed', fn () => new FeedService($this->articles(), $this->renderers())); }
    public function stats(): StatsService { return $this->once('stats', fn () => new StatsService($this->db())); }

    public function router(): Router {
        return $this->once('router', function () {
            $articles = new ArticleController($this->renderers(), $this->articles());
            $feed = new FeedController($this->renderers(), $this->articles());
            return (new Router())
                ->get('/articles', fn ($r) => $articles->index($r))
                ->get('/articles/{slug}', fn ($r, $slug) => $articles->show($r, $slug))
                ->get('/feed', fn ($r) => $feed->feed($r));
        });
    }
}
