import { Button } from "../components/Button";
import { PageState } from "../components/PageState";

export function LibraryPage() {
  return (
    <main className="page" id="main-content">
      <section className="primary-layer library-primary" data-layer="primary">
        <div
          className="signal-ruler"
          data-pattern-break="library-ruler"
          aria-hidden="true"
        >
          <span>01</span>
          <span>08</span>
          <span>16</span>
        </div>
        <p className="eyebrow">LOCAL LIBRARY / 00 TRACKS</p>
        <h1>从一首熟悉的歌开始。</h1>
        <p className="lede">歌曲、分析和练习记录默认只保存在这台电脑上。</p>
        <div className="primary-actions">
          <Button
            variant="primary"
            disabled
            aria-describedby="import-milestone"
          >
            导入歌曲
          </Button>
          <span className="milestone-note" id="import-milestone">
            M1 验证桌面基础；歌曲导入由 M5 开启。
          </span>
        </div>
      </section>

      <section
        className="secondary-layer"
        data-layer="secondary"
        aria-labelledby="songs-heading"
      >
        <div className="section-heading">
          <h2 id="songs-heading">歌曲</h2>
          <span className="technical-label">MP3 / WAV / FLAC</span>
        </div>
        <PageState
          detail="导入后会在这里显示标题、时长、分析状态和最近练习时间。"
          kind="empty"
          title="本地歌曲库为空"
        />
      </section>

      <section
        className="tertiary-layer"
        data-layer="tertiary"
        aria-label="Library 技术状态"
      >
        <span>SCHEMA V1</span>
        <span>APP NETWORK DENY</span>
        <span>SYSTEM FONT FALLBACK</span>
      </section>
    </main>
  );
}
