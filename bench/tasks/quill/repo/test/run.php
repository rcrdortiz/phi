<?php
declare(strict_types=1);

/**
 * The visible suite. It passes today, and it does not cover the defects: a
 * failing test would say where to look, and looking is the job.
 */
require_once __DIR__ . '/../bin/seed.php';

use Quill\Container;
use Quill\Domain\{Slug, Status};
use Quill\Http\Request;
use Quill\Query\{Criteria, Paginator};
use Quill\Support\Str;
use Quill\Validation\ValidatorChain;

$pass = 0; $fail = 0;
function check(string $name, callable $fn): void {
    global $pass, $fail;
    try {
        $ok = $fn();
        if ($ok === true) { $pass++; echo "ok   {$name}\n"; }
        else { $fail++; echo "FAIL {$name}\n     " . var_export($ok, true) . "\n"; }
    } catch (\Throwable $e) {
        $fail++; echo "FAIL {$name}\n     " . $e->getMessage() . "\n";
    }
}

check('slugify turns a title into a slug', fn () => Str::slugify('On Loops & Things') === 'on-loops-things');
check('word count ignores extra whitespace', fn () => Str::words("  one   two three ") === 3);
check('truncateWords keeps the limit', fn () => Str::truncateWords('a b c d e', 3) === 'a b c...');

check('a slug round trips', fn () => Slug::fromTitle('On Cards')->value === 'on-cards');
check('status knows what is public', fn () => Status::Published->isPublic() && !Status::Draft->isPublic());

check('validation reports every problem at once', function () {
    $problems = ValidatorChain::forArticle()->validate(['title' => '', 'slug' => 'Bad Slug', 'body' => 'too short']);
    return count($problems) >= 3;
});
check('a good article validates clean', function () {
    $body = implode(' ', array_fill(0, 30, 'word'));
    return ValidatorChain::forArticle()->validate([
        'title' => 'A Title', 'slug' => 'a-title', 'body' => $body, 'tags' => ['engineering'], 'status' => 'draft',
    ]) === [];
});

check('the database seeds', function () {
    $db = quill_seed();
    $row = $db->selectOne('SELECT COUNT(*) AS n FROM articles');
    return ((int) $row['n']) === 7;
});

check('an article is found by slug', function () {
    $c = new Container(); $c->db()->runScript((string) file_get_contents(__DIR__ . '/../db/schema.sql'));
    $c->db()->runScript((string) file_get_contents(__DIR__ . '/../db/seed.sql'));
    $a = $c->articles()->findBySlug('on-loops');
    return $a !== null && $a->title === 'On Loops';
});

check('a soft-deleted article is not found', function () {
    $c = new Container(); $c->db()->runScript((string) file_get_contents(__DIR__ . '/../db/schema.sql'));
    $c->db()->runScript((string) file_get_contents(__DIR__ . '/../db/seed.sql'));
    return $c->articles()->findBySlug('on-removals') === null;
});

check('the renderer registry knows its formats', function () {
    $names = (new Container())->renderers()->names();
    return in_array('html', $names, true) && in_array('markdown', $names, true) && in_array('text', $names, true);
});

check('html rendering escapes the title', function () {
    $c = new Container(); $c->db()->runScript((string) file_get_contents(__DIR__ . '/../db/schema.sql'));
    $c->db()->runScript((string) file_get_contents(__DIR__ . '/../db/seed.sql'));
    $a = $c->articles()->findBySlug('on-loops');
    $html = $c->renderers()->get('html')->render($a);
    return str_contains($html, '<h1 class="article-title">On Loops</h1>');
});

check('the router serves an article', function () {
    $c = new Container(); $c->db()->runScript((string) file_get_contents(__DIR__ . '/../db/schema.sql'));
    $c->db()->runScript((string) file_get_contents(__DIR__ . '/../db/seed.sql'));
    $res = $c->router()->dispatch(Request::get('/articles/on-loops'));
    return $res->isOk() && str_contains($res->body, 'On Loops');
});

check('an unknown path is a 404', function () {
    $res = (new Container())->router()->dispatch(Request::get('/nope'));
    return $res->status === 404;
});

check('a paginator reports its pages', fn () => (new Paginator(1, 10))->pagesFor(25) === 3);
check('criteria narrows to published', fn () => Criteria::published()->status === Status::Published);

echo "\n{$pass} passed, {$fail} failed\n";
exit($fail > 0 ? 1 : 0);
