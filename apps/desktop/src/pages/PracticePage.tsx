import { Button } from "../components/Button";

export function PracticePage() {
  return (
    <main className="page practice-page" id="main-content">
      <section className="primary-layer practice-primary" data-layer="primary">
        <div className="practice-heading">
          <div>
            <p className="eyebrow">PRACTICE / NO TRACK LOADED</p>
            <h1>练习轨等待歌曲。</h1>
          </div>
          <p className="metric-placeholder" aria-label="当前偏差不可用">
            — <span>CENTS</span>
          </p>
        </div>

        <figure
          className="pitch-lane-shell"
          aria-labelledby="pitch-lane-caption"
        >
          <svg
            aria-hidden="true"
            className="pitch-lane-plot"
            preserveAspectRatio="none"
            viewBox="0 0 1000 280"
          >
            <path
              className="pitch-grid"
              d="M0 70H1000 M0 140H1000 M0 210H1000"
            />
            <path
              className="reference-line"
              d="M0 184 C180 170 250 92 380 118 S650 190 1000 126"
            />
            <path className="user-line" d="M0 218 C140 198 270 150 380 168" />
          </svg>
          <div
            className="now-line"
            data-pattern-break="now-line"
            aria-hidden="true"
          >
            <span>NOW</span>
          </div>
          <figcaption id="pitch-lane-caption">
            尚未加载参考轨，也未检测用户音高。打开一首已完成分析的歌曲后，参考轨使用虚线、用户轨使用实线。
          </figcaption>
        </figure>
      </section>

      <section
        className="secondary-layer practice-controls"
        data-layer="secondary"
        aria-label="练习控制"
      >
        <Button
          disabled
          aria-describedby="practice-milestone"
          variant="primary"
        >
          播放伴奏
        </Button>
        <Button disabled>开启麦克风</Button>
        <Button disabled>设置 A 点</Button>
        <Button disabled>设置 B 点</Button>
        <span className="milestone-note" id="practice-milestone">
          实时练习行为在 M2–M3 开启；播放不会自动请求麦克风权限。
        </span>
      </section>

      <section
        className="tertiary-layer practice-legend"
        data-layer="tertiary"
        aria-label="音高轨图例和状态"
      >
        <span>
          <i className="legend-line legend-line--reference" />
          参考音高 · 虚线
        </span>
        <span>
          <i className="legend-line legend-line--user" />
          当前音高 · 实线
        </span>
        <span>SESSION NOT STARTED</span>
      </section>
    </main>
  );
}
