"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bell, BellOff, BellRing, Check, ImagePlus, RotateCcw, Trash2, Tv } from "lucide-react";
import {
  ACCENTS, SUB_COLORS, SUB_SIZES, updateAppSettings, useAppSettings,
  loadContinueItems, removeProgress, type AppSettings, type SubOutline, type SubSize,
} from "@/lib/client-store";
import { disablePush, enablePush, getPushEndpoint, pushPermission, pushSupported } from "@/lib/push-client";

/**
 * The Settings screen — the app's creative control room.
 *
 *   Notifications  push master switch + the per-anime drop watches
 *                  (the bell on an anime's details page) with remove
 *   Playback       prefer DUB, auto-skip intro/ending, autoplay next episode
 *   Subtitles      size / color / backdrop / outline with a live preview
 *   Theme          six accent palettes driving --accent app-wide
 *   App icon       upload your own home-screen icon (or reset)
 *   Storage        clear continue-watching / watch history
 *
 * Everything is device-local (localStorage) and applied to the document
 * through applySettingsToDocument() the moment a control moves.
 */

const SEG = "flex-1 text-[12px] font-semibold py-1.5 rounded-md transition text-center";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="px-1 mb-2 text-[12px] font-bold uppercase tracking-wider text-gray-500">{title}</h3>
      <div className="rounded-2xl bg-[#141414] divide-y divide-white/[0.06] overflow-hidden">{children}</div>
    </section>
  );
}

function ToggleRow({
  title, desc, on, onChange,
}: {
  title: string;
  desc?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button onClick={() => onChange(!on)} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-white/[0.03]">
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] font-semibold text-gray-100">{title}</span>
        {desc ? <span className="block mt-0.5 text-[11.5px] leading-snug text-gray-500">{desc}</span> : null}
      </span>
      <span
        className="relative shrink-0 w-[46px] h-[27px] rounded-full transition-colors"
        style={{ background: on ? "var(--app-accent)" : "#333" }}
        aria-hidden
      >
        <span
          className="absolute top-[3px] w-[21px] h-[21px] rounded-full bg-white shadow transition-all"
          style={{ left: on ? 22 : 3 }}
        />
      </span>
    </button>
  );
}

