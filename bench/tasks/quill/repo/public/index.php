<?php
declare(strict_types=1);

require __DIR__ . '/../src/autoload.php';

use Quill\Container;
use Quill\Http\Request;

$container = new Container(getenv('QUILL_DSN') ?: 'sqlite::memory:');
$request = new Request(
    $_SERVER['REQUEST_METHOD'] ?? 'GET',
    parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/',
    $_GET,
    $_POST,
    ['Accept' => $_SERVER['HTTP_ACCEPT'] ?? ''],
);

$response = $container->router()->dispatch($request);
http_response_code($response->status);
foreach ($response->headers as $name => $value) header("{$name}: {$value}");
echo $response->body;
