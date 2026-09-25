SELECT d.resource_id, d.id, d.number, d.thumbsup, d.thumbsdown, d.fetched_at,
	   COALESCE(json_group_object(r.reaction, r.count) FILTER (WHERE r.reaction IS NOT NULL), '{}')
FROM discussions d
LEFT JOIN reactions r ON r.object_id = d.id
WHERE d.resource_id > ? AND d.fetched_at <= ?
GROUP BY d.resource_id
ORDER BY d.resource_id
LIMIT ?