function Segmented<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: Array<{ id: T; name: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 bg-[#1d1d1d] rounded-lg p-1">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`${SEG} ${value === o.id ? "text-white" : "text-gray-500"}`}
          style={value === o.id ? { background: "var(--app-accent)" } : undefined}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

export default function SettingsView({ onBack }: { onBack: () => void }) {
  const s = useAppSettings();
  const set = (patch: Partial<AppSettings>) => updateAppSettings(patch);

  // notifications state
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [watches, setWatches] = useState<Array<{ malId: number; title: string | null; image: string | null }>>([]);
  const supported = pushSupported();

  // custom icon
  const iconInput = useRef<HTMLInputElement>(null);
  const [iconFlash, setIconFlash] = useState(false);

  // storage clear flashes
  const [clearedCw, setClearedCw] = useState(false);
  const [clearedHist, setHist] = useState(false);

  const loadWatches = async () => {
    const endpoint = await getPushEndpoint();
    if (!endpoint) return setWatches([]);
    try {
      const res = await fetch(`/api/anime-notify?endpoint=${encodeURIComponent(endpoint)}`);
      const data = (await res.json()) as { items?: Array<{ malId: number; title: string | null; image: string | null }> };
      setWatches(data.items ?? []);
    } catch {
      setWatches([]);
    }
  };

  // boot: reflect the real push state (not just the flag)
  useEffect(() => {
    setPushOn(pushSupported() && pushPermission() === "granted" && localStorage.getItem("clyle.push.enabled") === "1");
    void loadWatches();
  }, []);

  const togglePush = async () => {
    setPushBusy(true);
    setPushNote(null);
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
        setWatches([]);
        setPushNote("Notifications are off for this device.");
      } else {
        const r = await enablePush();
        if (r.ok) {
          setPushOn(true);
          setPushNote("Enabled — you'll hear from us when it matters.");
          void loadWatches();
        } else {
          setPushNote(
            r.reason === "denied"
              ? "Permission was blocked — allow notifications for this site in your browser settings."
              : r.reason === "unsupported"
                ? "This browser can't do background notifications (iOS needs the app added to the Home Screen first)."
                : "Couldn't set notifications up — try again in a moment.",
          );
        }
      }
    } finally {
      setPushBusy(false);
    }
  };

  const removeWatch = async (malId: number) => {
    const endpoint = await getPushEndpoint();
    if (endpoint) {
      await fetch("/api/anime-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, malId, on: false }),
      }).catch(() => undefined);
    }
    setWatches((w) => w.filter((x) => x.malId !== malId));
  };

  const pickIcon = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      set({ iconDataUrl: String(reader.result) });
      setIconFlash(true);
      setTimeout(() => setIconFlash(false), 1600);
    };
    reader.readAsDataURL(file);
  };

  const clearContinue = async () => {
    const items = await loadContinueItems();
    for (const it of items) removeProgress(it.malId);
    setClearedCw(true);
    setTimeout(() => setClearedCw(false), 1600);
  };

  const clearHistory = () => {
    try {
      localStorage.removeItem("animetest123.epprogress");
      localStorage.removeItem("animetest123.progress");
      window.dispatchEvent(new Event("progress-changed"));
    } catch {
      /* cosmetic */
    }
    setHist(true);
    setTimeout(() => setHist(false), 1600);
  };

  const previewShadow =
    s.subOutline === "none" ? "none" : s.subOutline === "outline" ? "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000" : "0 1px 4px rgba(0,0,0,.9), 0 0 8px rgba(0,0,0,.55)";

  return (
    <div className="pb-24 lg:max-w-[720px] lg:mx-auto">
      <div className="flex items-center gap-2 px-3 pt-4 pb-1">
        <button onClick={onBack} aria-label="Back" className="p-2 -ml-1 rounded-full hover:bg-white/10 active:scale-90 transition">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="font-slab text-[24px] font-extrabold">Settings</h1>
      </div>
      <p className="px-4 text-[11.5px] text-gray-500">Everything here is saved on this device.</p>

      {/* ---- Notifications ---- */}
      <Section title="Notifications">
        <button
          onClick={togglePush}
          disabled={!supported || pushBusy}
          className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-white/[0.03] disabled:opacity-50"
        >
          <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: pushOn ? "var(--app-accent)" : "#242424" }}>
            {pushOn ? <BellRing className="w-[18px] h-[18px] text-white" /> : <BellOff className="w-[18px] h-[18px] text-gray-400" />}
          </span>
          <span className="flex-1">
            <span className="block text-[14px] font-semibold text-gray-100">Push notifications</span>
            <span className="block mt-0.5 text-[11.5px] text-gray-500">
              {!supported ? "Not supported on this browser/device" : pushOn ? "On for this device" : "Off — tap to enable"}
            </span>
          </span>
          <span
            className="relative shrink-0 w-[46px] h-[27px] rounded-full transition-colors"
            style={{ background: pushOn && supported ? "var(--app-accent)" : "#333" }}
            aria-hidden
          >
            <span className="absolute top-[3px] w-[21px] h-[21px] rounded-full bg-white shadow transition-all" style={{ left: pushOn && supported ? 22 : 3 }} />
          </span>
        </button>
        {pushNote ? <p className="px-4 py-2.5 text-[11.5px] text-gray-400">{pushNote}</p> : null}
        <div className="px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Bell className="w-3.5 h-3.5 text-gray-500" />
            <p className="text-[12px] font-semibold text-gray-300">Anime drop watches</p>
            <span className="text-[11px] text-gray-500">({watches.length})</span>
          </div>
          {watches.length ? (
            <ul className="mt-2.5 space-y-2">
              {watches.map((w) => (
                <li key={w.malId} className="flex items-center gap-2.5 bg-[#1b1b1b] rounded-xl p-2">
                  {w.image ? <img src={w.image} alt="" className="w-9 h-12 object-cover rounded-md" /> : <span className="w-9 h-12 rounded-md bg-[#242424] flex items-center justify-center"><Tv className="w-4 h-4 text-gray-600" /></span>}
                  <span className="flex-1 min-w-0 text-[12.5px] text-gray-200 truncate">{w.title ?? `Anime ${w.malId}`}</span>
                  <button onClick={() => removeWatch(w.malId)} aria-label={`Stop watching ${w.title ?? w.malId}`} className="p-2 rounded-full text-gray-500 hover:text-white hover:bg-white/10 active:scale-90 transition">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[11.5px] leading-snug text-gray-500">
              None yet. Open any airing anime and tap the bell to get notified the moment its next episode drops — that anime only.
            </p>
          )}
        </div>
      </Section>

      {/* ---- Playback ---- */}
      <Section title="Playback">
        <ToggleRow
          title="Prefer DUB"
          desc="Open new anime in English dub when a real one exists (you can still switch per episode)."
          on={s.preferDub}
          onChange={(v) => set({ preferDub: v })}
        />
        <ToggleRow
          title="Auto-skip intro"
          desc="Roll past the opening automatically when we know where it ends."
          on={s.autoSkipIntro}
          onChange={(v) => set({ autoSkipIntro: v })}
        />
        <ToggleRow
          title="Auto-skip ending"
          desc="Jump past the ED as credits start — straight to the next scene."
          on={s.autoSkipOutro}
          onChange={(v) => set({ autoSkipOutro: v })}
        />
        <ToggleRow
          title="Autoplay next episode"
          desc="When an episode ends, start the next one immediately."
          on={s.autoNext}
          onChange={(v) => set({ autoNext: v })}
        />
      </Section>

      {/* ---- Subtitles ---- */}
      <Section title="Subtitles">
        <div className="px-4 py-3.5">
          {/* live preview */}
          <div className="relative h-[86px] rounded-xl overflow-hidden bg-gradient-to-br from-[#20303f] to-[#0f1a24] mb-3">
            <span
              className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap px-1.5 py-0.5 rounded-sm font-semibold"
              style={{
                color: s.subColor,
                background: `rgba(0,0,0,${s.subBg / 100})`,
                textShadow: previewShadow,
                fontSize: `${(SUB_SIZES.find((x) => x.id === s.subSize) ?? SUB_SIZES[1]).px - 4}px`,
              }}
            >
              Subtitles will look like this
            </span>
          </div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Size</p>
          <Segmented<SubSize> value={s.subSize} options={SUB_SIZES.map(({ id, name }) => ({ id, name }))} onChange={(v) => set({ subSize: v })} />
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mt-3.5 mb-1.5">Color</p>
          <div className="flex gap-2.5">
            {SUB_COLORS.map((c) => (
              <button
                key={c}
                aria-label={`Subtitle color ${c}`}
                onClick={() => set({ subColor: c })}
                className="w-8 h-8 rounded-full border-2 flex items-center justify-center transition"
                style={{ background: c, borderColor: s.subColor === c ? "var(--app-accent)" : "transparent" }}
              >
                {s.subColor === c ? <Check className="w-4 h-4 text-black/70" /> : null}
              </button>
            ))}
          </div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mt-3.5 mb-1.5">Backdrop</p>
          <input
            type="range"
            min={0}
            max={100}
            value={s.subBg}
            onChange={(e) => set({ subBg: Number(e.target.value) })}
            className="w-full accent-[var(--app-accent)]"
            aria-label="Subtitle backdrop darkness"
          />
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mt-3.5 mb-1.5">Outline</p>
          <Segmented<SubOutline>
            value={s.subOutline}
            options={[
              { id: "shadow", name: "Shadow" },
              { id: "outline", name: "Outline" },
              { id: "none", name: "None" },
            ]}
            onChange={(v) => set({ subOutline: v })}
          />
        </div>
      </Section>

      {/* ---- Theme ---- */}
      <Section title="Theme">
        <div className="px-4 py-3.5">
          <p className="text-[11.5px] text-gray-500 mb-2.5">Pick the color Clyle wears.</p>
          <div className="grid grid-cols-3 gap-2.5">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                onClick={() => set({ accent: a.id })}
                className={`relative h-[64px] rounded-xl font-bold text-[12.5px] transition active:scale-95 overflow-hidden ${s.accent === a.id ? "ring-2 ring-white" : ""}`}
                style={{ background: `linear-gradient(150deg, ${a.color}, ${a.deep})`, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,.5)" }}
              >
                {a.name}
                {s.accent === a.id ? <Check className="absolute top-1.5 right-1.5 w-4 h-4 text-white" /> : null}
              </button>
            ))}
          </div>
        </div>
      </Section>

      {/* ---- App icon ---- */}
      <Section title="App icon">
        <div className="px-4 py-3.5 flex items-center gap-3.5">
          <span className="w-14 h-14 rounded-2xl overflow-hidden bg-[#1d1d1d] border border-white/10 flex items-center justify-center shrink-0">
            {s.iconDataUrl ? (
              <img src={s.iconDataUrl} alt="Custom app icon" className="w-full h-full object-cover" />
            ) : (
              <img src="/icon-192.png" alt="Default app icon" className="w-full h-full object-cover" />
            )}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-gray-200">{s.iconDataUrl ? "Your custom icon" : "Default icon"}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-gray-500">
              Use your own image for the home-screen icon. Re-add the app to your Home Screen (iOS) or reinstall (Android) to see it.
            </p>
          </div>
        </div>
        <div className="flex gap-2 px-4 py-3.5">
          <button
            onClick={() => iconInput.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 text-[13px] font-bold py-2.5 rounded-xl active:scale-95 transition"
            style={{ background: "var(--app-accent)" }}
          >
            <ImagePlus className="w-4 h-4" /> Choose image
          </button>
          {s.iconDataUrl ? (
            <button
              onClick={() => set({ iconDataUrl: null })}
              className="flex items-center justify-center gap-2 text-[13px] font-bold px-4 py-2.5 rounded-xl bg-[#242424] text-gray-300 active:scale-95 transition"
            >
              <RotateCcw className="w-4 h-4" /> Reset
            </button>
          ) : null}
          <input
            ref={iconInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickIcon(f);
              e.currentTarget.value = "";
            }}
          />
        </div>
        {iconFlash ? <p className="px-4 pb-3 -mt-1 text-[11.5px] text-emerald-400">Icon applied to this device.</p> : null}
      </Section>

      {/* ---- Storage ---- */}
      <Section title="Storage">
        <ToggleRow
          title={clearedCw ? "Continue watching cleared ✓" : "Clear Continue Watching"}
          desc="Removes every in-progress show from this device."
          on={false}
          onChange={() => void clearContinue()}
        />
        <ToggleRow
          title={clearedHist ? "Watch history cleared ✓" : "Clear watch history"}
          desc="Erases per-episode resume points and watch stats."
          on={false}
          onChange={clearHistory}
        />
      </Section>

      <p className="mt-6 text-center text-[10.5px] text-gray-600">Clyle · built for the binge</p>
    </div>
  );
}
