// Reproduce the anilist 400 with the exact lib payload
const query = `
    query AirTail($idMal: Int, $page: Int, $perPage: Int) {
      Media(idMal: $idMal, type: ANIME) {
        airingSchedule(page: $page, perPage: $perPage) {
          pageInfo { lastPage }
          nodes { episode airingAt }
        }
      }
    }`;
const res = await fetch("https://graphql.anilist.co", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ query, variables: { idMal: 21, page: 1, perPage: 1 } }),
  cache: "no-store",
  signal: AbortSignal.timeout(15_000),
});
console.log("status", res.status);
const j = await res.json().catch(() => null);
console.log(JSON.stringify(j)?.slice(0, 500));
