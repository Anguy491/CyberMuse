import { useReducer, useRef, useState } from "react";

import { LibraryPage } from "./pages/LibraryPage";
import { PracticePage } from "./pages/PracticePage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage, type SettingsSectionId } from "./pages/SettingsPage";
import type { PracticeSession, SessionLoopRegion } from "@cybermuse/contracts";
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
  appError,
} from "./services/song-service";
import {
  initialAppRouteState,
  transitionAppRoute,
  type AppRoute,
  type ReviewSelection,
} from "./app-route-machine";

type PageId = "library" | "practice" | "review" | "settings";

interface ActiveSongContext {
  song: SongSummary;
  assets: PracticeAssets | null;
  review: ReviewSelection | null;
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
      <AppContent songService={songService} sessionService={sessionService} />
    </PreferencesProvider>
  );
}

function AppContent({
  songService,
  sessionService,
}: Pick<Required<AppProps>, "songService" | "sessionService">) {
  const { t } = usePreferences();
  const [{ exitRequestId, route }, dispatchRoute] = useReducer(
    transitionAppRoute,
    initialAppRouteState,
  );
  const [activeSong, setActiveSong] = useState<ActiveSongContext | null>(null);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("input-output");
  const navigationSequenceRef = useRef(0);

  const requestNavigation = (destination: AppRoute) => {
    navigationSequenceRef.current += 1;
    setNavigationError(null);
    dispatchRoute({ type: "navigate", destination });
  };

  const openPractice = async (initialLoop: SessionLoopRegion | null) => {
    if (activeSong === null || route.id === "practice") return;
    const requestId = navigationSequenceRef.current + 1;
    navigationSequenceRef.current = requestId;
    setNavigationBusy(true);
    setNavigationError(null);
    try {
      const assets =
        activeSong.assets ??
        (await songService.getPracticeAssets(activeSong.song.songId));
      if (requestId !== navigationSequenceRef.current) return;
      const selection = { song: activeSong.song, assets, initialLoop };
      setActiveSong((current) =>
        current === null ? null : { ...current, assets },
      );
      setNavigationBusy(false);
      requestNavigation({ id: "practice", selection });
    } catch (caught) {
      if (requestId === navigationSequenceRef.current) {
        setNavigationError(appError(caught).code);
      }
    } finally {
      if (requestId === navigationSequenceRef.current) {
        setNavigationBusy(false);
      }
    }
  };

  const handleSessionSaved = (session: PracticeSession) => {
    if (route.id !== "practice") return;
    const selection: ReviewSelection = {
      song: route.selection.song,
      session,
      unavailableRanges: [],
    };
    setActiveSong({
      song: route.selection.song,
      assets: route.selection.assets,
      review: selection,
    });
    dispatchRoute({ type: "practiceSaved", review: selection });
  };

  const handleLeaveWithoutSession = () => {
    dispatchRoute({ type: "practiceLeft" });
  };

  const activeReview = activeSong?.review ?? null;

  const navigation: Array<{
    id: PageId;
    label: string;
    disabled?: boolean;
  }> = [
    {
      id: "library",
      label: t("nav.library"),
    },
    ...(activeSong === null
      ? []
      : [
          {
            id: "practice" as const,
            label: t("nav.practice"),
            disabled: navigationBusy,
          },
        ]),
    ...(activeReview === null
      ? []
      : [
          {
            id: "review" as const,
            label: t("nav.review"),
          },
        ]),
    {
      id: "settings",
      label: t("nav.settings"),
    },
  ];

  const selectNavigation = (page: PageId) => {
    switch (page) {
      case "library":
        requestNavigation({ id: "library" });
        break;
      case "practice":
        void openPractice(null);
        break;
      case "review":
        if (activeReview !== null) {
          requestNavigation({ id: "review", selection: activeReview });
        }
        break;
      case "settings":
        requestNavigation({ id: "settings", section: settingsSection });
        break;
    }
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("app.skip")}
      </a>
      <header className="app-header">
        <a
          className="wordmark"
          href="#library"
          aria-label={t("app.home")}
          onClick={(event) => {
            event.preventDefault();
            requestNavigation({ id: "library" });
          }}
        >
          CYBER<span>MUSE</span>
        </a>
        <nav aria-label={t("app.mainNav")}>
          {navigation.map((item) => (
            <button
              aria-current={route.id === item.id ? "page" : undefined}
              className="nav-link"
              disabled={item.disabled}
              key={item.id}
              onClick={() => selectNavigation(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
        {navigationError === null ? null : (
          <p className="app-navigation-error" role="alert">
            {t("nav.error", { code: navigationError })}
          </p>
        )}
      </header>

      {route.id === "library" ? (
        <LibraryPage
          service={songService}
          onOpenModels={() => {
            setSettingsSection("models");
            requestNavigation({ id: "settings", section: "models" });
          }}
          onOpenStorage={() => {
            setSettingsSection("storage");
            requestNavigation({ id: "settings", section: "storage" });
          }}
          onOpenPractice={(song, assets) => {
            const selection = { song, assets, initialLoop: null };
            setActiveSong((current) => ({
              song,
              assets,
              review:
                current?.song.songId === song.songId ? current.review : null,
            }));
            requestNavigation({ id: "practice", selection });
          }}
          onOpenReview={async (song) => {
            const summaries = await sessionService.list(song.songId);
            const latest = summaries[0];
            if (latest === undefined) throw new Error("session.error.notFound");
            const loaded = await sessionService.get(latest.sessionId);
            const selection = { song, ...loaded };
            setActiveSong((current) => ({
              song,
              assets:
                current?.song.songId === song.songId ? current.assets : null,
              review: selection,
            }));
            requestNavigation({ id: "review", selection });
          }}
        />
      ) : null}
      {route.id === "practice" ? (
        <PracticePage
          assets={route.selection.assets}
          exitRequestId={exitRequestId}
          initialLoop={route.selection.initialLoop}
          sessionService={sessionService}
          songService={songService}
          songTitle={route.selection.song.displayName}
          onExitCancelled={() => {
            dispatchRoute({ type: "practiceExitCancelled" });
          }}
          onLeaveWithoutSession={handleLeaveWithoutSession}
          onSessionSaved={handleSessionSaved}
        />
      ) : null}
      {route.id === "review" ? (
        <ReviewPage
          session={route.selection.session}
          songTitle={route.selection.song.displayName}
          unavailableRanges={route.selection.unavailableRanges}
          onBackToLibrary={() => requestNavigation({ id: "library" })}
          onPracticeRegion={(region) => void openPractice(region)}
          onPracticeSong={() => void openPractice(null)}
        />
      ) : null}
      {route.id === "settings" ? (
        <SettingsPage
          section={route.section}
          onSectionChange={(section) => {
            setSettingsSection(section);
            dispatchRoute({
              type: "navigate",
              destination: { id: "settings", section },
            });
          }}
          onManageSongs={() => requestNavigation({ id: "library" })}
        />
      ) : null}
    </div>
  );
}
