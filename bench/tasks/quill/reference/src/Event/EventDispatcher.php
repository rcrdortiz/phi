<?php
declare(strict_types=1);
namespace Quill\Event;

/** Listeners are called in registration order, and a throwing listener does not
 *  stop the others: one broken subscriber must not break publishing. */
final class EventDispatcher {
    /** @var array<string, callable[]> */
    private array $listeners = [];
    private array $failures = [];

    public function on(string $eventName, callable $listener): self {
        $this->listeners[$eventName][] = $listener;
        return $this;
    }

    public function dispatch(Event $event): int {
        $called = 0;
        foreach ($this->listeners[$event->name()] ?? [] as $listener) {
            try { $listener($event); $called++; }
            catch (\Throwable $e) { $this->failures[] = $e->getMessage(); }
        }
        return $called;
    }

    public function failures(): array { return $this->failures; }
}
