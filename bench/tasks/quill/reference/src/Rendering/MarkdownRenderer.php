<?php
declare(strict_types=1);
namespace Quill\Rendering;

use Quill\Domain\Article;

final class MarkdownRenderer implements RendererInterface {
    public function name(): string { return 'markdown'; }
    public function contentType(): string { return 'text/markdown; charset=utf-8'; }

    public function render(Article $article): string {
        $tags = $article->tags === [] ? '' : "\n\nTags: " . implode(', ', array_map(static fn ($t) => $t->name, $article->tags));
        return "# {$article->title}\n\n{$article->body}{$tags}";
    }

    public function renderMany(array $articles): string {
        return implode("\n\n---\n\n", array_map(fn (Article $a) => "## {$a->title}\n\n" . $a->excerpt(), $articles));
    }
}
