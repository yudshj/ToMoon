import { FC, useCallback, useEffect, useState } from "react";
import {
  ButtonItem,
  DropdownItem,
  Field,
  Navigation,
  PanelSection,
  PanelSectionRow,
  Router,
  Spinner,
} from "@decky/ui";

import {
  ClashApi,
  ClashMode,
  formatBytes,
  openWebDashboard,
  resetSecret,
} from "../clash/api";
import { ClashUnavailable } from "../components/ClashUnavailable";
import { ApiCallBackend, PyBackend } from "../backend";
import { localizationManager, L } from "../i18n";

const t = localizationManager.getString.bind(localizationManager);

export const modeOptions = () => [
  { label: t(L.MODE_RULE), data: "rule" as ClashMode },
  { label: t(L.MODE_GLOBAL), data: "global" as ClashMode },
  { label: t(L.MODE_DIRECT), data: "direct" as ClashMode },
];

export const Overview: FC = () => {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<ClashMode>("rule");
  const [speed, setSpeed] = useState({ up: 0, down: 0 });
  const [totals, setTotals] = useState({ up: 0, down: 0, count: 0, memory: 0 });

  const load = useCallback(async () => {
    resetSecret();
    try {
      const [v, m] = await Promise.all([ClashApi.version(), ClashApi.getMode()]);
      setVersion(v.version);
      setMode(m);
      setAvailable(true);
      setError(undefined);
    } catch (e) {
      setAvailable(false);
      setError(String((e as Error).message || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!available) return;
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
  }, [available]);

  if (available === false) {
    return <ClashUnavailable detail={error} onRetry={load} />;
  }
  if (available === null) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
        <Spinner style={{ width: 32, height: 32 }} />
      </div>
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
      <PanelSection>
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
                setError(String((e as Error).message || e));
                setMode(await ClashApi.getMode());
              }
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
      </PanelSection>
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => Router.Navigate("/tomoon-config/proxies")}
          >
            {t(L.PROXY_SETTINGS)}
          </ButtonItem>
        </PanelSectionRow>
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
