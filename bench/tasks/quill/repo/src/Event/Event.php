<?php
declare(strict_types=1);
namespace Quill\Event;

interface Event { public function name(): string; }

final class ArticlePublished implements Event {
    public function __construct(public readonly int $articleId, public readonly int $at) {}
    public function name(): string { return 'article.published'; }
}

final class ArticleViewed implements Event {
    public function __construct(public readonly int $articleId) {}
    public function name(): string { return 'article.viewed'; }
}
