SELECT d.resource_id, d.id, d.number, d.thumbsup, d.thumbsdown, d.fetched_at,
	   COALESCE(json_group_object(r.reaction, r.count) FILTER (WHERE r.reaction IS NOT NULL), '{}')
FROM discussions d
LEFT JOIN (
	SELECT object_id, reaction, SUM(count) AS count
	FROM reactions GROUP BY object_id, reaction
) r ON r.object_id = d.id
WHERE d.resource_id IN (SELECT value FROM json_each(?))
GROUP BY d.resource_id
