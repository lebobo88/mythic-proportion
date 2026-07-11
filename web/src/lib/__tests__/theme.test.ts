import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTheme, getInitialTheme, setTheme, toggleTheme } from "../theme";

describe("theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to dark when nothing is stored and no light preference exists", () => {
    expect(getInitialTheme()).toBe("dark");
  });

  it("prefers a stored theme over the system default", () => {
    window.localStorage.setItem("mythic-proportion:theme", "light");
    expect(getInitialTheme()).toBe("light");
  });

  it("applyTheme sets data-theme on <html>", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("setTheme applies, persists, and dispatches a change event", () => {
    let firedWith: string | undefined;
    document.addEventListener("mythic:theme-change", (e) => {
      firedWith = (e as CustomEvent<string>).detail;
    });
    setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("mythic-proportion:theme")).toBe("light");
    expect(firedWith).toBe("light");
  });

  it("toggleTheme flips dark <-> light", () => {
    expect(toggleTheme("dark")).toBe("light");
    expect(toggleTheme("light")).toBe("dark");
  });
});
