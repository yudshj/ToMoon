import { FC, useCallback, useEffect, useRef, useState } from "react";
import {
  ButtonItem,
  DialogButton,
  DropdownItem,
  Field,
  Navigation,
  PanelSection,
  PanelSectionRow,
  Router,
  Spinner,
  ToggleField,
} from "@decky/ui";

import {
  ClashApi,
  ClashMode,
  ClashProvider,
  formatBytes,
  openWebDashboard,
  resetSecret,
} from "../clash/api";
import * as backend from "../backend/backend";
import { ApiCallBackend, PyBackend } from "../backend";
import { localizationManager, L } from "../i18n";

const t = localizationManager.getString.bind(localizationManager);

export const modeOptions = () => [
  { label: t(L.MODE_RULE), data: "rule" as ClashMode },
  { label: t(L.MODE_GLOBAL), data: "global" as ClashMode },
  { label: t(L.MODE_DIRECT), data: "direct" as ClashMode },
];

const errText = (e: unknown) => String((e as Error)?.message || e);

type TaskState = { busy: boolean; result?: "ok" | "error"; detail?: string };

function latestUpdate(providers: ClashProvider[]): string {
  const times = providers
    .map((p) => (p.updatedAt ? Date.parse(p.updatedAt) : NaN))
    .filter((v) => !isNaN(v) && v > 0);
  if (!times.length) return "—";
  return new Date(Math.max(...times)).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TaskStatus: FC<{ state?: TaskState }> = ({ state }) => {
  if (!state || state.busy || !state.result) return null;
  return (
    <span
      style={{ color: state.result === "ok" ? "#59bf40" : "#d94126" }}
      title={state.detail}
    >
      {state.result === "ok" ? t(L.UPDATE_DONE) : t(L.UPDATE_FAILED)}
      {state.result === "error" && state.detail ? `: ${state.detail}` : ""}
    </span>
  );
};

/** Clash on/off switch plus subscription picker; shared state lives in the backend. */
const ServiceSection: FC<{ onRunningChange: (running: boolean) => void }> = ({
  onRunningChange,
}) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState(t(L.ENABLE_CLASH_DESC));
  const [subs, setSubs] = useState<{ label: string; data: string }[]>([]);
  const [currentSub, setCurrentSub] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const loadSubs = useCallback(async () => {
    try {
      const list = JSON.parse(String(await backend.getSubList())) as {
        path: string;
        url: string;
      }[];
      setSubs(
        list.map((s) => ({ label: s.path.split("/").pop() || s.path, data: s.path }))
      );
      setCurrentSub(await backend.getCurrentSub());
    } catch {
      /* backend not ready */
    }
  }, []);

  useEffect(() => {
    backend.getEnabled().then((v) => {
      setEnabled(v);
      setTip(v ? t(L.ENABLE_CLASH_IS_RUNNING) : t(L.ENABLE_CLASH_DESC));
      onRunningChange(v);
    });
    loadSubs();
    return () => clearInterval(pollRef.current);
  }, []);

  const toggle = async (value: boolean) => {
    setBusy(true);
    setEnabled(value);
    clearInterval(pollRef.current);
    if (!value) {
      onRunningChange(false);
      await backend.setEnabled(false).catch(() => undefined);
      setTip(t(L.ENABLE_CLASH_DESC));
      setBusy(false);
      return;
    }
    setTip(t(L.ENABLE_CLASH_LOADING));
    backend.setEnabled(true).catch(() => undefined);
    pollRef.current = setInterval(async () => {
      const status = String(await backend.getRunningStatus());
      if (status === "Loading") return;
      clearInterval(pollRef.current);
      setBusy(false);
      if (status === "Success") {
        setTip(t(L.ENABLE_CLASH_IS_RUNNING));
        resetSecret();
        onRunningChange(true);
        loadSubs();
      } else {
        setTip(t(L.ENABLE_CLASH_FAILED));
        setEnabled(false);
        onRunningChange(false);
      }
    }, 500);
  };

  return (
    <PanelSection title={t(L.SERVICE)}>
      <PanelSectionRow>
        <ToggleField
          label={t(L.ENABLE_CLASH)}
          description={tip}
          checked={!!enabled}
          disabled={busy || enabled === null || (subs.length === 0 && !enabled)}
          onChange={toggle}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DropdownItem
          label={t(L.SELECT_SUBSCRIPTION)}
          strDefaultLabel={t(L.SELECT_SUBSCRIPTION)}
          rgOptions={subs}
          selectedOption={currentSub}
          disabled={busy || subs.length === 0}
          onChange={async (opt) => {
            setBusy(true);
            setCurrentSub(opt.data);
            try {
              await backend.setSub(opt.data);
              if (enabled) {
                await ApiCallBackend.reloadClashConfig();
                onRunningChange(false);
                onRunningChange(true);
              }
            } finally {
              setBusy(false);
            }
          }}
        />
      </PanelSectionRow>
    </PanelSection>
  );
};

