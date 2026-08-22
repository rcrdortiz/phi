<?php
declare(strict_types=1);
namespace Quill\Support;

final class Arr {
    /** Group rows by a key, keeping every row. */
    public static function groupBy(array $rows, callable $key): array {
        $out = [];
        foreach ($rows as $row) {
            $k = $key($row);
            if (!array_key_exists($k, $out)) $out[$k] = [];
            $out[$k][] = $row;
        }
        return $out;
    }

    public static function pluck(array $rows, string $field): array {
        return array_values(array_map(static fn ($r) => is_array($r) ? ($r[$field] ?? null) : $r->$field, $rows));
    }

    public static function first(array $rows, callable $where): mixed {
        foreach ($rows as $row) if ($where($row)) return $row;
        return null;
    }
}
