// Seed two CW rows for the test profile: one WITH image, one WITHOUT (undefined image
// in the body — mimics a save path where anime.image was undefined, which JSON-drops
// the field server-side and stores NULL on create; the update path never backfills).
const userId = "2fb8ba39-3ca2-4f77-8bbd-b9c6bd9c7395";

const rows = [
  { malId: 52991, title: "Sousou no Frieren", episode: 3, position: 300, duration: 1440, lang: "sub", server: "zoko", image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg" },
  { malId: 40748, title: "Jujutsu Kaisen", episode: 5, position: 240, duration: 1420, lang: "dub", server: "kiwi" }, // NO image field on purpose
];

for (const r of rows) {
  const res = await fetch("http://localhost:3000/api/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, resume: true, ...r }),
  });
  console.log(r.malId, "->", res.status, await res.text());
}

const c = await fetch(`http://localhost:3000/api/continue?userId=${userId}`);
const data = await c.json();
for (const it of data.items) {
  console.log("CW:", it.malId, it.title, "ep", it.episode, "image:", it.image ?? "NULL");
}
