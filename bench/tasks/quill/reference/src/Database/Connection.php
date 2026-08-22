<?php
declare(strict_types=1);
namespace Quill\Database;

/** A thin wrapper over PDO. Every query goes through here, so every query is
 *  prepared and every parameter is bound. */
final class Connection {
    private \PDO $pdo;

    public function __construct(string $dsn = 'sqlite::memory:') {
        $this->pdo = new \PDO($dsn, null, null, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
        ]);
        $this->pdo->exec('PRAGMA foreign_keys = ON');
    }

    public function pdo(): \PDO { return $this->pdo; }

    /** @return array<int, array<string, mixed>> */
    public function select(string $sql, array $params = []): array {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    public function selectOne(string $sql, array $params = []): ?array {
        $rows = $this->select($sql, $params);
        return $rows[0] ?? null;
    }

    public function execute(string $sql, array $params = []): int {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount();
    }

    public function runScript(string $sql): void { $this->pdo->exec($sql); }

    public function lastInsertId(): int { return (int) $this->pdo->lastInsertId(); }
}
