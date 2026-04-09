/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 */

import React, { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import DockerFileExplorer from "./pages/DockerFileExplorer";

export default function App() {
  const [language, setLanguage] = useState<"zh" | "en">("en");

  return (
    <div className="appRoot">
      <header className="appHeader">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="appHeaderTitle">TigerClawDockerManager</div>
        </div>
        <div className="appHeaderMeta">
          <div className="langPicker" aria-label="Language selector">
            <button
              type="button"
              className={`langBtn ${language === "zh" ? "langBtnActive" : ""}`}
              onClick={() => setLanguage("zh")}
            >
              中文
            </button>
            <button
              type="button"
              className={`langBtn ${language === "en" ? "langBtnActive" : ""}`}
              onClick={() => setLanguage("en")}
            >
              EN
            </button>
          </div>
        </div>
      </header>

      <main className="appMain appMain--explorer">
        <Routes>
          <Route path="/" element={<Navigate to="/dockerfileManager" replace />} />
          <Route
            path="/dockerfileManager"
            element={<DockerFileExplorer language={language} />}
          />
        </Routes>
      </main>
    </div>
  );
}
