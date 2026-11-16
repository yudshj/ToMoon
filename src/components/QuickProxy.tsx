import { FC, useCallback, useEffect, useState } from "react";
import { ButtonItem, DropdownItem, PanelSectionRow, Router } from "@decky/ui";

import {
  ClashApi,
  ClashMode,
  ClashProxy,
  lastDelay,
  orderedGroups,
} from "../clash/api";
import { modeOptions } from "../pages/Overview";
import { localizationManager, L } from "../i18n";

const t = localizationManager.getString.bind(localizationManager);

/**
 * Quick Access Menu shortcuts while the core is running: proxy mode and the
 * first selectable group, plus a link to the full native panel.
 */
export const QuickProxy: FC<{ refreshToken?: string }> = ({
  refreshToken,
}) => {
  const [mode, setMode] = useState<ClashMode | null>(null);
  const [proxies, setProxies] = useState<Record<string, ClashProxy> | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([
        ClashApi.getMode(),
        ClashApi.getProxies(),
      ]);
      setMode(m);
      setProxies(p);
    } catch {
      setMode(null);
      setProxies(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshToken]);

  const mainGroup =
    proxies && mode
      ? orderedGroups(proxies, mode).find((g) => g.type === "Selector")
      : undefined;

  return (
    <>
      {mode && (
        <PanelSectionRow>
          <DropdownItem
            label={t(L.PROXY_MODE)}
            rgOptions={modeOptions()}
            selectedOption={mode}
            onChange={async (opt) => {
              setMode(opt.data);
              await ClashApi.setMode(opt.data).catch(() => undefined);
              refresh();
            }}
          />
        </PanelSectionRow>
      )}
      {mainGroup && proxies && (
        <PanelSectionRow>
          <DropdownItem
            label={mainGroup.name}
            rgOptions={(mainGroup.all || []).map((name) => {
              const d = proxies[name]?.history?.length
                ? lastDelay(proxies[name])
                : undefined;
              return {
                label: d === undefined ? name : `${name}  ·  ${d > 0 ? `${d} ms` : t(L.LATENCY_TIMEOUT)}`,
                data: name,
              };
            })}
            selectedOption={mainGroup.now}
            onChange={async (opt) => {
              await ClashApi.selectProxy(mainGroup.name, opt.data).catch(
                () => undefined
              );
              refresh();
            }}
          />
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() => {
            Router.CloseSideMenus();
            Router.Navigate("/tomoon-config/overview");
          }}
        >
          {t(L.PROXY_SETTINGS)}
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
};
