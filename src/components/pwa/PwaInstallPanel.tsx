"use client";

import { useEffect, useState, type ReactNode } from "react";
import { APP_NAME, getAppIconPath } from "@/lib/branding";
import {
  canShowNativeInstallPrompt,
  getPwaInstallPlatform,
  isStandaloneDisplayMode,
  PWA_INSTALL_PROMPT_READY_EVENT,
  requestPwaInstall,
  recordPwaInstallSuccess,
  type PwaInstallResult,
} from "@/lib/pwaInstall";

const IOS_STEP_ICON_CLASS =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--accent)] shadow-sm ring-1 ring-[color-mix(in_srgb,var(--accent)_30%,transparent)]";

function IosSafariMoreIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden fill="currentColor">
      <circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8.25" cy="12" r="1.15" />
      <circle cx="12" cy="12" r="1.15" />
      <circle cx="15.75" cy="12" r="1.15" />
    </svg>
  );
}

function IosSafariShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4.5v8.25" />
      <path d="M8.25 8.25 12 4.5l3.75 3.75" />
      <rect x="5.25" y="10.5" width="13.5" height="9" rx="1.75" />
    </svg>
  );
}

function IosSafariAddToHomeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
    >
      <rect x="5.25" y="5.25" width="13.5" height="13.5" rx="2" />
      <path d="M12 8.25v7.5" />
      <path d="M8.25 12h7.5" />
    </svg>
  );
}

function IosInstallStep({ text, icon }: { text: string; icon?: ReactNode }) {
  return (
    <li>
      <span className="flex items-center justify-between gap-3">
        <span>{text}</span>
        {icon ? <span className={IOS_STEP_ICON_CLASS}>{icon}</span> : null}
      </span>
    </li>
  );
}

function IphoneInstallSteps() {
  return (
    <ol className="list-decimal space-y-2 rounded-xl border border-[var(--border)] px-4 py-3 text-sm leading-relaxed"
      style={{ background: "var(--accent-soft)" }}
    >
      <IosInstallStep text="Unten rechts auf die 3 Punkte tippen" icon={<IosSafariMoreIcon />} />
      <IosInstallStep text="Auf „Teilen“ tippen" icon={<IosSafariShareIcon />} />
      <IosInstallStep text="„Zum Home-Bildschirm“ auswählen" icon={<IosSafariAddToHomeIcon />} />
      <IosInstallStep text="„Hinzufügen“ tippen" />
    </ol>
  );
}

function IpadInstallSteps() {
  return (
    <ol className="list-decimal space-y-2 rounded-xl border border-[var(--border)] px-4 py-3 text-sm leading-relaxed"
      style={{ background: "var(--accent-soft)" }}
    >
      <IosInstallStep text="Oben in Safari auf „Teilen“ tippen" icon={<IosSafariShareIcon />} />
      <IosInstallStep text="„Zum Home-Bildschirm“ auswählen" icon={<IosSafariAddToHomeIcon />} />
      <IosInstallStep text="„Hinzufügen“ tippen" />
    </ol>
  );
}

function AndroidInstallHint() {
  return (
    <p className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm leading-relaxed"
      style={{ background: "var(--accent-soft)" }}
    >
      Öffnen Sie {APP_NAME} in Chrome. Wenn der Button erscheint, tippen Sie auf „
      {APP_NAME} installieren“. Alternativ: Browser-Menü → „App installieren“ oder „Zum
      Startbildschirm hinzufügen“.
    </p>
  );
}

export function PwaInstallPanel({
  showLaterButton = false,
  onLater,
  onInstalled,
}: {
  showLaterButton?: boolean;
  onLater?: () => void;
  onInstalled?: () => void;
}) {
  const [canInstall, setCanInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [iosDone, setIosDone] = useState(false);
  // Stable SSR + first client paint ("other" / not standalone). Real UA after mount.
  const [platform, setPlatform] = useState<
    ReturnType<typeof getPwaInstallPlatform>
  >("other");
  const [standalone, setStandalone] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setPlatform(getPwaInstallPlatform());
    setStandalone(isStandaloneDisplayMode());
    setMounted(true);
    const refresh = () => setCanInstall(canShowNativeInstallPrompt());
    refresh();
    window.addEventListener(PWA_INSTALL_PROMPT_READY_EVENT, refresh);
    return () =>
      window.removeEventListener(PWA_INSTALL_PROMPT_READY_EVENT, refresh);
  }, []);

  async function handleInstall() {
    if (installing) return;
    setInstalling(true);
    setHint(null);
    try {
      const result: PwaInstallResult = await requestPwaInstall();
      if (result === "installed" || result === "already-installed") {
        onInstalled?.();
        return;
      }
      if (result === "ios-manual") {
        setHint("Folgen Sie den Schritten unten in Safari.");
        return;
      }
      if (result === "dismissed") {
        setHint("Installation abgebrochen.");
        return;
      }
      if (platform === "android" && !canShowNativeInstallPrompt()) {
        setHint(
          `Öffnen Sie ${APP_NAME} in Chrome und warten Sie kurz — dann erscheint „Installieren“.`,
        );
      }
    } finally {
      setInstalling(false);
    }
  }

  if (standalone) {
    return (
      <p className="text-sm font-semibold text-[var(--accent)]">
        {APP_NAME} läuft bereits als App auf dem Home-Bildschirm.
      </p>
    );
  }

  const isIos = platform === "iphone" || platform === "ipad";

  const stepBlock =
    platform === "iphone" ? (
      <IphoneInstallSteps />
    ) : platform === "ipad" ? (
      <IpadInstallSteps />
    ) : platform === "android" && !canInstall ? (
      <AndroidInstallHint />
    ) : platform === "other" ? (
      <p className="muted rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 text-sm leading-relaxed">
        Am Handy (Safari oder Chrome) können Sie {APP_NAME} zum Home-Bildschirm hinzufügen.
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-3 text-center">
        {/* native img: Query-String-Icons brechen next/image in Production */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={getAppIconPath(192)}
          alt=""
          width={72}
          height={72}
          className="h-[4.5rem] w-[4.5rem] rounded-2xl object-cover shadow-lg ring-4 ring-[color-mix(in_srgb,var(--accent)_25%,transparent)]"
        />
        <p className="max-w-xs text-sm font-semibold leading-snug">
          So erscheint {APP_NAME} auf dem Home-Bildschirm.
        </p>
      </div>

      {mounted && canInstall && !isIos ? (
        <button
          type="button"
          disabled={installing}
          onClick={() => void handleInstall()}
          className="btn btn-primary"
        >
          {installing ? "Wird geöffnet …" : `${APP_NAME} installieren`}
        </button>
      ) : null}

      {mounted && isIos ? (
        <button
          type="button"
          disabled={iosDone}
          className="btn btn-secondary"
          onClick={() => {
            recordPwaInstallSuccess();
            setIosDone(true);
            onInstalled?.();
          }}
        >
          {iosDone ? "Erledigt" : "Erledigt — Icon hinzugefügt"}
        </button>
      ) : null}

      {stepBlock ? (
        <div className="space-y-2">
          <p className="hero-kicker">
            {isIos ? "So geht’s in Safari" : "Oder manuell"}
          </p>
          {stepBlock}
        </div>
      ) : null}

      {hint ? (
        <p className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs leading-relaxed"
          style={{ background: "var(--accent-soft)" }}
        >
          {hint}
        </p>
      ) : null}

      {showLaterButton && onLater && !iosDone ? (
        <button type="button" onClick={onLater} className="btn btn-secondary">
          Später
        </button>
      ) : null}
    </div>
  );
}
