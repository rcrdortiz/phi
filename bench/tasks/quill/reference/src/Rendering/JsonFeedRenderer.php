<?php
declare(strict_types=1);
namespace Quill\Rendering;

use Quill\Domain\Article;
use Quill\Support\Str;

/**
 * JSON Feed 1.1.
 *
 * A new format is a new class and one line of registration. Nothing else in
 * Rendering, Http or Service knows this exists.
 */
final class JsonFeedRenderer implements RendererInterface {
    public function __construct(private string $title = 'Quill') {}

    public function name(): string { return 'jsonfeed'; }
    public function contentType(): string { return 'application/feed+json; charset=utf-8'; }

    public function render(Article $article): string { return $this->feed([$article]); }

    public function renderMany(array $articles): string { return $this->feed($articles); }

    /** @param Article[] $articles */
    private function feed(array $articles): string {
        $sorted = $articles;
        usort($sorted, static fn (Article $a, Article $b) => ($b->publishedAt ?? 0) <=> ($a->publishedAt ?? 0));
        return (string) json_encode([
            'version' => 'https://jsonfeed.org/version/1.1',
            'title' => $this->title,
            'items' => array_map(fn (Article $a) => $this->item($a), $sorted),
        ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    }

    private function item(Article $article): array {
        $item = [
            'id' => $article->slug->value,
            'url' => '/a/' . $article->slug->value,
            'title' => $article->title,
            'content_text' => Str::stripMarkup($article->body),
        ];
        if ($article->publishedAt !== null) {
            $item['date_published'] = gmdate('c', $article->publishedAt);
        }
        $tags = array_map(static fn ($t) => $t->name, $article->tags);
        if ($tags !== []) $item['tags'] = array_values($tags);
        return $item;
    }
}
