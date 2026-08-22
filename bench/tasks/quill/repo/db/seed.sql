INSERT INTO authors (id, name, email, created_at) VALUES
  (1, 'Ada Lovelace', 'ada@example.com', 1700000000),
  (2, 'Grace Hopper', 'grace@example.com', 1700000100),
  (3, 'Alan Turing',  'alan@example.com', 1700000200);

INSERT INTO tags (id, slug, name) VALUES
  (1, 'engineering', 'Engineering'),
  (2, 'design', 'Design'),
  (3, 'process', 'Process');

INSERT INTO articles (id, author_id, slug, title, body, status, published_at, deleted_at, created_at, updated_at) VALUES
  (1, 1, 'on-loops',      'On Loops',       'A loop is a repetition. ' || 'word ' || 'more words here to read. ', 'published', 1700001000, NULL, 1700000900, 1700001000),
  (2, 1, 'on-cards',      'On Cards',       'Punched cards were the first program store. ',                       'published', 1700002000, NULL, 1700001900, 1700002000),
  (3, 2, 'on-compilers',  'On Compilers',   'A compiler translates one language into another. ',                  'published', 1700003000, NULL, 1700002900, 1700003000),
  (4, 2, 'on-bugs',       'On Bugs',        'The first bug was a moth. ',                                         'draft',     NULL,       NULL, 1700003900, 1700004000),
  (5, 3, 'on-machines',   'On Machines',    'A machine that can simulate any other machine. ',                    'published', 1700005000, NULL, 1700004900, 1700005000),
  (6, 3, 'on-secrets',    'On Secrets',     'Some work stays hidden for fifty years. ',                           'archived',  1700006000, NULL, 1700005900, 1700006000),
  (7, 1, 'on-removals',   'On Removals',    'This one was taken down. ',                                          'published', 1700007000, 1700008000, 1700006900, 1700008000);

INSERT INTO article_tags (article_id, tag_id) VALUES
  (1, 1), (2, 1), (3, 1), (3, 2), (5, 3);

INSERT INTO comments (id, article_id, author_name, body, approved, created_at) VALUES
  (1, 1, 'reader', 'Good piece.', 1, 1700001100),
  (2, 1, 'spam',   'Buy things.', 0, 1700001200),
  (3, 3, 'reader', 'Clear.',      1, 1700003100);
