<?php
declare(strict_types=1);
namespace Quill\Http;

/** Routes by exact path or by a single {param} segment. Small on purpose. */
final class Router {
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): self {
        $this->routes[] = [$method, $pattern, $handler];
        return $this;
    }

    public function get(string $pattern, callable $handler): self { return $this->add('GET', $pattern, $handler); }

    public function dispatch(Request $request): Response {
        foreach ($this->routes as [$method, $pattern, $handler]) {
            if ($method !== $request->method) continue;
            $params = $this->match($pattern, $request->path);
            if ($params === null) continue;
            return $handler($request, ...array_values($params));
        }
        return Response::notFound();
    }

    private function match(string $pattern, string $path): ?array {
        $p = explode('/', trim($pattern, '/'));
        $a = explode('/', trim($path, '/'));
        if (count($p) !== count($a)) return null;
        $params = [];
        foreach ($p as $i => $seg) {
            if (str_starts_with($seg, '{') && str_ends_with($seg, '}')) {
                $params[trim($seg, '{}')] = $a[$i];
                continue;
            }
            if ($seg !== $a[$i]) return null;
        }
        return $params;
    }
}
