import { FC, useCallback, useEffect, useMemo, useState } from "react";
import {
  DialogButton,
  Field,
  Focusable,
  ModalRoot,
  PanelSection,
  showModal,
  Spinner,
} from "@decky/ui";
import { FaCheck } from "react-icons/fa";

import {
  ClashApi,
  ClashMode,
  ClashProxy,
  delayColor,
  delayText,
  lastDelay,
  orderedGroups,
} from "../clash/api";
import { ClashUnavailable } from "../components/ClashUnavailable";
import { localizationManager, L } from "../i18n";

const t = localizationManager.getString.bind(localizationManager);

// The classic `window.SP_REACT.createElement` JSX factory cannot see children
// through React 19's types, so give Focusable a loose signature.
const Box = Focusable as unknown as FC<Record<string, unknown>>;

const DelayBadge: FC<{ delay?: number }> = ({ delay }) => (
  <span
    style={{
      color: delayColor(delay),
      fontVariantNumeric: "tabular-nums",
      minWidth: "4.5em",
      textAlign: "right",
      display: "inline-block",
    }}
  >
    {delayText(delay, t(L.LATENCY_TIMEOUT))}
  </span>
);

interface NodePickerProps {
  group: ClashProxy;
  proxies: Record<string, ClashProxy>;
  onChanged: () => void;
  closeModal?: () => void;
}

/** Controller-friendly list of a group's members with latency. */
const NodePickerModal: FC<NodePickerProps> = ({
  group,
  proxies,
  onChanged,
  closeModal,
}) => {
  const [delays, setDelays] = useState<Record<string, number | undefined>>(
    () =>
      Object.fromEntries(
        (group.all || []).map((n) => {
          const p = proxies[n];
          return [n, p && p.history?.length ? lastDelay(p) : undefined];
        })
      )
  );
  const [testing, setTesting] = useState(false);
  const [sortByDelay, setSortByDelay] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectable = group.type === "Selector";

  const members = useMemo(() => {
    const list = [...(group.all || [])];
    if (sortByDelay) {
      const key = (n: string) => {
        const d = delays[n];
        return d === undefined ? 1e9 : d <= 0 ? 1e8 : d;
      };
      list.sort((a, b) => key(a) - key(b));
    }
    return list;
  }, [group, delays, sortByDelay]);

  const testAll = async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await ClashApi.testGroup(group.name);
      setDelays((prev) => {
        const next = { ...prev };
        for (const n of group.all || []) next[n] = result[n] ?? 0;
        return next;
      });
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setTesting(false);
    }
  };

  const choose = async (name: string) => {
    if (!selectable) return;
    setBusy(name);
    setError(null);
    try {
      await ClashApi.selectProxy(group.name, name);
      onChanged();
      closeModal?.();
    } catch (e) {
      setError(String((e as Error).message || e));
      setBusy(null);
    }
  };

  return (
    <ModalRoot closeModal={closeModal} bAllowFullSize>
      <div
        style={{ display: "flex", alignItems: "baseline", gap: "0.6em" }}
      >
        <h2 style={{ margin: 0 }}>{group.name}</h2>
        <span style={{ color: "#8b929a" }}>
          {group.type} · {(group.all || []).length}
        </span>
      </div>
      {!selectable && (
        <div style={{ color: "#8b929a", marginTop: "0.3em" }}>
          {t(L.AUTO_SELECTED_GROUP)}
        </div>
      )}
      <Box
        flow-children="horizontal"
        style={{ display: "flex", gap: "0.5em", margin: "0.8em 0" }}
      >
        <DialogButton
          style={{ flex: 1 }}
          disabled={testing}
          onClick={testAll}
        >
          {testing ? t(L.TESTING) : t(L.TEST_LATENCY)}
        </DialogButton>
        <DialogButton
          style={{ flex: 1 }}
          onClick={() => setSortByDelay((v) => !v)}
        >
          {sortByDelay ? "✓ " : ""}
          {t(L.SORT_BY_LATENCY)}
        </DialogButton>
      </Box>
      {error && <div style={{ color: "#d94126" }}>{error}</div>}
      <Box style={{ display: "flex", flexDirection: "column" }}>
        {members.map((name) => {
          const isCurrent = name === group.now;
          const member = proxies[name];
          return (
            <Field
              key={name}
              focusable
              highlightOnFocus
              padding="compact"
              bottomSeparator="none"
              onActivate={() => choose(name)}
              onClick={() => choose(name)}
              label={
                <span
                  style={{
                    fontWeight: isCurrent ? "bold" : undefined,
                    color: isCurrent ? "#1a9fff" : undefined,
                  }}
                >
                  {name}
                </span>
              }
              description={member ? member.type : undefined}
              icon={
                busy === name ? (
                  <Spinner style={{ width: 16, height: 16 }} />
                ) : isCurrent ? (
                  <FaCheck color="#1a9fff" />
                ) : (
                  <span style={{ display: "inline-block", width: 16 }} />
                )
              }
            >
              <DelayBadge delay={delays[name]} />
            </Field>
          );
        })}
      </Box>
    </ModalRoot>
  );
};

export const Proxies: FC = () => {
  const [proxies, setProxies] = useState<Record<string, ClashProxy> | null>(
    null
  );
  const [mode, setMode] = useState<ClashMode>("rule");
  const [error, setError] = useState<string | null>(null);
  const [testingGroup, setTestingGroup] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        ClashApi.getProxies(),
        ClashApi.getMode(),
      ]);
      setProxies(p);
      setMode(m);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error && !proxies) {
    return <ClashUnavailable detail={error} onRetry={refresh} />;
  }
  if (!proxies) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
        <Spinner style={{ width: 32, height: 32 }} />
      </div>
    );
  }

  const groups = orderedGroups(proxies, mode);

  const openPicker = (group: ClashProxy) => {
    showModal(
      <NodePickerModal group={group} proxies={proxies} onChanged={refresh} />
    );
  };

  const testGroup = async (group: ClashProxy) => {
    setTestingGroup(group.name);
    try {
      await ClashApi.testGroup(group.name);
    } catch {
      /* results still land in history for members that answered */
    }
    await refresh();
    setTestingGroup(null);
  };

  return (
    <PanelSection>
      {groups.map((group) => {
        const current = group.now ? proxies[group.now] : undefined;
        return (
          <Field
            key={group.name}
            label={group.name}
            description={
              <span>
                {group.type} · {group.now || "—"}
                {current && (
                  <>
                    {" · "}
                    <DelayBadge
                      delay={
                        current.history?.length ? lastDelay(current) : undefined
                      }
                    />
                  </>
                )}
              </span>
            }
            childrenLayout="inline"
            childrenContainerWidth="max"
          >
            <Box
              flow-children="horizontal"
              style={{ display: "flex", gap: "0.4em", justifyContent: "flex-end" }}
            >
              <DialogButton
                style={{ minWidth: "6em", width: "auto" }}
                disabled={testingGroup !== null}
                onClick={() => testGroup(group)}
              >
                {testingGroup === group.name ? t(L.TESTING) : t(L.TEST_LATENCY)}
              </DialogButton>
              <DialogButton
                style={{ minWidth: "6em", width: "auto" }}
                onClick={() => openPicker(group)}
              >
                {t(L.SWITCH_NODE)}
              </DialogButton>
            </Box>
          </Field>
        );
      })}
    </PanelSection>
  );
};
