"use client";

import { Home, Search, Heart, MonitorPlay, Drama } from "lucide-react";

export type TabKey = "home" | "genres" | "latest" | "search" | "mylist";

const TABS: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string; fill?: string }> }> = [
  { key: "home", label: "Home", icon: Home },
  { key: "genres", label: "Genres", icon: Drama },
  { key: "latest", label: "Latest", icon: MonitorPlay },
  { key: "search", label: "Search", icon: Search },
  { key: "mylist", label: "My List", icon: Heart },
];

export default function BottomNav({ active, onNavigate }: { active: TabKey; onNavigate: (tab: TabKey) => void }) {
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 bg-black border-t border-[#1c1c1c]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
    >
      <div className="max-w-[560px] mx-auto grid grid-cols-5">
        {TABS.map(({ key, label, icon: Icon }) => {
          const isActive = active === key;
          return (
            <button
              key={key}
              onClick={() => onNavigate(key)}
              className={`flex flex-col items-center gap-1 pt-2.5 pb-2 transition ${isActive ? "text-white" : "text-[#8a8a8a] hover:text-gray-300"}`}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon className="w-[22px] h-[22px]" />
              <span className="text-[10.5px] font-medium">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
