<?php
declare(strict_types=1);
namespace Quill\Http;

use Quill\Rendering\RendererRegistry;

abstract class Controller {
    public function __construct(protected RendererRegistry $renderers) {}

    /** Pick the renderer the request asked for, falling back to the default. */
    protected function rendererFor(Request $request): \Quill\Rendering\RendererInterface {
        $name = $request->format();
        return $this->renderers->has($name) ? $this->renderers->get($name) : $this->renderers->default();
    }
}
