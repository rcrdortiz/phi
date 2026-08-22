<?php
declare(strict_types=1);
namespace Quill\Http;

final class Request {
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query = [],
        public readonly array $body = [],
        public readonly array $headers = [],
    ) {}

    public static function get(string $path, array $query = []): self {
        return new self('GET', $path, $query);
    }

    public function queryInt(string $key, int $default = 0): int {
        return isset($this->query[$key]) ? (int) $this->query[$key] : $default;
    }

    public function queryString(string $key, ?string $default = null): ?string {
        $v = $this->query[$key] ?? null;
        return is_string($v) && $v !== '' ? $v : $default;
    }

    /** The format asked for, by query string then by Accept, defaulting to html. */
    public function format(): string {
        $q = $this->queryString('format');
        if ($q !== null) return $q;
        $accept = $this->headers['Accept'] ?? '';
        if (str_contains($accept, 'text/markdown')) return 'markdown';
        if (str_contains($accept, 'text/plain')) return 'text';
        return 'html';
    }
}
