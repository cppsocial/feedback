SELECT d.resource_id, d.id, d.number, d.thumbsup, d.thumbsdown, d.fetched_at,
	   COALESCE(json_group_object(r.reaction, r.count) FILTER (WHERE r.reaction IS NOT NULL), '{}'),
	   p.number IS NOT NULL
FROM discussions d
LEFT JOIN reactions r ON r.object_id = d.id
LEFT JOIN category_pins p ON p.category_key = d.category_key AND p.number = d.number
WHERE d.resource_id > ? AND d.fetched_at <= ?
GROUP BY d.resource_id
ORDER BY d.resource_id
LIMIT ?
