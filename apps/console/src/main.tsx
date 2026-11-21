import React from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "@douyinfe/semi-ui";
import zh_CN from "@douyinfe/semi-ui/lib/es/locale/source/zh_CN";
import { App } from "./App";
import "./styles.css";

document.body.setAttribute("theme-mode", "dark");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider locale={zh_CN}>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
