"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Heart, MessageSquare, MessageCircle, SendHorizonal, Trash2, ChevronDown, ChevronUp, X } from "lucide-react";
import type { CommentItem } from "@/lib/types";
import { timeAgo } from "@/lib/client-store";
import { getUserId, useProfile } from "@/lib/profile-store";

const MAX_LEN = 500;

/**
 * Local mirror of this device's own comments (and its likes).
 *
 * On serverless hosting the comment DB lives in a per-instance temp copy, so
 * posts can disappear when the platform recycles an instance. Mirroring every
 * comment you post (and merging it back into the list) means your own words
 * never visibly vanish — they survive until the server copy catches up.
 * Likes are mirrored separately as a set of comment ids, so your like state
 * stays correct even offline; the server count wins once it is reachable.
 */
const LOCAL_COMMENTS_KEY = "animetest123.localcomments";
const LIKED_IDS_KEY = "animetest123.likedcomments";
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

function readLikedIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(LIKED_IDS_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveLikedIds(ids: Set<string>) {
  try {
    window.localStorage.setItem(LIKED_IDS_KEY, JSON.stringify([...ids].slice(-500)));
  } catch {
    /* storage unavailable — server state still applies on next fetch */
  }
}

/** de-dupe key so a comment that already reached the server isn't shown twice */
const fingerprint = (c: CommentItem) => `${c.userId ?? ""}|${c.parentId ?? ""}|${c.text}`;

/** Community comments on an anime — likes, replies, delete-own; nickname + avatar from your profile. */
export default function CommentsSection({ malId }: { malId: number }) {
  const { profile } = useProfile();
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [myId, setMyId] = useState<string | null>(null);
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());

  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [postingReply, setPostingReply] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    setMyId(getUserId());
    setLikedIds(readLikedIds());
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setComments([]);
    (async () => {
      const me = getUserId(); // make sure an identity exists before first post
      try {
        const res = await fetch(`/api/comments?malId=${malId}&userId=${encodeURIComponent(me)}`);
        if (!res.ok) throw new Error("failed");
        const data = (await res.json()) as { comments: CommentItem[] };
        // merge: server list + local-only mirror entries (newest first)
        const server = data.comments ?? [];
        const seen = new Set(server.map(fingerprint));
        const local = readLocalComments(malId).filter((c) => !seen.has(fingerprint(c)));
        const likes = readLikedIds();
        const merged = [...server, ...local]
          .map((c) => ({
            ...c,
            // union of server truth + this device's offline likes
            likedByMe: c.likedByMe || likes.has(c.id),
          }))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
          nickname: profile?.nickname ?? "Username",
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
        nickname: profile?.nickname ?? "Username",
        avatar: profile?.avatar ?? null,
        text: body,
        createdAt: new Date().toISOString(),
        parentId: null,
        likes: 0,
        likedByMe: false,
      };
      saveLocalComment(malId, localOnly);
      setComments((c) => [localOnly, ...c]);
      setText("");
      setError("Couldn't reach the server — kept on this device.");
    } finally {
      setPosting(false);
    }
  }, [malId, posting, profile?.nickname, profile?.avatar, text]);

  const postReply = useCallback(
    async (parentId: string) => {
      const body = replyText.trim();
      if (!body || postingReply) return;
      setPostingReply(true);
      setError(null);
      const userId = getUserId();
      const optimistic: CommentItem = {
        id: `local-${Date.now()}`,
        userId,
        nickname: profile?.nickname ?? "Username",
        avatar: profile?.avatar ?? null,
        text: body,
        createdAt: new Date().toISOString(),
        parentId,
        likes: 0,
        likedByMe: false,
      };
      // optimistic add + expand so the reply appears instantly
      setComments((c) => [...c, optimistic]);
      setExpanded((e) => new Set(e).add(parentId));
      const replySnapshot = replyText;
      setReplyText("");
      setReplyTo(null);
      try {
        const res = await fetch("/api/comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            malId,
            userId,
            nickname: profile?.nickname ?? "Username",
            avatar: profile?.avatar ?? null,
            text: replySnapshot,
            parentId,
          }),
        });
        const data = (await res.json()) as { comment: CommentItem };
        if (!res.ok || !data.comment?.id) throw new Error("failed");
        saveLocalComment(malId, data.comment);
        // swap the optimistic entry for the server copy
        setComments((c) => c.map((x) => (x.id === optimistic.id ? data.comment : x)));
      } catch {
        saveLocalComment(malId, optimistic); // kept on this device
        setError("Couldn't reach the server — reply kept on this device.");
      } finally {
        setPostingReply(false);
      }
    },
    [malId, postingReply, profile?.nickname, profile?.avatar, replyText],
  );

  const toggleLike = useCallback(
    async (target: CommentItem) => {
      const me = myId ?? getUserId();
      const willLike = !target.likedByMe;
      // optimistic flip
      setComments((prev) =>
        prev.map((x) =>
          x.id === target.id
            ? { ...x, likedByMe: willLike, likes: Math.max(0, (x.likes ?? 0) + (willLike ? 1 : -1)) }
            : x,
        ),
      );
      setLikedIds((prev) => {
        const next = new Set(prev);
        if (willLike) next.add(target.id);
        else next.delete(target.id);
        saveLikedIds(next);
        return next;
      });
      if (target.id.startsWith("local-")) return; // server copy doesn't exist yet
      try {
        const res = await fetch("/api/comments/like", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commentId: target.id, userId: me }),
        });
        if (!res.ok) throw new Error("failed");
        const data = (await res.json()) as { liked: boolean; likes: number };
        setComments((prev) =>
          prev.map((x) => (x.id === target.id ? { ...x, likedByMe: data.liked, likes: data.likes } : x)),
        );
      } catch {
        /* offline — optimistic local state stands; server reconciles on next load */
      }
    },
    [myId],
  );

  const removeComment = useCallback(
    async (target: CommentItem) => {
      if (deletingId) return;
      if (!window.confirm(target.parentId ? "Delete this reply?" : "Delete this comment?")) return;
      setDeletingId(target.id);
      const me = myId ?? getUserId();
      // optimistic removal (also drops its replies from the list)
      const before = comments;
      setComments((prev) => prev.filter((x) => x.id !== target.id && x.parentId !== target.id));
      try {
        const res = await fetch("/api/comments", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: target.id, userId: me }),
        });
        if (!res.ok) throw new Error("failed");
      } catch {
        setComments(before); // put it back — server still has it
        setError("Couldn't delete — server unreachable.");
      } finally {
        setDeletingId(null);
      }
    },
    [comments, deletingId, myId],
  );

  /* ---- tree derivation: top-level desc, replies chronological ---- */
  const { tops, repliesByParent } = useMemo(() => {
    const topsList = comments
      .filter((c) => !c.parentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const byParent: Record<string, CommentItem[]> = {};
    for (const c of comments) {
      if (!c.parentId) continue;
      (byParent[c.parentId] ??= []).push(c);
    }
    for (const key of Object.keys(byParent)) {
      byParent[key].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    return { tops: topsList, repliesByParent: byParent };
  }, [comments]);

  const initial = (profile?.nickname ?? "O").trim().charAt(0).toUpperCase() || "O";

  const avatarEl = (src: string | null, name: string, size: "sm" | "md") => {
    const dim = size === "sm" ? "w-6 h-6 text-[11px]" : "w-8 h-8 text-[13px]";
    return src ? (
      <img src={src} alt="" className={`${dim} rounded-full object-cover shrink-0`} />
    ) : (
      <span className={`${dim} rounded-full bg-[#2a2a2a] flex items-center justify-center font-bold text-gray-300 shrink-0`}>
        {(name ?? "?").charAt(0).toUpperCase()}
      </span>
    );
  };

  const actionBtn = "flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-200 transition active:scale-95";

  const likeRow = (c: CommentItem) => {
    const liked = !!c.likedByMe;
    return (
      <button onClick={() => toggleLike(c)} className={`${actionBtn} ${liked ? "text-[#ff5252]" : ""}`} aria-label={liked ? "Unlike" : "Like"} aria-pressed={liked}>
        <Heart className={`w-3.5 h-3.5 ${liked ? "fill-[#ff5252]" : ""}`} />
        {c.likes && c.likes > 0 ? <span className="tabular-nums">{c.likes}</span> : <span>Like</span>}
      </button>
    );
  };

  const renderReply = (r: CommentItem) => (
    <li key={r.id} className="flex gap-2 ml-10">
      {avatarEl(r.avatar, r.nickname, "sm")}
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] font-bold text-gray-200">
          {r.nickname}
          {r.userId && r.userId === myId ? <span className="ml-1.5 text-[9.5px] text-gray-500 font-normal">(you)</span> : null}
          <span className="ml-2 font-normal text-[10px] text-gray-500">{timeAgo(r.createdAt)}</span>
        </p>
        <p className="text-[12.5px] text-gray-100 leading-relaxed break-words mt-0.5">{r.text}</p>
        <div className="flex items-center gap-3 mt-1">
          {likeRow(r)}
          {r.userId && r.userId === myId ? (
            <button
              onClick={() => removeComment(r)}
              disabled={deletingId === r.id}
              className={`${actionBtn} hover:text-[#ff8a80]`}
              aria-label="Delete reply"
            >
              <Trash2 className="w-3 h-3" /> {deletingId === r.id ? "…" : ""}
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );

  const renderTop = (c: CommentItem) => {
    const replies = repliesByParent[c.id] ?? [];
    const isOpen = expanded.has(c.id);
    const isReplying = replyTo === c.id;
    return (
      <li key={c.id} className="flex gap-2.5">
        {avatarEl(c.avatar, c.nickname, "md")}
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold text-gray-200">
            {c.nickname}
            {c.userId && c.userId === myId ? <span className="ml-1.5 text-[10px] text-gray-500 font-normal">(you)</span> : null}
            <span className="ml-2 font-normal text-[10.5px] text-gray-500">{timeAgo(c.createdAt)}</span>
          </p>
          <p className="text-[13px] text-gray-100 leading-relaxed break-words mt-0.5">{c.text}</p>

          {/* actions: like · reply · delete(own) */}
          <div className="flex items-center gap-4 mt-1.5">
            {likeRow(c)}
            <button onClick={() => { setReplyTo(isReplying ? null : c.id); setReplyText(""); }} className={actionBtn} aria-label="Reply">
              <MessageCircle className="w-3.5 h-3.5" /> Reply
            </button>
            {c.userId && c.userId === myId ? (
              <button
                onClick={() => removeComment(c)}
                disabled={deletingId === c.id}
                className={`${actionBtn} hover:text-[#ff8a80]`}
                aria-label="Delete comment"
              >
                <Trash2 className="w-3.5 h-3.5" /> {deletingId === c.id ? "Deleting…" : "Delete"}
              </button>
            ) : null}
            {replies.length > 0 ? (
              <button
                onClick={() =>
                  setExpanded((e) => {
                    const next = new Set(e);
                    if (next.has(c.id)) next.delete(c.id);
                    else next.add(c.id);
                    return next;
                  })
                }
                className={actionBtn}
                aria-expanded={isOpen}
              >
                {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {replies.length} {replies.length === 1 ? "reply" : "replies"}
              </button>
            ) : null}
          </div>

          {/* inline reply composer */}
          {isReplying ? (
            <div className="mt-2 rounded-lg bg-[#101010] border border-[#242424] p-2.5">
              <div className="flex items-center justify-between pb-1.5">
                <span className="text-[10.5px] text-gray-500">Replying to {c.nickname}</span>
                <button onClick={() => setReplyTo(null)} className="text-gray-500 hover:text-white" aria-label="Cancel reply">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-start gap-2">
                {avatarEl(profile?.avatar ?? null, profile?.nickname ?? "O", "sm")}
                <textarea
                  autoFocus
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value.slice(0, MAX_LEN))}
                  rows={2}
                  placeholder={`Reply as ${profile?.nickname ?? "Username"}…`}
                  className="flex-1 bg-transparent text-[12.5px] outline-none resize-none placeholder:text-gray-500 leading-relaxed"
                  aria-label="Write a reply"
                />
              </div>
              <div className="flex items-center justify-between mt-1.5 pl-[34px]">
                <span className="text-[10px] text-gray-600 tabular-nums">{replyText.length}/{MAX_LEN}</span>
                <button
                  onClick={() => postReply(c.id)}
                  disabled={!replyText.trim() || postingReply}
                  className="flex items-center gap-1.5 bg-[#d32f2f] hover:bg-[#b71c1c] disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11.5px] font-bold rounded-full px-3 py-1.5 transition active:scale-95"
                  aria-label="Post reply"
                >
                  <SendHorizonal className="w-3 h-3" />
                  {postingReply ? "Posting…" : "Reply"}
                </button>
              </div>
            </div>
          ) : null}

          {/* replies */}
          {replies.length > 0 && isOpen ? (
            <ul className="mt-2.5 space-y-2.5 border-l border-[#222] pl-3">{replies.map(renderReply)}</ul>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <section className="mt-7 px-4 lg:max-w-[1100px] lg:mx-auto">
      <h2 className="font-slab text-[21px] font-bold mb-3 flex items-center gap-2">
        <MessageSquare className="w-[19px] h-[19px] text-[#ff5252]" />
        Comments
        {loaded ? <span className="text-[12px] text-gray-500 font-normal">({tops.length})</span> : null}
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
            placeholder={`Add a comment as ${profile?.nickname ?? "Username"}…`}
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
      ) : tops.length === 0 ? (
        <p className="mt-4 text-[12.5px] text-gray-500">No comments yet — be the first!</p>
      ) : (
        <ul className="mt-3 space-y-3.5">{tops.map(renderTop)}</ul>
      )}
    </section>
  );
}
