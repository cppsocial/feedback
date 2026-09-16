SELECT resource_id, lookup_term, github_node_id, github_number, title, url
FROM discussions
WHERE resource_id = ?
