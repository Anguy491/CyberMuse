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

export function PageState({ code, detail, kind, title }: PageStateProps) {
  const preferences = useOptionalPreferences();
  const label =
    preferences?.t(`state.${kind}`) ??
    translate(resolveLocale("system"), `state.${kind}`);
  const isError = kind === "recoverable_error" || kind === "fatal_error";

  return (
    <div
      className={`page-state page-state--${kind}`}
      role={isError ? "alert" : "status"}
    >
      <span className="page-state__label">{label}</span>
      <strong>{title}</strong>
      <span>{detail}</span>
      {code === undefined ? null : <code>{code}</code>}
    </div>
  );
}
import { resolveLocale, translate } from "../i18n/i18n";
import { useOptionalPreferences } from "../preferences/PreferencesProvider";
