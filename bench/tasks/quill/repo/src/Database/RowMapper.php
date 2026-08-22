<?php
declare(strict_types=1);
namespace Quill\Database;

use Quill\Domain\{Article, Author, Comment, Slug, Status, Tag};

/** Turns result rows into domain objects. The only place that knows column names. */
final class RowMapper {
    public function article(array $row, array $tags = []): Article {
        return new Article(
            (int) $row['id'],
            (int) $row['author_id'],
            Slug::fromString((string) $row['slug']),
            (string) $row['title'],
            (string) $row['body'],
            Status::fromString((string) $row['status']),
            isset($row['published_at']) ? (int) $row['published_at'] : null,
            isset($row['deleted_at']) ? (int) $row['deleted_at'] : null,
            (int) $row['created_at'],
            (int) $row['updated_at'],
            $tags,
        );
    }

    public function author(array $row): Author {
        return new Author((int) $row['id'], (string) $row['name'], (string) $row['email'], (int) $row['created_at']);
    }

    public function tag(array $row): Tag {
        return new Tag((int) $row['id'], Slug::fromString((string) $row['slug']), (string) $row['name']);
    }

    public function comment(array $row): Comment {
        return new Comment(
            (int) $row['id'], (int) $row['article_id'], (string) $row['author_name'],
            (string) $row['body'], ((int) $row['approved']) === 1, (int) $row['created_at'],
        );
    }
}
