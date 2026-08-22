<?php
declare(strict_types=1);
namespace Quill\Event;

/** Counts views in memory. A real deployment would persist; the interface is
 *  the same either way. */
final class ViewCounter {
    private array $counts = [];

    public function __invoke(Event $event): void {
        if (!$event instanceof ArticleViewed) return;
        $this->counts[$event->articleId] = ($this->counts[$event->articleId] ?? 0) + 1;
    }

    public function for(int $articleId): int { return $this->counts[$articleId] ?? 0; }
    public function all(): array { return $this->counts; }
}
