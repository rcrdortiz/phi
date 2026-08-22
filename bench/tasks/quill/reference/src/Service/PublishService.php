<?php
declare(strict_types=1);
namespace Quill\Service;

use Quill\Domain\Article;
use Quill\Event\{ArticlePublished, EventDispatcher};
use Quill\Repository\ArticleRepository;
use Quill\Support\{Clock, Result};
use Quill\Validation\ValidatorChain;

/** Publishing an article: validate, transition, persist, announce. */
final class PublishService {
    public function __construct(
        private ArticleRepository $articles,
        private ValidatorChain $rules,
        private EventDispatcher $events,
        private Clock $clock,
    ) {}

    public function publish(int $articleId): Result {
        $article = $this->articles->findById($articleId);
        if ($article === null) return Result::fail('no such article');

        $problems = $this->rules->validate([
            'title' => $article->title,
            'slug' => $article->slug->value,
            'body' => $article->body,
            'tags' => $article->tagSlugs(),
            'status' => 'published',
        ]);
        if ($problems !== []) return Result::fail(...$problems);

        $published = $this->articles->save($article->publish($this->clock->now()));
        $this->events->dispatch(new ArticlePublished($published->id, $published->publishedAt ?? 0));
        return Result::ok($published);
    }
}
