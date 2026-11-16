import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph";
import { Logo } from "@workspace/ui/neuve/shared/logo";
import type { ReactNode } from "react";
import {
  AGENTS,
  BATCH,
  CLOSE,
  DESK,
  FINDERS,
  FINDINGS,
  FOOTER,
  HEADING,
  HERO,
  INSTALL,
  MATRIX_UNITS,
  NAV,
  OPEN,
  REPO_URL,
  STAGE,
  STEPS,
  UI,
  type FindingKind,
  type MatrixUnit,
} from "./content";

/*
 * The landing page, rendered to static HTML at build time (scripts/prerender.ts).
 * Everything here is complete without JavaScript; src/entry-client.ts adds the
 * theme toggle, the copy buttons and the motion, and the motion starts from
 * what is rendered here. No inline style attributes: the CSP forbids them.
 */

const Arrow = () => (
  <svg
    className="arr"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

const GitHubIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

/** A question a finder raised: a filled ring, so it reads apart from a defect's diamond. */
const QuestionGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <circle cx="5" cy="5" r="3.8" fill="var(--nv-ink-2)" />
  </svg>
);

const FindingGlyph = ({ kind }: { kind: FindingKind }) =>
  kind === "defect" ? <LaneGlyph lane="human-required" /> : <QuestionGlyph />;

