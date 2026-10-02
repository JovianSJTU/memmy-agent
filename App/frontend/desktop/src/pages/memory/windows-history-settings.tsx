import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../../components/modal.js";
import { Button } from "../../components/button.js";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import type { WindowsHistoryConfiguration } from "../../api/computer-history-contract.js";
import { useTranslation } from "../../i18n/use-translation.js";

export function WindowsHistorySettings(props: { client: MemmyAgentClient; onClose: () => void;
  onSaved: (configuration: WindowsHistoryConfiguration) => void; onStart?: () => Promise<void> }) {
  const { t } = useTranslation();
  const [configuration, setConfiguration] = useState<WindowsHistoryConfiguration | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const refresh = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const next = await props.client.getWindowsHistoryConfiguration();
      if (!active.current) return;
      setConfiguration(next); setSelected(new Set(next.applications.filter((app) => app.allowed).map((app) => app.id)));
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active.current) setBusy(false); }
  }, [props.client]);
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; }; }, [refresh]);
  const save = async () => {
    if (!configuration || busy) return;
    setBusy(true); setError(null);
    try {
      const applications = configuration.applications.filter((app) => selected.has(app.id)).map((app) => app.rule ?? { executable: app.executable });
      const next = await props.client.updateWindowsHistorySettings({ ...configuration.settings, applications });
      if (!active.current) return;
      props.onSaved(next);
      if (props.onStart) {
        if (!next.permissions.ready) throw new Error(t(`computerHistory.windows.${next.permissions.reason === "ready" || !next.permissions.reason ? "no_running_authorized_application" : next.permissions.reason}`));
        await props.onStart();
      }
      props.onClose();
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active.current) setBusy(false); }
  };
  const reason = configuration?.permissions.reason;
  const reasonText = reason && reason !== "ready" ? t(`computerHistory.windows.${reason}`) : null;
  return createPortal(<Modal open title={t("computerHistory.windows.title")} closeLabel={t("common.close")} onClose={() => { if (!busy) props.onClose(); }}
    closeDisabled={busy} className="confirm-dialog confirm-dialog--titled ch__permission-dialog" style={{ width: 520, maxWidth: "calc(100vw - 32px)" }}
    footer={<><Button disabled={busy} onClick={props.onClose}>{t("dialog.cancel")}</Button>
      <Button disabled={busy || !configuration} onClick={() => void refresh()}>{t("computerHistory.windows.refresh")}</Button>
      <Button disabled={busy || !configuration || (!!props.onStart && (!selected.size || reason === "collector_unavailable"))} onClick={() => void save()}>
        {t(props.onStart ? "computerHistory.windows.saveAndStart" : "computerHistory.windows.save")}</Button></>}>
    <p className="text-sm mb-3">{t("computerHistory.windows.description")}</p>
    <p className="text-sm mb-3">{t("computerHistory.windows.changesStopRecording")}</p>
    {reasonText ? <p role="status" className="text-sm mb-3">{reasonText}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="max-h-80 overflow-auto space-y-2">
      {configuration?.applications.map((app) => <label key={app.id} className="flex items-start gap-2 rounded border p-2 text-sm">
        <input type="checkbox" checked={selected.has(app.id)} disabled={busy || (!app.supported && !selected.has(app.id)) || (!selected.has(app.id) && selected.size >= 32)} onChange={(event) => {
          setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(app.id); else next.delete(app.id); return next; });
        }} />
        <span><span className="font-medium">{app.name}</span><span className="ml-2 text-xs">{t(!app.supported ? "computerHistory.windows.browserUnsupported" : app.running ? "computerHistory.windows.running" : "computerHistory.windows.closed")}</span>
          <span className="block break-all text-xs text-text-ink/60">{app.executable}</span></span>
      </label>)}
      {configuration && !configuration.applications.length ? <p>{t("computerHistory.windows.empty")}</p> : null}
    </div>
  </Modal>, document.body);
}
