"use client";

import { Home, Search, Heart, MonitorPlay, Drama, User } from "lucide-react";

export type TabKey = "home" | "genres" | "latest" | "search" | "mylist" | "profile";

const TABS: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string; fill?: string }> }> = [
  { key: "home", label: "Home", icon: Home },
  { key: "genres", label: "Genres", icon: Drama },
  { key: "latest", label: "Latest", icon: MonitorPlay },
  { key: "search", label: "Search", icon: Search },
  { key: "mylist", label: "My List", icon: Heart },
  { key: "profile", label: "Profile", icon: User },
];

export default function BottomNav({ active, onNavigate }: { active: TabKey; onNavigate: (tab: TabKey) => void }) {
  return (
    <nav
      /* < lg: bottom tab bar inside the phone/tablet column. lg+: fixed left
         sidebar rail — the desktop layout's primary navigation. */
      className="fixed z-40 bg-black border-[#1c1c1c] bottom-0 inset-x-0 border-t lg:inset-y-0 lg:right-auto lg:left-0 lg:w-[76px] lg:border-t-0 lg:border-r"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
    >
      <div className="max-w-[560px] md:max-w-[820px] lg:max-w-none mx-auto grid grid-cols-6 lg:flex lg:flex-col lg:h-full lg:gap-1 lg:py-5">
        {TABS.map(({ key, label, icon: Icon }) => {
          const isActive = active === key;
          return (
            <button
              key={key}
              onClick={() => onNavigate(key)}
              className={`flex flex-col items-center gap-1 pt-2.5 pb-2 lg:py-3 transition ${isActive ? "text-white" : "text-[#8a8a8a] hover:text-gray-300"}`}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon className="w-[22px] h-[22px] lg:w-6 lg:h-6" />
              <span className="text-[10.5px] font-medium">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
