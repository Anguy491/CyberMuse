export type PageStateKind =
  | "loading"
  | "empty"
  | "ready"
  | "recoverable_error"
  | "fatal_error"
  | "permission_required"
  | "permission_denied";

interface PageStateProps {
  code?: string;
  detail: string;
  kind: PageStateKind;
  title: string;
}

const stateLabels: Record<PageStateKind, string> = {
  loading: "[LOADING]",
  empty: "○ EMPTY",
  ready: "✓ READY",
  recoverable_error: "△ ERROR",
  fatal_error: "× FATAL",
  permission_required: "◇ ACTION REQUIRED",
  permission_denied: "⊘ PERMISSION DENIED",
};

export function PageState({ code, detail, kind, title }: PageStateProps) {
  const isError = kind === "recoverable_error" || kind === "fatal_error";

  return (
    <div
      className={`page-state page-state--${kind}`}
      role={isError ? "alert" : "status"}
    >
      <span className="page-state__label">{stateLabels[kind]}</span>
      <strong>{title}</strong>
      <span>{detail}</span>
      {code === undefined ? null : <code>{code}</code>}
    </div>
  );
}
