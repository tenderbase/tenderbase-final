// Buyer directory helpers: derive organizations from the actual Tender -> buyer relationship.
// This intentionally does not alter the database; the API can use these queries to ensure
// organizations represented by tenders are discoverable even when legacy Organization rows
// contain duplicates or role-specific records.
export const buyerDirectorySql = `
SELECT o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint",
       COUNT(t.id)::int AS "tenderCount"
FROM "Organization" o
JOIN "Tender" t ON t."buyerId" = o.id
GROUP BY o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint"
ORDER BY o.name ASC, o.id ASC;
`;

export const buyerSearchSql = `
SELECT o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint",
       COUNT(t.id)::int AS "tenderCount"
FROM "Organization" o
JOIN "Tender" t ON t."buyerId" = o.id
WHERE o.name ILIKE $1
GROUP BY o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint"
ORDER BY o.name ASC, o.id ASC;
`;
