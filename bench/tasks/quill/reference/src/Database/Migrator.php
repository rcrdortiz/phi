<?php
declare(strict_types=1);
namespace Quill\Database;

/** Applies db/migrations in filename order, once each. */
final class Migrator {
    public function __construct(private Connection $db, private string $dir) {}

    public function migrate(): array {
        $this->db->runScript('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, run_at INTEGER NOT NULL)');
        $done = array_column($this->db->select('SELECT name FROM migrations'), 'name');
        $applied = [];
        foreach ($this->files() as $file) {
            $name = basename($file);
            if (in_array($name, $done, true)) continue;
            $this->db->runScript((string) file_get_contents($file));
            $this->db->execute('INSERT INTO migrations (name, run_at) VALUES (?, ?)', [$name, time()]);
            $applied[] = $name;
        }
        return $applied;
    }

    /** @return string[] */
    private function files(): array {
        $files = glob(rtrim($this->dir, '/') . '/*.sql') ?: [];
        sort($files);
        return $files;
    }
}
