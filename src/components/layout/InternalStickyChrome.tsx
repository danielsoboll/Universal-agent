/**
 * Shared sticky chrome for authenticated internal shells.
 * Exactly two sticky levels: global header + optional back link.
 * Page titles, progress, cards, forms scroll underneath.
 */
export function InternalStickyChrome({
  header,
  backNav,
  children,
  mainClassName,
  beforeChrome,
}: {
  /** Logo + „General Agent“ + theme toggle only. */
  header: React.ReactNode;
  /** Context back link; omit on surfaces without back nav. */
  backNav?: React.ReactNode;
  children: React.ReactNode;
  mainClassName?: string;
  /** Overlays (e.g. SAP hero) outside the sticky stack. */
  beforeChrome?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen pb-safe">
      {beforeChrome}
      <div className="internal-sticky-stack pt-safe">
        <div className="internal-sticky-header">{header}</div>
        {backNav ? (
          <div className="internal-sticky-back">{backNav}</div>
        ) : null}
      </div>
      <main className={mainClassName}>{children}</main>
    </div>
  );
}
