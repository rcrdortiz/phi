<?php
declare(strict_types=1);
namespace Quill\Rendering;

use Quill\Domain\Article;

final class HtmlRenderer implements RendererInterface {
    public function name(): string { return 'html'; }
    public function contentType(): string { return 'text/html; charset=utf-8'; }

    public function render(Article $article): string {
        $title = htmlspecialchars($article->title, ENT_QUOTES);
        $body = nl2br(htmlspecialchars($article->body, ENT_QUOTES));
        $tags = implode('', array_map(
            static fn ($t) => '<li class="tag">' . htmlspecialchars($t->name, ENT_QUOTES) . '</li>',
            $article->tags,
        ));
        $minutes = $article->readingTime();
        return "<article class=\"article\">\n"
            . "  <h1 class=\"article-title\">{$title}</h1>\n"
            . "  <p class=\"article-meta\"><span class=\"reading-time\">{$minutes} min read</span></p>\n"
            . ($tags !== '' ? "  <ul class=\"tags\">{$tags}</ul>\n" : '')
            . "  <div class=\"article-body\">{$body}</div>\n"
            . "</article>";
    }

    public function renderMany(array $articles): string {
        $items = array_map(fn (Article $a) => $this->renderCard($a), $articles);
        return "<div class=\"article-list\">\n" . implode("\n", $items) . "\n</div>";
    }

    private function renderCard(Article $article): string {
        $title = htmlspecialchars($article->title, ENT_QUOTES);
        $excerpt = htmlspecialchars((string) $article->excerpt(), ENT_QUOTES);
        $slug = htmlspecialchars($article->slug->value, ENT_QUOTES);
        return "  <a class=\"card\" href=\"/a/{$slug}\"><h2>{$title}</h2><p>{$excerpt}</p></a>";
    }
}