const ResourcesSection: FC = () => {
  const [ruleProviders, setRuleProviders] = useState<ClashProvider[] | null>(null);
  const [proxyProviders, setProxyProviders] = useState<ClashProvider[] | null>(null);
  const [tasks, setTasks] = useState<Record<string, TaskState>>({});

  const loadProviders = useCallback(async () => {
    const [r, p] = await Promise.all([
      ClashApi.getRuleProviders().catch(() => [] as ClashProvider[]),
      ClashApi.getProxyProviders().catch(() => [] as ClashProvider[]),
    ]);
    setRuleProviders(r);
    setProxyProviders(p);
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const run = async (key: string, job: () => Promise<unknown>) => {
    setTasks((s) => ({ ...s, [key]: { busy: true } }));
    try {
      await job();
      setTasks((s) => ({ ...s, [key]: { busy: false, result: "ok" } }));
    } catch (e) {
      setTasks((s) => ({
        ...s,
        [key]: { busy: false, result: "error", detail: errText(e) },
      }));
    }
    loadProviders();
  };

  /** Update every provider; fail if any of them failed, but try them all. */
  const updateAll = (
    list: ClashProvider[],
    update: (name: string) => Promise<void>
  ) => async () => {
    const results = await Promise.allSettled(list.map((p) => update(p.name)));
    const failed = results
      .map((r, i) => (r.status === "rejected" ? list[i].name : null))
      .filter(Boolean);
    if (failed.length) throw new Error(failed.join(", "));
  };

  const anyBusy = Object.values(tasks).some((s) => s.busy);

  const row = (
    key: string,
    label: string,
    description: string,
    job: () => Promise<unknown>,
    disabled = false
  ) => (
    <Field
      label={label}
      description={
        <span>
          {description}
          {tasks[key] && !tasks[key].busy && (
            <>
              <br />
              <TaskStatus state={tasks[key]} />
            </>
          )}
        </span>
      }
      childrenLayout="inline"
    >
      <DialogButton
        style={{ minWidth: "7em", width: "auto" }}
        disabled={disabled || anyBusy}
        onClick={() => run(key, job)}
      >
        {tasks[key]?.busy ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Spinner style={{ width: 14, height: 14 }} />
            {t(L.UPDATING)}
          </span>
        ) : (
          t(L.UPDATE)
        )}
      </DialogButton>
    </Field>
  );

  const summary = (list: ClashProvider[] | null) =>
    list === null
      ? "…"
      : list.length === 0
      ? t(L.NONE_CONFIGURED)
      : t(L.PROVIDER_SUMMARY, { count: list.length, time: latestUpdate(list) });

  return (
    <PanelSection title={t(L.RESOURCES)}>
      {row("geo", t(L.GEO_DATABASE), t(L.GEO_DATABASE_DESC), ClashApi.updateGeo)}
      {row(
        "rules",
        t(L.RULE_PROVIDERS),
        summary(ruleProviders),
        updateAll(ruleProviders || [], ClashApi.updateRuleProvider),
        !ruleProviders?.length
      )}
      {row(
        "proxies",
        t(L.PROXY_PROVIDERS),
        summary(proxyProviders),
        updateAll(proxyProviders || [], ClashApi.updateProxyProvider),
        !proxyProviders?.length
      )}
    </PanelSection>
  );
};

const RunningSections: FC<{ generation: number }> = ({ generation }) => {
  const [ready, setReady] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<ClashMode>("rule");
  const [speed, setSpeed] = useState({ up: 0, down: 0 });
  const [totals, setTotals] = useState({ up: 0, down: 0, count: 0, memory: 0 });
  const [allowLan, setAllowLan] = useState(false);
  const [lanBusy, setLanBusy] = useState(false);
  const [lanAddress, setLanAddress] = useState("");

  const loadLan = useCallback(async () => {
    try {
      const [cfg, ip] = await Promise.all([
        ClashApi.getRuntimeConfig(),
        ApiCallBackend.getLanIp().catch(() => ""),
      ]);
      setAllowLan(!!cfg["allow-lan"]);
      const port = cfg["mixed-port"] || cfg.port || cfg["socks-port"];
      setLanAddress(ip && port ? `${ip}:${port}` : "");
    } catch {
      /* keep previous */
    }
  }, []);

  const load = useCallback(async () => {
    resetSecret();
    try {
      const [v, m] = await Promise.all([ClashApi.version(), ClashApi.getMode()]);
      setVersion(v.version);
      setMode(m);
      loadLan();
      setReady(true);
      setError(undefined);
    } catch (e) {
      setReady(false);
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    setReady(null);
    load();
  }, [load, generation]);

  useEffect(() => {
    if (!ready) return;
    const stop = ClashApi.streamTraffic((up, down) => setSpeed({ up, down }));
    const poll = async () => {
      try {
        const c = await ClashApi.getConnections();
        setTotals({
          up: c.uploadTotal,
          down: c.downloadTotal,
          count: c.connections?.length ?? 0,
          memory: c.memory ?? 0,
        });
      } catch {
        /* transient */
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [ready]);

  if (ready === null) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
        <Spinner style={{ width: 32, height: 32 }} />
      </div>
    );
  }
  if (!ready) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ padding: "0.5em 0" }}>
            {t(L.CLASH_NOT_RUNNING)}
            {error && (
              <div style={{ color: "#8b929a", fontSize: "0.85em", marginTop: 4 }}>
                {error}
              </div>
            )}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={load}>
            {t(L.RETRY)}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const openDashboard = async () => {
    const [dashboard, config] = await Promise.all([
      PyBackend.getCurrentDashboard(),
      ApiCallBackend.getConfig(),
    ]);
    Router.CloseSideMenus();
    Navigation.NavigateToExternalWeb(
      openWebDashboard(dashboard || "zashboard", config?.data?.secret || "")
    );
  };

  return (
    <>
      <PanelSection title={t(L.OVERVIEW)}>
        <PanelSectionRow>
          <DropdownItem
            label={t(L.PROXY_MODE)}
            rgOptions={modeOptions()}
            selectedOption={mode}
            onChange={async (opt) => {
              const next = opt.data as ClashMode;
              setMode(next);
              try {
                await ClashApi.setMode(next);
              } catch (e) {
                setError(errText(e));
                setMode(await ClashApi.getMode());
              }
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label={t(L.ALLOW_LAN)}
            description={
              allowLan && lanAddress
                ? t(L.ALLOW_LAN_ADDRESS, { address: lanAddress })
                : t(L.ALLOW_LAN_DESC)
            }
            checked={allowLan}
            disabled={lanBusy}
            onChange={async (value) => {
              setLanBusy(true);
              setAllowLan(value);
              try {
                await ApiCallBackend.allowLan(value);
                await ClashApi.setAllowLan(value);
              } catch (e) {
                setError(errText(e));
              }
              await loadLan();
              setLanBusy(false);
            }}
          />
        </PanelSectionRow>
        <Field label={t(L.REALTIME_SPEED)} focusable>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            ↑ {formatBytes(speed.up)}/s　↓ {formatBytes(speed.down)}/s
          </span>
        </Field>
        <Field label={t(L.TOTAL_TRAFFIC)} focusable>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            ↑ {formatBytes(totals.up)}　↓ {formatBytes(totals.down)}
          </span>
        </Field>
        <Field
          label={t(L.ACTIVE_CONNECTIONS)}
          focusable
          onActivate={() => Router.Navigate("/tomoon-config/connections")}
          onClick={() => Router.Navigate("/tomoon-config/connections")}
        >
          {totals.count}
        </Field>
        <Field label={t(L.CORE_VERSION)} focusable>
          {version}
          {totals.memory ? ` · ${formatBytes(totals.memory)}` : ""}
        </Field>
        {error && (
          <PanelSectionRow>
            <div style={{ color: "#d94126" }}>{error}</div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={async () => {
              await ClashApi.closeAllConnections().catch(() => undefined);
              setTotals((v) => ({ ...v, count: 0 }));
            }}
          >
            {t(L.CLOSE_ALL_CONNECTIONS)}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
      <ResourcesSection />
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description={t(L.OPEN_WEB_DASHBOARD_DESC)}
            onClick={openDashboard}
          >
            {t(L.OPEN_WEB_DASHBOARD)}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
};

export const Overview: FC = () => {
  const [running, setRunning] = useState<boolean | null>(null);
  // Bumped whenever the core (re)starts or reloads so the running view refetches.
  const [generation, setGeneration] = useState(0);

  const onRunningChange = useCallback((value: boolean) => {
    setRunning(value);
    if (value) setGeneration((g) => g + 1);
  }, []);

  return (
    <>
      <ServiceSection onRunningChange={onRunningChange} />
      {running === false && (
        <PanelSection>
          <PanelSectionRow>
            <div style={{ color: "#8b929a", padding: "0.5em 0" }}>
              {t(L.CLASH_STOPPED_HINT)}
            </div>
          </PanelSectionRow>
        </PanelSection>
      )}
      {running && <RunningSections generation={generation} />}
    </>
  );
};
