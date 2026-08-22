Quill needs to publish a JSON Feed.

Add a new output format named `jsonfeed`, producing `application/feed+json`,
available everywhere the existing formats are: through the renderer registry, on
`/articles?format=jsonfeed`, and through `FeedService`.

The output is a JSON object:

```json
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "Quill",
  "items": [
    {
      "id": "<slug>",
      "url": "/a/<slug>",
      "title": "<title>",
      "content_text": "<body>",
      "date_published": "<published_at as ISO 8601 UTC>",
      "tags": ["<tag name>", "..."]
    }
  ]
}
```

- A single article renders as the same object with one item.
- An article with no tags omits the `tags` key entirely.
- An article that was never published omits `date_published`.
- Items appear newest first.

Everything that worked before must still work: the other formats are unchanged,
and both existing suites still pass.

## Done means

`jsonfeed` is a format like any other, the JSON matches the shape above, and
nothing that worked before is broken.
