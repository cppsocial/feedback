SELECT d.resource_id, d.github_node_id, d.up_count, d.down_count,
	d.upvotes, d.fetched_at,
	   COALESCE(json_group_object(rc.reaction, rc.count) FILTER (WHERE rc.reaction IS NOT NULL), '{}')
FROM discussions d
LEFT JOIN reaction_counts rc ON rc.resource_id = d.resource_id
WHERE d.resource_id IN (SELECT value FROM json_each(?))
GROUP BY d.resource_id
