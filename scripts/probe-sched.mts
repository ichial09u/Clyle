// Probe AniList airingSchedule pagination behavior precisely (malId 21)
const Q = `query($idMal: Int, $page: Int, $perPage: Int) {
  Media(idMal: $idMal, type: ANIME) {
    airingSchedule(page: $page, perPage: $perPage) {
      pageInfo { lastPage total }
      nodes { episode airingAt }
    }
  }
}`;
async function probe(page: number, perPage: number) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: Q, variables: { idMal: 21, page, perPage } }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json()) as any;
  if (j.errors?.length) return `page ${page}x${perPage}: ERR ${JSON.stringify(j.errors[0]).slice(0, 120)}`;
  const s = j.data?.Media?.airingSchedule;
  const eps = (s?.nodes ?? []).map((n: any) => n.episode);
  return `page ${page}x${perPage}: lastPage=${s?.pageInfo?.lastPage} total=${s?.pageInfo?.total} nodes=${eps.length} range=${eps[0]}-${eps[eps.length - 1]}`;
}
console.log(await probe(1, 25));
console.log(await probe(1, 50));
console.log(await probe(2, 25));
console.log(await probe(3, 25));
console.log(await probe(2, 50));
console.log(await probe(3, 50));
