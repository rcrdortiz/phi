<?php
declare(strict_types=1);
namespace Quill\Rendering;

/** The set of available formats. Registration is the only wiring a new format
 *  needs; lookup is by the name the renderer declares. */
final class RendererRegistry {
    /** @var array<string, RendererInterface> */
    private array $renderers = [];

    public function register(RendererInterface $renderer): self {
        $this->renderers[$renderer->name()] = $renderer;
        return $this;
    }

    public function has(string $name): bool { return isset($this->renderers[$name]); }

    public function get(string $name): RendererInterface {
        return $this->renderers[$name] ?? throw new \InvalidArgumentException("no renderer for {$name}");
    }

    /** @return string[] */
    public function names(): array { return array_keys($this->renderers); }

    public function default(): RendererInterface {
        return $this->renderers['html'] ?? throw new \RuntimeException('no default renderer');
    }
}
