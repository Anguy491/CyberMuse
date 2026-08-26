import { useEffect, useState } from "react";

import { AudioSettingsPage } from "./pages/AudioSettingsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ModelAssetsPage } from "./pages/ModelAssetsPage";
import { PracticePage } from "./pages/PracticePage";
import { ReviewPage } from "./pages/ReviewPage";
import type {
  PracticeSession,
  SessionLoopRegion,
  SessionUnavailableRange,
} from "@cybermuse/contracts";
import {
  PracticeSessionService,
  type PracticeSessionServicePort,
} from "./services/practice-session-service";
import {
  SettingsService,
  type SettingsServicePort,
} from "./services/settings-service";
import {
  SongService,
  type PracticeAssets,
  type SongServicePort,
  type SongSummary,
} from "./services/song-service";

type PageId = "library" | "practice" | "review" | "models" | "audio";

interface PracticeSelection {
  song: SongSummary;
  assets: PracticeAssets;
  initialLoop: SessionLoopRegion | null;
}

interface ReviewSelection {
  song: SongSummary;
  session: PracticeSession;
  unavailableRanges: SessionUnavailableRange[];
}

interface AppProps {
  songService?: SongServicePort;
  sessionService?: PracticeSessionServicePort;
  settingsService?: SettingsServicePort;
}

const defaultSongService = new SongService();
const defaultSessionService = new PracticeSessionService();
const defaultSettingsService = new SettingsService();

export function App({
  songService = defaultSongService,
  sessionService = defaultSessionService,
  settingsService = defaultSettingsService,
}: AppProps) {
  const [page, setPage] = useState<PageId>("library");
  const [practice, setPractice] = useState<PracticeSelection | null>(null);
  const [review, setReview] = useState<ReviewSelection | null>(null);

  useEffect(() => {
    let active = true;
    void settingsService
      .load()
      .then(({ settings }) => {
        if (!active) return;
        document.documentElement.dataset.theme = settings.themePreference;
        document.documentElement.dataset.motion = settings.motionPreference;
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [settingsService]);
  const navigation =
    page === "practice" && practice !== null
      ? [{ id: "practice" as const, label: "练习" }]
      : [
          { id: "library" as const, label: "歌曲库" },
          ...(practice === null
            ? []
            : [{ id: "practice" as const, label: "练习" }]),
          ...(review === null
            ? []
            : [{ id: "review" as const, label: "复盘" }]),
          { id: "models" as const, label: "模型" },
          { id: "audio" as const, label: "音频设置" },
        ];

  const practiceRegion = async (region: SessionLoopRegion) => {
    if (review === null) return;
    const assets = await songService.getPracticeAssets(review.song.songId);
    setPractice({ song: review.song, assets, initialLoop: region });
    setPage("practice");
  };

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
            setPractice({ song, assets, initialLoop: null });
            setPage("practice");
          }}
          onOpenReview={async (song) => {
            const summaries = await sessionService.list(song.songId);
            const latest = summaries[0];
            if (latest === undefined) throw new Error("session.error.notFound");
            const loaded = await sessionService.get(latest.sessionId);
            setReview({ song, ...loaded });
            setPage("review");
          }}
        />
      ) : null}
      {page === "practice" && practice !== null ? (
        <PracticePage
          assets={practice.assets}
          initialLoop={practice.initialLoop}
          sessionService={sessionService}
          settingsService={settingsService}
          songTitle={practice.song.displayName}
          onLeaveWithoutSession={() => setPage("library")}
          onSessionSaved={(session) => {
            setReview({ song: practice.song, session, unavailableRanges: [] });
            setPage("review");
          }}
        />
      ) : null}
      {page === "review" && review !== null ? (
        <ReviewPage
          session={review.session}
          songTitle={review.song.displayName}
          unavailableRanges={review.unavailableRanges}
          onBackToLibrary={() => setPage("library")}
          onPracticeRegion={(region) => void practiceRegion(region)}
        />
      ) : null}
      {page === "models" ? (
        <ModelAssetsPage settingsService={settingsService} />
      ) : null}
      {page === "audio" ? (
        <AudioSettingsPage settingsService={settingsService} />
      ) : null}
    </div>
  );
}
