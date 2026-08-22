<?php
declare(strict_types=1);
namespace Quill\Database;

/** Runs a closure inside a transaction, rolling back on any throwable. */
final class Transaction {
    public function __construct(private Connection $db) {}

    public function run(callable $work): mixed {
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            $result = $work($this->db);
            $pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }
}
