<?php
declare(strict_types=1);
namespace Quill\Rendering;

use Quill\Domain\Article;
use Quill\Support\Str;

final class PlainTextRenderer implements RendererInterface {
    public function name(): string { return 'text'; }
    public function contentType(): string { return 'text/plain; charset=utf-8'; }

    public function render(Article $article): string {
        return $article->title . "\n" . str_repeat('=', strlen($article->title)) . "\n\n" . Str::stripMarkup($article->body);
    }

    public function renderMany(array $articles): string {
        return implode("\n", array_map(static fn (Article $a) => '- ' . $a->title, $articles));
    }
}
