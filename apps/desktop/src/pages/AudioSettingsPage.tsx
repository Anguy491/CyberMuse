import { Button } from "../components/Button";
import { PageState } from "../components/PageState";

export function AudioSettingsPage() {
  return (
    <main className="page audio-page" id="main-content">
      <section className="primary-layer audio-primary" data-layer="primary">
        <div
          className="level-meter"
          data-pattern-break="input-level"
          aria-hidden="true"
        >
          <span className="level-meter__fill" />
          <span className="level-meter__tick level-meter__tick--top">0</span>
          <span className="level-meter__tick level-meter__tick--middle">
            −24
          </span>
          <span className="level-meter__tick level-meter__tick--bottom">
            −60
          </span>
        </div>
        <p className="eyebrow">AUDIO INPUT / NOT REQUESTED</p>
        <h1>PERMISSION REQUIRED</h1>
        <p className="lede">
          麦克风只用于本机实时音高反馈。进入此页不会自动请求权限，也不会保存音频。
        </p>
        <Button
          variant="primary"
          disabled
          aria-describedby="permission-milestone"
        >
          请求麦克风权限
        </Button>
        <span className="milestone-note" id="permission-milestone">
          权限与设备检测由 M2 开启。
        </span>
      </section>

      <section
        className="secondary-layer settings-groups"
        data-layer="secondary"
        aria-label="音频设置"
      >
        <div className="setting-row">
          <label htmlFor="input-device">输入设备</label>
          <select id="input-device" disabled>
            <option>等待权限</option>
          </select>
          <span>授权后列出当前会话可用设备；持久化只保存不可逆指纹。</span>
        </div>
        <PageState
          code="AUDIO_PERMISSION_NOT_REQUESTED"
          detail="歌曲库和离线分析保持可用。"
          kind="permission_denied"
          title="尚未请求麦克风访问"
        />
      </section>

      <section
        className="tertiary-layer"
        data-layer="tertiary"
        aria-label="音频技术状态"
      >
        <span>SAMPLE RATE —</span>
        <span>CHANNELS —</span>
        <span>INPUT LEVEL −∞ DBFS</span>
      </section>
    </main>
  );
}
