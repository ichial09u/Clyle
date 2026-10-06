// Seed the flix disk cache for ep1 from earlier verified resolution data so
// the full proxy path can be exercised while the token endpoint rate-limits.
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const AID = "dmvdjvrznpif";
const MALID = 59145;
const EP = 1;
const PK = "9e68317224136d21ddf91bbb7c660c24c47c7ebcd1a95f78f63d34da628d4a10";
const MASTER_URL =
  "https://fetch9.flixcloud.cc/_v7/a7888069-5bf1-46f8-83f7-b1e374ce5c57/master.m3u8?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ2aWRlb19pZCI6ImE3ODg4MDY5LTViZjEtNDZmOC04M2Y3LWIxZTM3NGNlNWM1NyIsImNsaWVudF9pcCI6IjQ3LjU3LjIzMi4yMzIiLCJleHAiOjE3OTEyNjUwNTMsImlhdCI6MTc5MTI0MzQ1MywiaXNzIjoidmlkZW8taG9zdGluZy1wbGF0Zm9ybSJ9.JnXTVqBFniuZm3BhWSfDqWdolpE7agfabH1jWWVoWN0";

const REFERER = "https://flixcloud.cc/";
const fkey = crypto.createHash("sha1").update(AID).digest("hex").slice(0, 24);

// decrypted master (from the verified probe run), URIs absolutized + token query dropped
const base = new URL(MASTER_URL);
base.search = "";
const abs = (rel) => new URL(rel, base).toString();
const masterText = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="jpn",NAME="Native",DEFAULT=YES,AUTOSELECT=YES,URI="${abs("../VdLh_q2JFTk1pg_5Kc5qZ8R9klQV4JF8DwQ/audio/native.m3u8")}"`,
  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="${abs("../VdLh_q2JFTk1pg_5Kc5qZ8R9klQV4JF8DwQ/audio/english.m3u8")}"`,
  '#EXT-X-STREAM-INF:BANDWIDTH=5184,RESOLUTION=1920x1080,AUDIO="audio",CODECS="avc1.64001f,mp4a.40.2"',
  abs("../VdLh_q2JFTk1pg_5Kc5qZ8R9klQV4JF8DwQ/video.m3u8"),
  "",
].join("\n");

const stream = {
  src: `/api/stream/proxy?type=m3u8&fkey=${fkey}&malId=${MALID}&ep=${EP}&pk=${encodeURIComponent(PK)}&rf=${encodeURIComponent(REFERER)}&u=${encodeURIComponent(MASTER_URL)}`,
  masterUrl: MASTER_URL,
  fkey,
  pk: PK,
  subtitles: [
    { lang: "en", label: "English (SDH)", src: "https://vault-91.rundowncdn.top/subtitles/a7888069-5bf1-46f8-83f7-b1e374ce5c57/eng_3.srt" },
    { lang: "en", label: "English (Dubtitle)", src: "https://vault-91.rundowncdn.top/subtitles/a7888069-5bf1-46f8-83f7-b1e374ce5c57/eng_4.srt" },
    { lang: "en", label: "English", src: "https://vault-91.rundowncdn.top/subtitles/a7888069-5bf1-46f8-83f7-b1e374ce5c57/eng_5.srt" },
  ],
  skip: { intro: { start: 54, end: 144 }, outro: { start: 1292, end: 1382 } },
};

const entry = { data: stream, masterText, expires: Date.now() + 5 * 60 * 60 * 1000 };
mkdirSync("db/flix-cache", { recursive: true });
writeFileSync(`db/flix-cache/${fkey}.json`, JSON.stringify(entry));
console.log("seeded db/flix-cache/" + fkey + ".json");
console.log("stream src:", stream.src);
console.log("master variant:", abs("../VdLh_q2JFTk1pg_5Kc5qZ8R9klQV4JF8DwQ/video.m3u8"));
