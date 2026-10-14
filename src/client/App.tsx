import { useEffect, useState } from "react";
import { S } from "./strings";
import { api } from "./api";
import { act, store, useBoot, useHashRoute, useLive, useStore, useToasts } from "./store";
import { fmtTime } from "./format";
import { Seg } from "./components/ui";
import { ConsoleView } from "./views/console/ConsoleView";
import { EesView } from "./views/EesView";
import { FdcView } from "./views/FdcView";
import { QmsView } from "./views/QmsView";
import { AmsView } from "./views/AmsView";
import { FlowView } from "./views/FlowView";
import { ScenarioView } from "./views/ScenarioView";

const VIEWS = ["console", "ees", "fdc", "qms", "ams", "flow", "scenario"] as const;
type ViewId = (typeof VIEWS)[number];
const SPEEDS = [1, 2, 5, 10, 30, 60];

function useTheme(): [string | null, () => void] {
  const [theme, setTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem("fab-sim-theme");
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }, [theme]);
  const toggle = () => {
    const current = theme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("fab-sim-theme", next);
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  };
  return [theme, toggle];
}

export function App() {
  const route = useHashRoute();
  const view: ViewId = (VIEWS as readonly string[]).includes(route[0]) ? (route[0] as ViewId) : "console";
  const boot = useBoot();
  const bootError = useStore((s) => s.bootError);
  const live = useLive();
  const toastItems = useToasts();
  const [, toggleTheme] = useTheme();

  useEffect(() => {
    void store.loadBootstrap();
    store.connect();
  }, []);

  const sim = live.sim;
  const setSim = (body: object) => act(() => api.post("/api/sim", body));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden />
          <div>
            <b>{S.app.title}</b>
            <br />
            <small>{S.app.subtitle}</small>
          </div>
        </div>
        <nav className="nav">
          {VIEWS.map((v) => (
            <a key={v} href={`#/${v}`} className={view === v ? "on" : ""} title={S.navHint[v]}>
              {S.nav[v]}
              {v === "ams" && live.alarms.unacked > 0 && <span className="badge-count">{live.alarms.unacked}</span>}
            </a>
          ))}
        </nav>
        <div className="spacer" />
        <div className="simbar">
          <span className="muted" style={{ fontSize: 11 }}>
            {S.sim.simTime}
          </span>
          <span className="clock" title={sim ? new Date(sim.simTime).toISOString() : ""}>
            {sim ? fmtTime(sim.simTime, true) : "—"}
          </span>
          {sim && (
            <>
              <button className="btn" onClick={() => setSim({ action: sim.running ? "pause" : "start" })}>
                {sim.running ? `⏸ ${S.sim.pause}` : `▶ ${S.sim.start}`}
              </button>
              <span className="muted" style={{ fontSize: 11 }}>
                {S.sim.speed}
              </span>
              <Seg options={SPEEDS.map((x) => [x, `${x}×`] as [number, string])} value={sim.speed} onChange={(speed) => setSim({ speed })} />
            </>
          )}
          <button className="btn ghost" onClick={toggleTheme} title={S.app.theme} aria-label={S.app.theme}>
            ◐
          </button>
        </div>
      </header>
      {!live.connected ? (
        <div className="banner error">{boot ? S.app.disconnected : S.app.connecting}</div>
      ) : (
        <div className="banner">
          {S.app.testOnly} · seed {sim?.seed} · {sim?.running ? S.sim.running : S.sim.paused}
        </div>
      )}
      <main className="view">
        {bootError && <div className="banner error">{bootError}</div>}
        {boot &&
          (view === "console" ? (
            <ConsoleView eqpId={route[1]} tab={route[2]} />
          ) : view === "ees" ? (
            <EesView />
          ) : view === "fdc" ? (
            <FdcView />
          ) : view === "qms" ? (
            <QmsView />
          ) : view === "ams" ? (
            <AmsView />
          ) : view === "flow" ? (
            <FlowView />
          ) : (
            <ScenarioView />
          ))}
      </main>
      <div className="toasts" aria-live="polite">
        {toastItems.map((t) => (
          <div key={t.id} className={`toast ${t.tone === "error" ? "error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
