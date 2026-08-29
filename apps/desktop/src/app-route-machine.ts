import type {
  PracticeSession,
  SessionLoopRegion,
  SessionUnavailableRange,
} from "@cybermuse/contracts";

import type { SettingsSectionId } from "./pages/SettingsPage";
import type { PracticeAssets, SongSummary } from "./services/song-service";

export interface PracticeSelection {
  song: SongSummary;
  assets: PracticeAssets;
  initialLoop: SessionLoopRegion | null;
}

export interface ReviewSelection {
  song: SongSummary;
  session: PracticeSession;
  unavailableRanges: SessionUnavailableRange[];
}

export type AppRoute =
  | { id: "library" }
  | { id: "practice"; selection: PracticeSelection }
  | { id: "review"; selection: ReviewSelection }
  | { id: "settings"; section: SettingsSectionId };

export interface AppRouteState {
  route: AppRoute;
  pendingDestination: AppRoute | null;
  exitRequestId: number | null;
  exitRequestSequence: number;
}

export type AppRouteEvent =
  | { type: "navigate"; destination: AppRoute }
  | { type: "practiceSaved"; review: ReviewSelection }
  | { type: "practiceLeft" }
  | { type: "practiceExitCancelled" };

export const initialAppRouteState: AppRouteState = {
  route: { id: "library" },
  pendingDestination: null,
  exitRequestId: null,
  exitRequestSequence: 0,
};

export function transitionAppRoute(
  state: AppRouteState,
  event: AppRouteEvent,
): AppRouteState {
  switch (event.type) {
    case "navigate":
      if (
        state.route.id === "practice" &&
        event.destination.id !== "practice"
      ) {
        const exitRequestSequence = state.exitRequestSequence + 1;
        return {
          ...state,
          pendingDestination: event.destination,
          exitRequestId: exitRequestSequence,
          exitRequestSequence,
        };
      }
      return {
        ...state,
        route: event.destination,
        pendingDestination: null,
        exitRequestId: null,
      };
    case "practiceSaved":
      return {
        ...state,
        route:
          state.pendingDestination?.id === "library" ||
          state.pendingDestination?.id === "settings"
            ? state.pendingDestination
            : { id: "review", selection: event.review },
        pendingDestination: null,
        exitRequestId: null,
      };
    case "practiceLeft":
      return {
        ...state,
        route: state.pendingDestination ?? { id: "library" },
        pendingDestination: null,
        exitRequestId: null,
      };
    case "practiceExitCancelled":
      return { ...state, pendingDestination: null, exitRequestId: null };
  }
}
