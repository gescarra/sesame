import type { SessionUser } from "@sesame/api/session";
import type { Child, FC } from "hono/jsx";

export type Section = "overview" | "domains" | "mailboxes" | "suppressions" | "activity";

const NAV: [Section, string, string][] = [
  ["overview", "Overview", "/admin"],
  ["domains", "Domains", "/admin/domains"],
  ["mailboxes", "Mailboxes", "/admin/mailboxes"],
  ["suppressions", "Suppressions", "/admin/suppressions"],
  ["activity", "Activity", "/admin/activity"],
];

export interface Flash {
  notice?: string | undefined;
  error?: string | undefined;
}

export const Layout: FC<{
  title: string;
  section?: Section;
  user?: SessionUser;
  flash?: Flash;
  children?: Child;
}> = ({ title, section, user, flash, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{`${title} · sesame admin`}</title>
      <link rel="stylesheet" href="/admin/static/admin.css" />
    </head>
    <body>
      <header class="top">
        <div class="brand">
          sesame <span>admin</span>
        </div>
        {user ? (
          <nav aria-label="Sections">
            {NAV.map(([key, label, href]) => (
              <a href={href} class={key === section ? "active" : undefined}>
                {label}
              </a>
            ))}
          </nav>
        ) : null}
        <div class="who">
          {user ? <span class="hide-narrow">{user.email}</span> : null}
          <a href="/">Open mail</a>
        </div>
      </header>
      <main>
        <h1>{title}</h1>
        {flash?.notice ? (
          <p class="flash notice" role="status">
            {flash.notice}
          </p>
        ) : null}
        {flash?.error ? (
          <p class="flash error" role="alert">
            {flash.error}
          </p>
        ) : null}
        {children}
      </main>
    </body>
  </html>
);

export const Pill: FC<{ tone: "ok" | "warn" | "bad" | "plain"; children?: Child }> = ({ tone, children }) => (
  <span class={tone === "plain" ? "pill" : `pill ${tone}`}>{children}</span>
);

export function formatMb(bytes: number): string {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export const Usage: FC<{ used: number; quota?: number | undefined }> = ({ used, quota }) => {
  if (quota === undefined) return <span>{formatMb(used)}</span>;
  // A native meter needs no inline style, which the console's CSP forbids.
  return (
    <span>
      <meter
        min={0}
        max={quota}
        value={Math.min(used, quota)}
        high={quota * 0.9}
        optimum={0}
        aria-hidden="true"
      />{" "}
      {formatMb(used)} of {formatMb(quota)}
    </span>
  );
};

export function formatTime(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}
