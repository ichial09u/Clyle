"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, SendHorizonal } from "lucide-react";
import type { CommentItem } from "@/lib/types";
import { timeAgo } from "@/lib/client-store";
import { getUserId, useProfile } from "@/lib/profile-store";

const MAX_LEN = 500;

/**
 * Local mirror of this device's own comments.
 *
 * On serverless hosting the comment DB lives in a per-instance temp copy, so
 * posts can disappear when the platform recycles an instance. Mirroring every
 * comment you post (and merging it back into the list) means your own words
 * never visibly vanish — they survive until the server copy catches up.
 */
const LOCAL_COMMENTS_KEY = "animetest123.localcomments";
type LocalCommentMap = Record<string, CommentItem[]>;

function readLocalComments(malId: number): CommentItem[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_COMMENTS_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as LocalCommentMap;
    const list = map[String(malId)];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveLocalComment(malId: number, comment: CommentItem) {
  try {
    const raw = window.localStorage.getItem(LOCAL_COMMENTS_KEY);
    const map = (raw ? JSON.parse(raw) : {}) as LocalCommentMap;
    const key = String(malId);
    const list = Array.isArray(map[key]) ? map[key] : [];
    map[key] = [comment, ...list.filter((c) => c.id !== comment.id)].slice(0, 50);
    window.localStorage.setItem(LOCAL_COMMENTS_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable/full — server copy is still the source of truth */
  }
}

/** de-dupe key so a comment that already reached the server isn't shown twice */
const fingerprint = (c: CommentItem) => `${c.userId ?? ""}|${c.text}`;

/** Community comments on an anime — nickname + avatar from your profile. */
export default function CommentsSection({ malId }: { malId: number }) {
  const { profile } = useProfile();
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setComments([]);
    (async () => {
      try {
        getUserId(); // make sure an identity exists before first post
        const res = await fetch(`/api/comments?malId=${malId}`);
        if (!res.ok) throw new Error("failed");
        const data = (await res.json()) as { comments: CommentItem[] };
        // merge: server list + local-only mirror entries (newest first)
        const server = data.comments ?? [];
        const seen = new Set(server.map(fingerprint));
        const localOnly = readLocalComments(malId).filter((c) => !seen.has(fingerprint(c)));
        const merged = [...server, ...localOnly].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        if (!cancelled) setComments(merged);
      } catch {
        /* server unreachable — still show the local mirror so nothing is lost */
        if (!cancelled) setComments(readLocalComments(malId));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [malId]);

  const post = useCallback(async () => {
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    setError(null);
    const userId = getUserId(); // identity exists even if the request fails
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          malId,
          userId,
          nickname: profile?.nickname ?? "Otaku",
          avatar: profile?.avatar ?? null,
          text: body,
        }),
      });
      const data = (await res.json()) as { comment: CommentItem };
      if (!res.ok || !data.comment?.id) throw new Error("failed");
      saveLocalComment(malId, data.comment); // mirror so it survives server resets
      setComments((c) => [data.comment, ...c]);
      setText("");
    } catch {
      // server didn't take it — keep it on this device instead of losing the words
      const localOnly: CommentItem = {
        id: `local-${Date.now()}`,
        userId,
        nickname: profile?.nickname ?? "Otaku",
        avatar: profile?.avatar ?? null,
        text: body,
        createdAt: new Date().toISOString(),
      };
      saveLocalComment(malId, localOnly);
      setComments((c) => [localOnly, ...c]);
      setText("");
      setError("Couldn't reach the server — kept on this device.");
    } finally {
      setPosting(false);
    }
  }, [malId, posting, profile?.nickname, profile?.avatar, text]);

  const initial = (profile?.nickname ?? "O").trim().charAt(0).toUpperCase() || "O";

  return (
    <section className="mt-7 px-4">
      <h2 className="font-slab text-[21px] font-bold mb-3 flex items-center gap-2">
        <MessageSquare className="w-[19px] h-[19px] text-[#ff5252]" />
        Comments
        {loaded ? <span className="text-[12px] text-gray-500 font-normal">({comments.length})</span> : null}
      </h2>

      {/* composer */}
      <div className="rounded-lg bg-[#141414] border border-[#242424] p-3">
        <div className="flex items-start gap-2.5">
          {profile?.avatar ? (
            <img src={profile.avatar} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
          ) : (
            <span className="w-8 h-8 rounded-full bg-[#2a2a2a] flex items-center justify-center text-[13px] font-bold text-gray-300 shrink-0">
              {initial}
            </span>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
            placeholder={`Add a comment as ${profile?.nickname ?? "Otaku"}…`}
            rows={2}
            className="flex-1 bg-transparent text-[13px] outline-none resize-none placeholder:text-gray-500 leading-relaxed"
            aria-label="Write a comment"
          />
        </div>
        <div className="flex items-center justify-between mt-2 pl-[42px]">
          <span className="text-[10.5px] text-gray-600 tabular-nums">
            {text.length}/{MAX_LEN}
          </span>
          <button
            onClick={post}
            disabled={!text.trim() || posting}
            className="flex items-center gap-1.5 bg-[#d32f2f] hover:bg-[#b71c1c] disabled:opacity-40 disabled:cursor-not-allowed text-white text-[12px] font-bold rounded-full px-3.5 py-1.5 transition active:scale-95"
            aria-label="Post comment"
          >
            <SendHorizonal className="w-3.5 h-3.5" />
            {posting ? "Posting…" : "Post"}
          </button>
        </div>
        {error ? <p className="mt-1 pl-[42px] text-[11px] text-[#ff8a80]">{error}</p> : null}
      </div>

      {/* list */}
      {!loaded ? (
        <div className="mt-3 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex gap-2.5 animate-pulse">
              <div className="w-8 h-8 rounded-full bg-[#1c1c1c] shrink-0" />
              <div className="flex-1 space-y-1.5 py-1">
                <div className="h-2.5 w-24 bg-[#1c1c1c] rounded" />
                <div className="h-2.5 w-full bg-[#181818] rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : comments.length === 0 ? (
        <p className="mt-4 text-[12.5px] text-gray-500">No comments yet — be the first!</p>
      ) : (
        <ul className="mt-3 space-y-3.5">
          {comments.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              {c.avatar ? (
                <img src={c.avatar} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
              ) : (
                <span className="w-8 h-8 rounded-full bg-[#2a2a2a] flex items-center justify-center text-[13px] font-bold text-gray-300 shrink-0">
                  {(c.nickname ?? "?").charAt(0).toUpperCase()}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-bold text-gray-200">
                  {c.nickname}
                  <span className="ml-2 font-normal text-[10.5px] text-gray-500">{timeAgo(c.createdAt)}</span>
                </p>
                <p className="text-[13px] text-gray-100 leading-relaxed break-words mt-0.5">{c.text}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
