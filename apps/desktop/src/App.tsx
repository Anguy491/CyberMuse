import { useState } from "react";

import { AudioSettingsPage } from "./pages/AudioSettingsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ModelAssetsPage } from "./pages/ModelAssetsPage";
import { PracticePage } from "./pages/PracticePage";

type PageId = "library" | "practice" | "models" | "audio";

const navigation: ReadonlyArray<{ id: PageId; label: string }> = [
  { id: "library", label: "歌曲库" },
  { id: "practice", label: "练习" },
  { id: "models", label: "模型" },
  { id: "audio", label: "音频设置" },
];

export function App() {
  const [page, setPage] = useState<PageId>("library");

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

      {page === "library" ? <LibraryPage /> : null}
      {page === "practice" ? <PracticePage /> : null}
      {page === "models" ? <ModelAssetsPage /> : null}
      {page === "audio" ? <AudioSettingsPage /> : null}
    </div>
  );
}
