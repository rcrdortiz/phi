<?php
declare(strict_types=1);
namespace Quill\Http;

final class Response {
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public readonly array $headers = [],
    ) {}

    public static function ok(string $body, string $contentType = 'text/html; charset=utf-8'): self {
        return new self(200, $body, ['Content-Type' => $contentType]);
    }

    public static function notFound(string $message = 'Not Found'): self {
        return new self(404, $message, ['Content-Type' => 'text/plain; charset=utf-8']);
    }

    public static function badRequest(array $problems): self {
        return new self(400, implode("\n", $problems), ['Content-Type' => 'text/plain; charset=utf-8']);
    }

    public function isOk(): bool { return $this->status >= 200 && $this->status < 300; }
}
