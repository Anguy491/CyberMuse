import type {
  PracticeSession,
  SessionLoopRegion,
  SessionUnavailableRange,
} from "@cybermuse/contracts";

import { Button } from "../components/Button";
import { PageState } from "../components/PageState";
import { useLocalizedText } from "../preferences/PreferencesProvider";
import {
  buildReviewErrorIntervals,
  reviewBiasResult,
} from "../review/review-model";

interface ReviewPageProps {
  session: PracticeSession;
  songTitle: string;
  onPracticeSong: () => void;
  onPracticeRegion: (region: SessionLoopRegion) => void;
  onBackToLibrary: () => void;
  unavailableRanges?: SessionUnavailableRange[];
}

function metric(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value.toFixed(1)}${suffix}`;
}

function time(timeMs: number): string {
  const seconds = Math.max(0, Math.round(timeMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ReviewPage({
  session,
  songTitle,
  onPracticeSong,
  onPracticeRegion,
  onBackToLibrary,
  unavailableRanges = [],
}: ReviewPageProps) {
  const { t } = useLocalizedText();
  const intervals = buildReviewErrorIntervals(session);
  const durationMs = Math.max(
    1,
    ...session.takes.map((take) => take.endedAtSongTimeMs),
  );
  const bias = session.metrics.signedMedianErrorCents;
  const biasResult = reviewBiasResult(session);
  const biasSummary =
    biasResult.direction === "insufficient" || bias === null
      ? t("review.bias.insufficient")
      : biasResult.direction === "centered"
        ? session.pitchEvaluationMode === "octaveFolded" && Math.abs(bias) >= 5
          ? t(bias > 0 ? "review.bias.relaxedHigh" : "review.bias.relaxedLow", {
              cents: Math.abs(bias).toFixed(0),
            })
          : t("review.bias.centered")
        : t(bias > 0 ? "review.bias.high" : "review.bias.low", {
            cents: Math.abs(bias).toFixed(0),
          });

  return (
    <main className="page review-page" id="main-content">
      <section className="primary-layer review-primary" data-layer="primary">
        <h1>{t("review.title", { song: songTitle })}</h1>
        <p className="lede">{biasSummary}</p>
        <p className="review-evaluation-mode">
          {t("review.evaluationMode", {
            mode: t(
              session.pitchEvaluationMode === "absolute"
                ? "review.evaluationMode.absolute"
                : "review.evaluationMode.folded",
            ),
          })}
        </p>
        <div className="primary-actions">
          <Button variant="primary" onClick={onPracticeSong}>
            {t("review.practiceSong")}
          </Button>
          <Button variant="quiet" onClick={onBackToLibrary}>
            {t("review.back")}
          </Button>
        </div>
        <div className="review-hero-metrics" data-pattern-break="review-bias">
          <div>
            <span>{t("review.medianError")}</span>
            <strong>
              {metric(session.metrics.medianAbsoluteErrorCents, "c")}
            </strong>
          </div>
          <div>
            <span>{t("review.signedBias")}</span>
            <strong>
              {metric(session.metrics.signedMedianErrorCents, "c")}
            </strong>
          </div>
        </div>
      </section>

      <section
        className="secondary-layer review-secondary"
        data-layer="secondary"
        aria-label={t("review.contentLabel")}
      >
        <dl className="review-metrics">
          <div>
            <dt>{t("review.accuracy")}</dt>
            <dd>{metric(session.metrics.pitchAccuracy, "%")}</dd>
          </div>
          <div>
            <dt>{t("review.stability")}</dt>
            <dd>{metric(session.metrics.stability, "%")}</dd>
          </div>
          <div>
            <dt>{t("review.coverage")}</dt>
            <dd>{metric(session.metrics.coverage, "%")}</dd>
          </div>
          <div>
            <dt>{t("review.validFrames")}</dt>
            <dd>{session.metrics.validFrameCount}</dd>
          </div>
        </dl>

        <figure
          className="review-timeline"
          aria-labelledby="review-timeline-caption"
        >
          <div className="review-timeline__track" aria-hidden="true">
            {intervals.map((interval, index) => (
              <span
                className={`review-timeline__interval review-timeline__interval--${interval.direction}`}
                key={`${interval.startMs}-${interval.endMs}-${index}`}
                style={{
                  left: `${(100 * interval.startMs) / durationMs}%`,
                  width: `${Math.max(1, (100 * (interval.endMs - interval.startMs)) / durationMs)}%`,
                }}
              />
            ))}
          </div>
          <figcaption id="review-timeline-caption">
            {t("review.timeline")}
          </figcaption>
        </figure>

        {unavailableRanges.length === 0 ? null : (
          <PageState
            code="SESSION_PARTIAL_DATA"
            detail={t("review.partial.detail", {
              count: unavailableRanges.length,
            })}
            kind="recoverable_error"
            title={t("review.partial.title")}
          />
        )}

        {intervals.length === 0 ? (
          <PageState
            detail={t("review.noIntervals.detail")}
            kind="ready"
            title={t("review.noIntervals.title")}
          />
        ) : (
          <ol className="review-intervals" aria-label={t("review.intervals")}>
            {intervals.map((interval, index) => (
              <li key={`${interval.startMs}-${interval.endMs}-${index}`}>
                <div>
                  <strong>
                    {time(interval.startMs)}–{time(interval.endMs)} ·{" "}
                    {interval.direction === "high"
                      ? t("review.direction.high")
                      : interval.direction === "low"
                        ? t("review.direction.low")
                        : t("review.direction.mixed")}
                  </strong>
                  <span>
                    {t("review.interval.detail", {
                      cents: interval.medianAbsoluteErrorCents.toFixed(1),
                      count: interval.sampleCount,
                    })}
                  </span>
                </div>
                <Button onClick={() => onPracticeRegion(interval)}>
                  {t("review.practiceAgain")}
                </Button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