function Install() {
  return (
    <div className="install">
      <div className="install-h">
        <span>{INSTALL.label}</span>
        <button
          className="copybtn"
          type="button"
          data-copy={INSTALL.lines.join("\n")}
          aria-label={UI.copyLabel}
        >
          <svg
            className="ic-copy"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect width="14" height="14" x="8" y="8" rx="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
          <svg
            className="ic-ok"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <span className="lbl">{UI.copy}</span>
        </button>
      </div>
      <pre>
        {INSTALL.lines.map((line, i) => (
          <span className="ln" key={line}>
            <span className="pr">$ </span>
            {line}
            {i < INSTALL.lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </pre>
    </div>
  );
}

function LinkArrow({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="link" href={href}>
      <span>{children}</span>
      <Arrow />
    </a>
  );
}

function Header() {
  return (
    <header className="top" id="top">
      <div className="wrap">
        <a className="brand" href="#main" aria-label={UI.home}>
          <Logo className="brand-logo" />
          Neuve
        </a>
        <nav className="nav" aria-label={UI.sections}>
          {NAV.map((n) => (
            <a key={n.href} href={n.href}>
              {n.label}
            </a>
          ))}
        </nav>
        <a className="navlink phone" href={`${REPO_URL}#readme`}>
          {UI.docs}
        </a>
        <a className="iconbtn" href={REPO_URL} aria-label={UI.githubLabel}>
          <GitHubIcon />
          <span className="ghlabel">{UI.github}</span>
        </a>
        <button
          className="iconbtn"
          id="theme"
          type="button"
          aria-label={UI.themeToDark}
          aria-pressed="false"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function Hero() {
  const verified = FINDERS.reduce(
    (n, f) => n + f.kept.filter(Boolean).length,
    0,
  );
  const [frame, find, decide] = STEPS;
  const StepHead = ({ n, title }: { n: number; title: string }) => (
    <div className="colhead">
      <span className="n" aria-hidden="true">
        {n}
      </span>
      <b>{title}</b>
    </div>
  );
  return (
    <div className="wrap hero" id="hero">
      <div className="hero-intro">
        <div>
          <h1>
            {HERO.headlineLead}
            <span className="landmark">
              <span className="hl">{HERO.headlineMark}</span>
            </span>
          </h1>
        </div>
        <div className="hero-sub">
          <div className="lede">
            <p>{HERO.subline}</p>
          </div>
          <div className="cta">
            <Install />
            <div className="row">
              <a className="btn" href={HERO.primary.href}>
                {HERO.primary.label} <Arrow />
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="batchline" id="how">
        <b>{BATCH.title}</b>
        <span className="cap">{BATCH.meta}</span>
      </div>
      {/* "How it works" is the stage itself: three steps, each one a column
          with its name above, the motion in the middle and its legend
          below. The visuals share one grid row, so their bottoms align. */}
      <div className="stage" id="stage">
        <p className="sr">{BATCH.summary}</p>
        <canvas id="sort-canvas" aria-hidden="true" />
        <ol className="stage-steps" aria-label="How it works">
          <li className="col step">
            <StepHead n={1} title={frame!.title} />
            <div className="field well" id="field" aria-hidden="true" />
            <p className="legend">{frame!.body}</p>
          </li>
          <li className="col step">
            <StepHead n={2} title={find!.title} />
            <div className="finders" id="finders" aria-hidden="true">
              {FINDERS.map((f) => (
                <div className="finder" key={f.key}>
                  <div className="meta">
                    <span className="name">{f.name}</span>
                  </div>
                  <div className="track" />
                </div>
              ))}
            </div>
            <p className="legend">{find!.body}</p>
          </li>
          <li className="col step you-col">
            <StepHead n={3} title={decide!.title} />
            <div className="you" id="you">
              <div className="you-h">
                <b>
                  <span id="you-n">{verified}</span> {STAGE.findings}
                </b>
              </div>
              <div id="frows">
                {FINDINGS.map((r, i) => (
                  <div className="frow" key={r.title}>
                    <button
                      type="button"
                      aria-expanded="false"
                      aria-controls={`fm${i}`}
                    >
                      <span className="slot">
                        <FindingGlyph kind={r.kind} />
                      </span>
                      <span>
                        <b>{r.title}</b>
                        <span className="why">{r.why}</span>
                      </span>
                      <svg
                        className="chev"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m9 6 6 6-6 6" />
                      </svg>
                    </button>
                    <div className="more" id={`fm${i}`}>
                      <div>
                        <p>
                          {r.unit}
                          <br />
                          {STAGE.checkedAgain}
                          <br />
                          {STAGE.cites} <span className="cite">{r.cite}</span>
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="you-f">
                <button className="replay" id="replay" type="button">
                  {STAGE.replay}
                </button>
              </div>
            </div>
            <p className="legend">{decide!.body}</p>
          </li>
        </ol>
      </div>
    </div>
  );
}

function DockReplica() {
  return (
    <div className="dockrep" aria-hidden="true">
      <span>
        <LaneGlyph lane="human-required" />
        {DESK.dock.covers}
      </span>
      <i />
      <b>{DESK.dock.request}</b>
      <b className="gold">{DESK.dock.approve}</b>
    </div>
  );
}

function Desk() {
  return (
    <section className="s" id="desk" aria-labelledby="desk-h">
      <div className="wrap">
        <div className="s-head">
          <h2 id="desk-h">{DESK.title}</h2>
          <p>
            {DESK.body.map((part, i) =>
              part.n ? (
                <span key={i} className="ref" data-n={part.n}>
                  {part.text}
                  <span className="ref-n" aria-hidden="true">
                    {part.n}
                  </span>
                </span>
              ) : (
                <span key={i}>{part.text}</span>
              ),
            )}
          </p>
        </div>
        <div className="desk-fig" id="desk-fig">
          <div className="desk-frame" id="desk-frame">
            <picture className="th-light">
              <img
                src="/screens/desk-light@2x.webp"
                srcSet={`/screens/desk-light-1612w.webp 1612w, /screens/desk-light@2x.webp 2240w`}
                sizes={DESK_IMG_SIZES}
                width={2240}
                height={1742}
                alt={DESK.alt}
                loading="lazy"
                decoding="async"
              />
            </picture>
            <picture className="th-dark">
              <img
                src="/screens/desk-dark@2x.webp"
                srcSet={`/screens/desk-dark-1612w.webp 1612w, /screens/desk-dark@2x.webp 2240w`}
                sizes={DESK_IMG_SIZES}
                width={2240}
                height={1742}
                alt={DESK.altDark}
                loading="lazy"
                decoding="async"
              />
            </picture>
            {DESK.callouts.map((d) => (
              <button
                key={d.n}
                type="button"
                className={`hot hot-${d.n}`}
                data-n={d.n}
                aria-expanded="false"
                aria-controls="peek"
                aria-label={`${d.n}. ${d.title}`}
              >
                {d.n}
              </button>
            ))}
            <div className="landrect land-lines" />
            <div className="landrect land-claim" />
            <DockReplica />
          </div>
          <div
            className="peek"
            id="peek"
            hidden
            role="region"
            aria-labelledby="peek-title"
          >
            <div className="peek-h">
              <span className="k" id="peek-num">
                1
              </span>
              <b id="peek-title" />
              <button type="button" id="peek-close" aria-label={DESK.close}>
                ✕
              </button>
            </div>
            <p id="peek-text" />
          </div>
        </div>
        <p className="desk-caption">{DESK.caption}</p>
        <div className="desk-legend" id="desk-legend">
          {DESK.callouts.map((d) => (
            <button
              key={d.n}
              type="button"
              data-n={d.n}
              aria-expanded="false"
              aria-controls="peek"
            >
              <span className="num">{d.n}</span>
              <span>
                <b>{d.title}</b>
                <span className="t">{d.short}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="desk-mini">
          <div className="card">
            <span className="lab">
              <LaneGlyph lane="human-required" />
              {DESK.mini.label}
            </span>
            <h3>{DESK.mini.title}</h3>
            <ul>
              {DESK.mini.claims.map((c, i) => (
                <li key={i}>
                  {c.text}
                  {c.linked ? <u>{c.linked}</u> : null}
                  {c.after ?? ""}
                </li>
              ))}
            </ul>
            <div className="pin">
              <LaneGlyph lane="human-required" />
              <span>
                {DESK.mini.finding}{" "}
                <span className="cite">{DESK.mini.cite}</span>
              </span>
            </div>
          </div>
          <DockReplica />
        </div>
      </div>
    </section>
  );
}

const PersonAvatar = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    <path
      d="M5 3h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-8l-4.5 3.5V18H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"
      fill="var(--nv-raised-2)"
    />
    <text
      x="12"
      y="13.8"
      textAnchor="middle"
      fontFamily="Geist Mono Variable, monospace"
      fontSize="7.5"
      fontWeight="600"
      fill="var(--nv-ink-2)"
    >
      VD
    </text>
  </svg>
);
const AgentAvatar = () => (
  <svg viewBox="0 0 24 29" width="24" height="29" aria-hidden="true">
    <path d="M12 7V2.5" stroke="var(--nv-agt-fg)" strokeWidth="1.2" />
    <circle cx="12" cy="2" r="1.6" fill="var(--nv-agt-fg)" />
    <rect
      x="2.5"
      y="7.5"
      width="19"
      height="19"
      rx="5.5"
      fill="var(--nv-agt-tint)"
      stroke="var(--nv-agt)"
      strokeWidth="1"
      strokeDasharray="2 2"
    />
    <text
      x="12"
      y="20.5"
      textAnchor="middle"
      fontFamily="Geist Mono Variable, monospace"
      fontSize="7.5"
      fontWeight="600"
      fill="var(--nv-agt-fg)"
    >
      I1
    </text>
  </svg>
);
const HookIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    <circle
      cx="12"
      cy="12"
      r="9"
      fill="none"
      stroke="var(--nv-line-strong)"
      strokeWidth="1.4"
    />
    <path
      d="M8 12.5l2.6 2.5L16 9.5"
      fill="none"
      stroke="var(--nv-ink-2)"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function Agents() {
  const icons = [
    <PersonAvatar key="p" />,
    <AgentAvatar key="a" />,
    <HookIcon key="h" />,
  ];
  return (
    <section className="s" id="agents" aria-labelledby="ag-h">
      <div className="wrap split">
        <div>
          <div className="s-head">
            <h2 id="ag-h">{AGENTS.title}</h2>
            <p>{AGENTS.body}</p>
          </div>
          <div className="readers">
            {AGENTS.readers.map((r, i) => (
              <div className="reader" key={r.who}>
                {icons[i]}
                <span>
                  <b>{r.who}</b>
                  {r.what}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div
          className="term"
          id="term"
          tabIndex={0}
          role="region"
          aria-label={AGENTS.terminalLabel}
        >
          <div className="term-bar">
            <span className="tab">{AGENTS.path}</span>
            <span>{AGENTS.shell}</span>
          </div>
          <p className="sr">{AGENTS.terminalSummary}</p>
          <pre aria-hidden="true">
            {AGENTS.commands.map((c, i) => (
              <span key={c.cmd}>
                {i > 0 ? <span className="ln"> </span> : null}
                <span className="ln">
                  <span className="mut">$ </span>
                  <span className={c.pipe ? "hl" : ""}>{c.cmd}</span>
                  {c.pipe ? <span className="mut"> {c.pipe}</span> : null}
                </span>
                <span className="ln mut"> {c.note}</span>
              </span>
            ))}
            <span className="ln later"> </span>
            <span className="ln later mut">{"  {"}</span>
            {AGENTS.json.map(([k, v], i) => (
              <span className="ln later" key={k}>
                {"    "}
                <span className="key">"{k}"</span>:{" "}
                <span className={k === "review" ? "req" : ""}>"{v}"</span>
                {i < AGENTS.json.length - 1 ? "," : ""}
              </span>
            ))}
            <span className="ln later mut">{"  }"}</span>
          </pre>
          <p className="cap term-note">{AGENTS.illustrative}</p>
        </div>
      </div>
    </section>
  );
}

function Chip({ unit }: { unit: MatrixUnit }) {
  const s = unit.after ? { ...unit, ...unit.after } : unit;
  return (
    <button
      type="button"
      className="uchip"
      data-id={unit.id}
      aria-pressed={unit.id === "retry" ? "true" : "false"}
    >
      <span className="g">
        <LaneGlyph lane={s.lane} />
      </span>
      <span>{unit.title}</span>
      {unit.tag ? <span className="tag">{unit.tag}</span> : null}
    </button>
  );
}

function Heading() {
  const retry = MATRIX_UNITS.find((u) => u.id === "retry")!;
  const r = { ...retry, ...retry.after };
  return (
    <section className="s" id="heading" aria-labelledby="hd-h">
      <div className="wrap">
        <div className="s-head">
          <span className="eyebrow">{HEADING.eyebrow}</span>
          <h2 id="hd-h">{HEADING.title}</h2>
          <p>{HEADING.body}</p>
        </div>
        <div className="matrix-wrap">
          <div>
            <div className="matrix" id="matrix">
              <span />
              <span className="axis top">{HEADING.axes.easy}</span>
              <span className="axis top">{HEADING.axes.hard}</span>
              {HEADING.quads.map((q, i) => (
                <FragmentQuad key={q.key} index={i} quad={q} />
              ))}
            </div>
            <p className="today">
              <span className="tagchip">{HEADING.today}</span>
              {HEADING.todayText}
              <button className="replay" id="m-replay" type="button">
                {HEADING.replay}
              </button>
            </p>
          </div>
          <aside className="ledger">
            <span className="eyebrow">{HEADING.ledgerLabel}</span>
            <div id="ledger-body">
              <h3>{r.title}</h3>
              <dl>
                <dt>{HEADING.rows.cx}</dt>
                <dd>{r.cx}</dd>
                <dt>{HEADING.rows.v}</dt>
                <dd data-k="v">{r.v}</dd>
                <dt>{HEADING.rows.h}</dt>
                <dd data-k="h">{r.h}</dd>
                <dt>{HEADING.rows.br}</dt>
                <dd>{r.br}</dd>
                <dt>{HEADING.rows.lane}</dt>
                <dd data-k="lane">
                  <span className="lanechip">
                    <LaneGlyph lane={r.lane} />
                    {r.laneName}
                  </span>
                </dd>
              </dl>
            </div>
          </aside>
        </div>
      </div>
      <template id="glyphs">
        {(
          [
            "human-required",
            "human-suggested",
            "agentic-review",
            "static-automation",
          ] as const
        ).map((lane) => (
          <span key={lane} data-glyph={lane}>
            <LaneGlyph lane={lane} />
          </span>
        ))}
      </template>
    </section>
  );
}

function FragmentQuad({
  quad,
  index,
}: {
  quad: (typeof HEADING.quads)[number];
  index: number;
}) {
  const side =
    index === 0 ? HEADING.axes.low : index === 2 ? HEADING.axes.high : null;
  return (
    <>
      {side ? <span className="axis side">{side}</span> : null}
      <div className="quad" data-q={quad.key}>
        <span className="qaxes">{quad.axes}</span>
        <span className="qlane">
          <LaneGlyph lane={quad.lane} />
          {quad.label}
        </span>
        {MATRIX_UNITS.filter(
          (u) => (u.after ? u.after.q : u.q) === quad.key,
        ).map((u) => (
          <Chip key={u.id} unit={u} />
        ))}
      </div>
    </>
  );
}

function Open() {
  return (
    <section className="s" id="open" aria-labelledby="os-h">
      <div className="wrap">
        <div className="s-head">
          <h2 id="os-h">{OPEN.title}</h2>
          <p>{OPEN.body}</p>
        </div>
        <p className="credits">
          {OPEN.credits.map((c, i) =>
            c.href ? (
              <a key={i} href={c.href} className={c.mono ? "mono" : undefined}>
                {c.text}
              </a>
            ) : c.mono ? (
              <span key={i} className="mono">
                {c.text}
              </span>
            ) : (
              <span key={i}>{c.text}</span>
            ),
          )}
        </p>
      </div>
    </section>
  );
}

function Close() {
  return (
    <section className="wrap close" aria-labelledby="cl-h">
      <h2 id="cl-h">{CLOSE.title}</h2>
      <div className="cta">
        <Install />
        <div className="row">
          <a className="btn" href={HERO.primary.href}>
            {HERO.primary.label} <Arrow />
          </a>
          <LinkArrow href={CLOSE.source.href}>{CLOSE.source.label}</LinkArrow>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div
          className="markfield"
          id="markfield"
          role="img"
          aria-label={FOOTER.markLabel}
        >
          <canvas id="mark-canvas" aria-hidden="true" />
          <Logo className="mark-static" />
        </div>
        <p className="tagline">{FOOTER.tagline}</p>
        <div className="foot">
          <span>{FOOTER.line}</span>
          <nav aria-label={UI.footer}>
            {FOOTER.links.map((l) => (
              <a key={l.label} href={l.href}>
                {l.label}
              </a>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}

// The screenshot is drawn at 143.9% of the frame (it's cropped), and the frame
// is 1120 px at most: 1612 px wide on a wide screen, about 144vw below that.
const DESK_IMG_SIZES = "(min-width: 1152px) 1612px, 144vw";
export function Page() {
  return (
    <>
      <a className="skip" href="#main">
        {UI.skip}
      </a>
      <Header />
      <main id="main">
        <Hero />
        <Desk />
        <Agents />
        <Heading />
        <Open />
        <Close />
        <span className="sr" aria-live="polite" id="live" />
      </main>
      <Footer />
    </>
  );
}
