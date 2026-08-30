"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, SendHorizonal } from "lucide-react";
import type { CommentItem } from "@/lib/types";
import { timeAgo } from "@/lib/client-store";
import { getUserId, useProfile } from "@/lib/profile-store";

const MAX_LEN = 500;

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
        if (!cancelled) setComments(data.comments ?? []);
      } catch {
        /* keep empty list */
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
    try {
      const userId = getUserId();
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
      if (!res.ok) throw new Error("failed");
      const data = (await res.json()) as { comment: CommentItem };
      setComments((c) => [data.comment, ...c]);
      setText("");
    } catch {
      setError("Could not post — try again in a moment.");
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
