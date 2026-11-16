import { FC, useCallback, useEffect, useState } from "react";
import {
  ButtonItem,
  DialogButton,
  Field,
  PanelSection,
  PanelSectionRow,
  Spinner,
} from "@decky/ui";

import { ClashApi, ClashConnection, formatBytes } from "../clash/api";
import { ClashUnavailable } from "../components/ClashUnavailable";
import { localizationManager, L } from "../i18n";

const t = localizationManager.getString.bind(localizationManager);
const MAX_ROWS = 50;

function hostOf(c: ClashConnection) {
  const m = c.metadata;
  const host = m.host || m.sniffHost || m.destinationIP;
  return m.destinationPort ? `${host}:${m.destinationPort}` : host;
}

export const Connections: FC = () => {
  const [conns, setConns] = useState<ClashConnection[] | null>(null);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const snap = await ClashApi.getConnections();
      const list = [...(snap.connections || [])].sort(
        (a, b) => +new Date(b.start) - +new Date(a.start)
      );
      setConns(list);
      setError(undefined);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error && !conns) return <ClashUnavailable detail={error} onRetry={refresh} />;
  if (!conns) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
        <Spinner style={{ width: 32, height: 32 }} />
      </div>
    );
  }

  return (
    <PanelSection title={`${t(L.ACTIVE_CONNECTIONS)} · ${conns.length}`}>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={conns.length === 0}
          onClick={async () => {
            await ClashApi.closeAllConnections().catch(() => undefined);
            refresh();
          }}
        >
          {t(L.CLOSE_ALL_CONNECTIONS)}
        </ButtonItem>
      </PanelSectionRow>
      {conns.length === 0 && (
        <PanelSectionRow>
          <div style={{ color: "#8b929a", padding: "0.5em 0" }}>
            {t(L.NO_CONNECTIONS)}
          </div>
        </PanelSectionRow>
      )}
      {conns.slice(0, MAX_ROWS).map((c) => (
        <Field
          key={c.id}
          label={
            <span style={{ wordBreak: "break-all" }}>{hostOf(c)}</span>
          }
          description={
            <span>
              {[...c.chains].reverse().join(" → ")}
              {" · "}
              {c.rule}
              {c.rulePayload ? `(${c.rulePayload})` : ""}
              {" · "}
              {c.metadata.network.toUpperCase()}
              {c.metadata.process ? ` · ${c.metadata.process}` : ""}
              {"  ↑ "}
              {formatBytes(c.upload)}
              {" ↓ "}
              {formatBytes(c.download)}
            </span>
          }
          childrenLayout="inline"
        >
          <DialogButton
            style={{ minWidth: "5em", width: "auto" }}
            onClick={async () => {
              await ClashApi.closeConnection(c.id).catch(() => undefined);
              refresh();
            }}
          >
            {t(L.CLOSE_CONNECTION)}
          </DialogButton>
        </Field>
      ))}
    </PanelSection>
  );
};
