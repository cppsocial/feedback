UPDATE discussions
SET
    up_count = ?,
    down_count = ?,
    locked = ?,
    github_updated_at = ?,
    fetched_at = ?
WHERE github_node_id = ?
