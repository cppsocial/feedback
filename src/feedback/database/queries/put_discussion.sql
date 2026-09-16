INSERT INTO discussions (
    resource_id,
    lookup_term,
    github_node_id,
    github_number,
    title,
    url,
    up_count,
    down_count,
    fetched_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(resource_id) DO UPDATE SET
    lookup_term = excluded.lookup_term,
    github_node_id = excluded.github_node_id,
    github_number = excluded.github_number,
    title = excluded.title,
    url = excluded.url,
    up_count = excluded.up_count,
    down_count = excluded.down_count,
    fetched_at = excluded.fetched_at
