import { FC } from "react";
import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";

import { localizationManager, L } from "../i18n";

export const ClashUnavailable: FC<{ detail?: string; onRetry: () => void }> = ({
  detail,
  onRetry,
}) => (
  <PanelSection>
    <PanelSectionRow>
      <div style={{ padding: "0.5em 0" }}>
        {localizationManager.getString(L.CLASH_NOT_RUNNING)}
        {detail && (
          <div style={{ color: "#8b929a", fontSize: "0.85em", marginTop: 4 }}>
            {detail}
          </div>
        )}
      </div>
    </PanelSectionRow>
    <PanelSectionRow>
      <ButtonItem layout="below" onClick={onRetry}>
        {localizationManager.getString(L.RETRY)}
      </ButtonItem>
    </PanelSectionRow>
  </PanelSection>
);
