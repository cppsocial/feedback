SELECT resource_id, category_key, lookup_term, id, number, title, url
FROM discussions
WHERE resource_id = ?
