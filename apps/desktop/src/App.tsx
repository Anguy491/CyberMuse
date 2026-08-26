import { useState } from "react";

import { AudioSettingsPage } from "./pages/AudioSettingsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ModelAssetsPage } from "./pages/ModelAssetsPage";
import { PracticePage } from "./pages/PracticePage";
import {
  SongService,
  type PracticeAssets,
  type SongServicePort,
  type SongSummary,
} from "./services/song-service";

type PageId = "library" | "practice" | "models" | "audio";

const baseNavigation: ReadonlyArray<{ id: PageId; label: string }> = [
  { id: "library", label: "歌曲库" },
  { id: "models", label: "模型" },
  { id: "audio", label: "音频设置" },
];

interface PracticeSelection {
  song: SongSummary;
  assets: PracticeAssets;
}

interface AppProps {
  songService?: SongServicePort;
}

const defaultSongService = new SongService();

export function App({ songService = defaultSongService }: AppProps) {
  const [page, setPage] = useState<PageId>("library");
  const [practice, setPractice] = useState<PracticeSelection | null>(null);
  const navigation =
    practice === null
      ? baseNavigation
      : [
          { id: "library" as const, label: "歌曲库" },
          { id: "practice" as const, label: "练习" },
          { id: "models" as const, label: "模型" },
          { id: "audio" as const, label: "音频设置" },
        ];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="app-header">
        <a
          className="wordmark"
          href="#main-content"
          aria-label="CyberMuse 首页"
        >
          CYBER<span>MUSE</span>
        </a>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              aria-current={page === item.id ? "page" : undefined}
              className="nav-link"
              key={item.id}
              onClick={() => setPage(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="global-state" aria-label="全局状态">
          <span className="status-shape" aria-hidden="true" />
          本地模式
        </div>
      </header>

      {page === "library" ? (
        <LibraryPage
          service={songService}
          onOpenModels={() => setPage("models")}
          onOpenPractice={(song, assets) => {
            setPractice({ song, assets });
            setPage("practice");
          }}
        />
      ) : null}
      {page === "practice" && practice !== null ? (
        <PracticePage
          assets={practice.assets}
          songTitle={practice.song.displayName}
        />
      ) : null}
      {page === "models" ? <ModelAssetsPage /> : null}
      {page === "audio" ? <AudioSettingsPage /> : null}
    </div>
  );
}
