INSERT INTO discussions (
    resource_id,
    category_key,
    lookup_term,
    id,
    number,
    title,
    url,
    thumbsup,
    thumbsdown,
    fetched_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(resource_id) DO UPDATE SET
    category_key = excluded.category_key,
    lookup_term = excluded.lookup_term,
    id = excluded.id,
    number = excluded.number,
    title = excluded.title,
    url = excluded.url,
    thumbsup = excluded.thumbsup,
    thumbsdown = excluded.thumbsdown,
    fetched_at = excluded.fetched_at
