<?php
declare(strict_types=1);
namespace Quill\Support;

/** Time, injected rather than read from the global clock, so tests are stable. */
interface Clock { public function now(): int; }

final class SystemClock implements Clock {
    public function now(): int { return time(); }
}

final class FrozenClock implements Clock {
    public function __construct(private int $at) {}
    public function now(): int { return $this->at; }
}
