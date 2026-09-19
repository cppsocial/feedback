SELECT d.resource_id, d.id, d.thumbsup, d.thumbsdown, d.upvotes, d.fetched_at,
	   COALESCE(json_group_object(r.reaction, r.count) FILTER (WHERE r.reaction IS NOT NULL), '{}')
FROM discussions d
LEFT JOIN (
	SELECT discussion_id, reaction, SUM(count) AS count
	FROM reactions GROUP BY discussion_id, reaction
) r ON r.discussion_id = d.id
WHERE d.resource_id > ? AND d.fetched_at <= ?
GROUP BY d.resource_id
ORDER BY d.resource_id
LIMIT ?
