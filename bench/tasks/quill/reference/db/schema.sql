-- Quill schema. SQLite.
CREATE TABLE authors (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE articles (
  id           INTEGER PRIMARY KEY,
  author_id    INTEGER NOT NULL REFERENCES authors(id),
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  published_at INTEGER,
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id),
  tag_id     INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (article_id, tag_id)
);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  author_name TEXT NOT NULL,
  body       TEXT NOT NULL,
  approved   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_articles_status ON articles(status, published_at DESC);
CREATE INDEX idx_article_tags_tag ON article_tags(tag_id);
CREATE INDEX idx_comments_article ON comments(article_id, approved);
