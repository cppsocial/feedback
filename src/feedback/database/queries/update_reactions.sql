UPDATE discussions
SET
    up_count = ?,
    down_count = ?,
    upvotes = ?,
    locked = ?,
    github_updated_at = ?,
    fetched_at = ?
WHERE github_node_id = ?
