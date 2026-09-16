SELECT resource_id, github_node_id, up_count, down_count, fetched_at
FROM discussions
WHERE resource_id IN (SELECT value FROM json_each(?))
