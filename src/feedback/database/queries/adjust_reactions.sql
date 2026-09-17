UPDATE discussions
SET
    up_count = MAX(0, up_count + ?),
    down_count = MAX(0, down_count + ?)
WHERE resource_id = ? AND github_node_id = ?
RETURNING up_count, down_count
