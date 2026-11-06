// A small inline icon set (24px grid, 1.75 stroke), so the SPA loads nothing external.
const PATHS = {
  inbox: "M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6H3v-6z",
  flag: "M5 21V4m0 0h11l-2 4 2 4H5",
  send: "M4 12 20 4l-4 16-4-7-8-1zm8 1 8-9",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  junk: "M12 3 3 19h18zM12 10v4m0 3v.01",
  trash: "M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13",
  mailOpen: "M3 10l9-6 9 6v10H3zm0 0 9 6 9-6",
  mail: "M3 6h18v12H3zm0 0 9 7 9-7",
  move: "M3 7h7l2 2h9v10H3zM12 12l3 2-3 2m-5-2h8",
  back: "M15 5 8 12l7 7",
  download: "M12 4v11m-5-5 5 5 5-5M5 20h14",
  paperclip: "M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7",
  image: "M4 5h16v14H4zm0 11 5-5 4 4 3-3 4 4M15 9.5v.01",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  restore: "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5",
  close: "M6 6l12 12M18 6 6 18",
  reply: "M10 7 4 12l6 5M4 12h10a6 6 0 0 1 6 6v1",
  replyAll: "M11 7l-5 5 5 5M7 7l-5 5 5 5M6 12h9a6 6 0 0 1 6 6v1",
  forward: "M14 7l6 5-6 5M20 12H10a6 6 0 0 0-6 6v1",
  compose: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zm4.6-1.9L20 20",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; label?: string; filled?: boolean }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill={props.filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
