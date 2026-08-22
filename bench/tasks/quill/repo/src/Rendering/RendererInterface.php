<?php
declare(strict_types=1);
namespace Quill\Rendering;

use Quill\Domain\Article;

/**
 * One output format.
 *
 * A new format is a new class implementing this and registered with the
 * RendererRegistry. Nothing else should need to change: no caller of render()
 * knows which formats exist.
 */
interface RendererInterface {
    /** The format name used in URLs and Accept negotiation, e.g. "html". */
    public function name(): string;

    /** The MIME type this renderer produces. */
    public function contentType(): string;

    public function render(Article $article): string;

    /** @param Article[] $articles */
    public function renderMany(array $articles): string;
}
