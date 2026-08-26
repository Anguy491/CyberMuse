import type {
  PracticeSession,
  SessionLoopRegion,
  SessionUnavailableRange,
} from "@cybermuse/contracts";

import { Button } from "../components/Button";
import { PageState } from "../components/PageState";
import {
  buildReviewErrorIntervals,
  reviewBiasSummary,
} from "../review/review-model";

interface ReviewPageProps {
  session: PracticeSession;
  songTitle: string;
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
  onPracticeRegion,
  onBackToLibrary,
  unavailableRanges = [],
}: ReviewPageProps) {
  const intervals = buildReviewErrorIntervals(session);
  const durationMs = Math.max(
    1,
    ...session.takes.map((take) => take.endedAtSongTimeMs),
  );

  return (
    <main className="page review-page" id="main-content">
      <section className="primary-layer review-primary" data-layer="primary">
        <p className="eyebrow">
          REVIEW / SESSION {session.sessionId.slice(0, 8)}
        </p>
        <h1>复盘《{songTitle}》</h1>
        <p className="lede">{reviewBiasSummary(session)}</p>
        <div className="review-hero-metrics" data-pattern-break="review-bias">
          <div>
            <span>MEDIAN ERROR</span>
            <strong>
              {metric(session.metrics.medianAbsoluteErrorCents, "c")}
            </strong>
          </div>
          <div>
            <span>SIGNED BIAS</span>
            <strong>
              {metric(session.metrics.signedMedianErrorCents, "c")}
            </strong>
          </div>
        </div>
      </section>

      <section
        className="secondary-layer review-secondary"
        data-layer="secondary"
        aria-label="练习指标与错误区间"
      >
        <dl className="review-metrics">
          <div>
            <dt>音准准确率</dt>
            <dd>{metric(session.metrics.pitchAccuracy, "%")}</dd>
          </div>
          <div>
            <dt>稳定性</dt>
            <dd>{metric(session.metrics.stability, "%")}</dd>
          </div>
          <div>
            <dt>覆盖率</dt>
            <dd>{metric(session.metrics.coverage, "%")}</dd>
          </div>
          <div>
            <dt>有效帧</dt>
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
            时间线突出持续超过 50 cents 的区间；高低方向同时用文字和线型表达。
          </figcaption>
        </figure>

        {unavailableRanges.length === 0 ? null : (
          <PageState
            code="SESSION_PARTIAL_DATA"
            detail={`${unavailableRanges.length} 个音高数据范围不可用；已保存的整体指标和其他区间仍可复盘，不会把损坏范围显示为准确或失败。`}
            kind="recoverable_error"
            title="部分音高数据已损坏"
          />
        )}

        {intervals.length === 0 ? (
          <PageState
            detail="没有发现持续超过 50 cents 的区间；仍可结合覆盖率和稳定性继续练习。"
            kind="ready"
            title="没有明显持续偏差"
          />
        ) : (
          <ol className="review-intervals" aria-label="可重新练习的错误区间">
            {intervals.map((interval, index) => (
              <li key={`${interval.startMs}-${interval.endMs}-${index}`}>
                <div>
                  <strong>
                    {time(interval.startMs)}–{time(interval.endMs)} ·{" "}
                    {interval.direction === "high"
                      ? "偏高"
                      : interval.direction === "low"
                        ? "偏低"
                        : "高低混合"}
                  </strong>
                  <span>
                    中位绝对误差 {interval.medianAbsoluteErrorCents.toFixed(1)}{" "}
                    cents · {interval.sampleCount} 帧
                  </span>
                </div>
                <Button onClick={() => onPracticeRegion(interval)}>
                  重新练习此处
                </Button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section
        className="tertiary-layer review-tertiary"
        data-layer="tertiary"
        aria-label="会话技术信息"
      >
        <span>TAKES {session.takes.length}</span>
        <span>SCORING {session.scoringVersion}</span>
        <span>
          LATENCY {session.latencySource.toUpperCase()} /{" "}
          {session.appliedLatencyMs} MS
        </span>
        <span>ANALYSIS {session.analysisId.slice(0, 8)}</span>
        <Button variant="quiet" onClick={onBackToLibrary}>
          返回歌曲库
        </Button>
      </section>
    </main>
  );
}
