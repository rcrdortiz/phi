<?php
declare(strict_types=1);

/** PSR-4 style autoloader for Quill\ -> src/. No composer, no vendor dir. */
spl_autoload_register(static function (string $class): void {
    $prefix = 'Quill\\';
    if (!str_starts_with($class, $prefix)) return;
    $relative = substr($class, strlen($prefix));
    $path = __DIR__ . '/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) require_once $path;
});

// Classes that share a file with their interface are loaded eagerly, because
// the autoloader maps one class to one file by name.
require_once __DIR__ . '/Support/Clock.php';
require_once __DIR__ . '/Support/Result.php';
require_once __DIR__ . '/Event/Event.php';
