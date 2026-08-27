import { useState } from "react";

import { LibraryPage } from "./pages/LibraryPage";
import { PracticePage } from "./pages/PracticePage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage, type SettingsSectionId } from "./pages/SettingsPage";
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
  PreferencesProvider,
  usePreferences,
} from "./preferences/PreferencesProvider";
import {
  SongService,
  type PracticeAssets,
  type SongServicePort,
  type SongSummary,
} from "./services/song-service";

type PageId = "library" | "practice" | "review" | "settings";

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
  return (
    <PreferencesProvider service={settingsService}>
      <AppContent
        songService={songService}
        sessionService={sessionService}
        settingsService={settingsService}
      />
    </PreferencesProvider>
  );
}

function AppContent({
  songService,
  sessionService,
  settingsService,
}: Required<AppProps>) {
  const { t } = usePreferences();
  const [page, setPage] = useState<PageId>("library");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("input-output");
  const [practice, setPractice] = useState<PracticeSelection | null>(null);
  const [review, setReview] = useState<ReviewSelection | null>(null);

  const navigation =
    page === "practice" && practice !== null
      ? [{ id: "practice" as const, label: t("nav.practice") }]
      : [
          { id: "library" as const, label: t("nav.library") },
          ...(practice === null
            ? []
            : [{ id: "practice" as const, label: t("nav.practice") }]),
          ...(review === null
            ? []
            : [{ id: "review" as const, label: t("nav.review") }]),
          { id: "settings" as const, label: t("nav.settings") },
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
        {t("app.skip")}
      </a>
      <header className="app-header">
        <a className="wordmark" href="#main-content" aria-label={t("app.home")}>
          CYBER<span>MUSE</span>
        </a>
        <nav aria-label={t("app.mainNav")}>
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
      </header>

      {page === "library" ? (
        <LibraryPage
          service={songService}
          onOpenModels={() => {
            setSettingsSection("models");
            setPage("settings");
          }}
          onOpenStorage={() => {
            setSettingsSection("storage");
            setPage("settings");
          }}
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
      {page === "settings" ? (
        <SettingsPage
          section={settingsSection}
          onSectionChange={setSettingsSection}
          onManageSongs={() => setPage("library")}
        />
      ) : null}
    </div>
  );
}
