import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageState, type PageStateKind } from "./PageState";

const kinds: PageStateKind[] = [
  "loading",
  "empty",
  "ready",
  "recoverable_error",
  "fatal_error",
  "permission_required",
  "permission_denied",
];

describe("PageState", () => {
  it.each(kinds)("renders a textual %s state", (kind) => {
    render(<PageState detail="数据保持安全。" kind={kind} title="状态标题" />);
    expect(screen.getByText("状态标题")).toBeVisible();
    expect(screen.getByText("数据保持安全。")).toBeVisible();
  });
});
