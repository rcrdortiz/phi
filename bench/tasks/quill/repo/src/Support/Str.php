<?php
declare(strict_types=1);
namespace Quill\Support;

final class Str {
    public static function slugify(string $text): string {
        $s = strtolower(trim($text));
        $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
        return trim($s, '-');
    }

    /** Word count, used for reading estimates and excerpt limits. */
    public static function words(string $text): int {
        $trimmed = trim($text);
        if ($trimmed === '') return 0;
        return count(preg_split('/\s+/', $trimmed) ?: []);
    }

    public static function truncateWords(string $text, int $limit, string $suffix = '...'): string {
        $words = preg_split('/\s+/', trim($text)) ?: [];
        if (count($words) <= $limit) return trim($text);
        return implode(' ', array_slice($words, 0, $limit)) . $suffix;
    }

    public static function stripMarkup(string $text): string {
        return trim(strip_tags($text));
    }
}
