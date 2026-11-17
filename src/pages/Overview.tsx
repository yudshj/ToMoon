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

type ServiceState = { installed: boolean; active: boolean };

/**
 * System service (install/uninstall, always-on core), the TUN switch and the
 * subscription picker. `onRunningChange` reports whether the core is up.
 */
const ServiceSection: FC<{ onRunningChange: (running: boolean) => void }> = ({
  onRunningChange,
}) => {
  const [service, setService] = useState<ServiceState | null>(null);
  const [serviceError, setServiceError] = useState("");
  const [proxyAddress, setProxyAddress] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState(t(L.TUN_DESC));
  const [subs, setSubs] = useState<{ label: string; data: string }[]>([]);
  const [currentSub, setCurrentSub] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const busyRef = useRef(false);

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

  const loadService = useCallback(async () => {
    try {
      const st = await ApiCallBackend.serviceStatus();
      setService(st);
      onRunningChange(st.active);
      if (st.active) {
        resetSecret();
        const cfg = await ClashApi.getRuntimeConfig().catch(() => null);
        const port = cfg && (cfg["mixed-port"] || cfg.port);
        setProxyAddress(port ? `127.0.0.1:${port}` : "");
      } else {
        setProxyAddress("");
      }
    } catch (e) {
      setServiceError(errText(e));
    }
    setEnabled(await backend.getEnabled().catch(() => false));
  }, [onRunningChange]);

  useEffect(() => {
    loadService();
    loadSubs();
    return () => clearInterval(pollRef.current);
  }, []);

  /** Run one action at a time; repeated presses while busy are ignored. */
  const exclusive = async (job: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await job();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const installOrUninstall = () =>
    exclusive(async () => {
      setServiceError("");
      const err = service?.installed
        ? await ApiCallBackend.uninstallService()
        : await ApiCallBackend.installService();
      if (err) setServiceError(err);
      await loadService();
    });

  const toggle = (value: boolean) =>
    exclusive(async () => {
      setEnabled(value);
      setTip(t(L.ENABLE_CLASH_LOADING));
      await backend.setEnabled(value).catch(() => undefined);
      // set_clash_status is synchronous; read the outcome it recorded.
      const status = String(await backend.getRunningStatus().catch(() => "Failed"));
      if (status === "Failed") {
        setTip(t(L.ENABLE_CLASH_FAILED));
      } else {
        setTip(t(L.TUN_DESC));
      }
      await loadService();
    });

  const serviceText = !service
    ? "…"
    : !service.installed
    ? t(L.SERVICE_NOT_INSTALLED)
    : service.active
    ? t(L.SERVICE_RUNNING)
    : t(L.SERVICE_STOPPED);

  return (
    <PanelSection title={t(L.SERVICE)}>
      <Field
        label={t(L.SYSTEM_SERVICE)}
        description={
          <span>
            <span
              style={{
                color: service?.active ? "#59bf40" : service?.installed ? "#e8b923" : "#8b929a",
              }}
            >
              {serviceText}
            </span>
            {service?.active && proxyAddress && (
              <>
                <br />
                {t(L.SERVICE_DESC, { address: proxyAddress })}
              </>
            )}
            {serviceError && (
              <>
                <br />
                <span style={{ color: "#d94126" }}>{serviceError}</span>
              </>
            )}
          </span>
        }
        childrenLayout="inline"
      >
        <DialogButton
          style={{ minWidth: "7em", width: "auto" }}
          disabled={busy || !service || (!service.installed && subs.length === 0)}
          onClick={installOrUninstall}
        >
          {busy && service ? (
            <Spinner style={{ width: 14, height: 14 }} />
          ) : service?.installed ? (
            t(L.UNINSTALL_SERVICE)
          ) : (
            t(L.INSTALL_SERVICE)
          )}
        </DialogButton>
      </Field>
      <PanelSectionRow>
        <ToggleField
          label={t(L.ENABLE_CLASH)}
          description={service && !service.installed ? t(L.INSTALL_SERVICE_FIRST) : tip}
          checked={!!enabled}
          disabled={busy || enabled === null || !service?.installed}
          onChange={toggle}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DropdownItem
          label={t(L.SELECT_SUBSCRIPTION)}
          strDefaultLabel={t(L.SELECT_SUBSCRIPTION)}
          rgOptions={subs}
          selectedOption={currentSub}
          disabled={subs.length === 0}
          onChange={(opt) =>
            exclusive(async () => {
              setCurrentSub(opt.data);
              await backend.setSub(opt.data);
              if (service?.installed) {
                await ApiCallBackend.reloadClashConfig().catch((e) =>
                  setServiceError(errText(e))
                );
              }
              await loadService();
            })
          }
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

  // Refresh in place when the core reloads; only the first load shows a spinner.
  useEffect(() => {
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
          {/* Field drops a bare numeric 0 child; render the count as text. */}
          {String(totals.count)}
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
