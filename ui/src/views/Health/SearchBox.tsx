import { useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../../router";
import { fmt, keyLabel, plural, projectLabel } from "./format";
import { useHealth } from "./HealthContext";
import { SEARCH_MAX, SEARCH_MIN } from "./useSearch";

interface Option {
  key: string;
  kind: "Project" | "Memories";
  label: string;
  count: string;
}

function isTyping(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/** Search combobox: project name matches first, then projects by memory hits; Enter opens the active project. */
export function SearchBox() {
  const { search, overview } = useHealth();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const typed = search.input.trim();
  const show = open && typed.length >= SEARCH_MIN;

  const options = useMemo<Option[]>(() => {
    const result = search.result;
    if (!result) return [];
    const byKey = new Map((overview.data?.projects ?? []).map((p) => [p.key, p]));
    const label = (key: string) => {
      const p = byKey.get(key);
      return p ? projectLabel(p) : keyLabel(key);
    };
    const names = result.nameMatches.slice(0, 3).map<Option>((m) => ({ key: m.key, kind: "Project", label: label(m.key), count: `${fmt(m.live)} total` }));
    const named = new Set(result.nameMatches.map((m) => m.key));
    const hit = Object.entries(result.hits)
      .filter(([key, n]) => n > 0 && !named.has(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map<Option>(([key, n]) => ({ key, kind: "Memories", label: label(key), count: plural(n, "match", "matches") }));
    return [...names, ...hit];
  }, [search.result, overview.data]);

  useEffect(() => setActive(0), [options]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    setOpen(false);
    input.current?.blur();
    navigate({ view: "health", projectKey: option.key, memoryId: null });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && options.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (show) setOpen(false);
      else {
        search.clear();
        input.current?.blur();
      }
    }
  };

  const total = search.result?.total ?? 0;
  const projects = search.hits ? [...search.hits.values()].filter((n) => n > 0).length : 0;
  return (
    <div className="search" role="search">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="6" cy="6" r="4.5" fill="none" stroke="#5b6574" strokeWidth="1.5" />
        <path d="M9.5 9.5L13 13" stroke="#5b6574" strokeWidth="1.5" />
      </svg>
      <label className="sr-only" htmlFor="q">
        Search memories
      </label>
      <input
        ref={input}
        id="q"
        className="ctl"
        type="text"
        placeholder="Search memories"
        autoComplete="off"
        spellCheck={false}
        maxLength={SEARCH_MAX}
        role="combobox"
        aria-expanded={show}
        aria-controls="qlist"
        aria-autocomplete="list"
        aria-activedescendant={show && options.length > 0 ? `qo-${active}` : undefined}
        value={search.input}
        onChange={(e) => {
          search.setInput(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <kbd aria-hidden="true">/</kbd>
      {show && (
        <div className="qlist">
          {search.status === "searching" && (
            <div className="none" role="status">
              Searching
            </div>
          )}
          {search.status === "error" && (
            <div className="none" role="alert">
              Search failed: {search.error}
            </div>
          )}
          {search.status === "done" && options.length > 0 && (
            <div className="sum">
              {plural(total, "memory", "memories")} in {plural(projects, "project")}
            </div>
          )}
          <div id="qlist" role="listbox" aria-label="Search results">
            {options.map((o, k) => (
              <div
                key={`${o.kind}:${o.key}`}
                className="opt"
                role="option"
                id={`qo-${k}`}
                aria-selected={k === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(k);
                }}
              >
                <span className="k">{o.kind}</span>
                <span className="ell">{o.label}</span>
                <span className="n">{o.count}</span>
              </div>
            ))}
          </div>
          {search.status === "done" && options.length === 0 && <div className="none">No memories match &quot;{typed}&quot;</div>}
        </div>
      )}
    </div>
  );
}
