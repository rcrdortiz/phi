<?php
declare(strict_types=1);

/** Builds a database from db/schema.sql and db/seed.sql. Used by the tests and
 *  by anyone wanting a populated instance to poke at. */
require_once __DIR__ . '/../src/autoload.php';

use Quill\Database\Connection;

function quill_seed(string $dsn = 'sqlite::memory:'): Connection {
    $db = new Connection($dsn);
    $db->runScript((string) file_get_contents(__DIR__ . '/../db/schema.sql'));
    $db->runScript((string) file_get_contents(__DIR__ . '/../db/seed.sql'));
    return $db;
}

if (PHP_SAPI === 'cli' && isset($argv[0]) && realpath($argv[0]) === realpath(__FILE__)) {
    quill_seed();
    fwrite(STDOUT, "seeded\n");
}
