// Thin client for the sesame API. The session lives in an HttpOnly cookie on the same
// origin, so requests carry it automatically; this module never sees a token.
import type {
  AppPasswordsResponse,
  BatchRequest,
  BatchResponse,
  CreateAppPasswordRequest,
  CreateAppPasswordResponse,
  DownloadUrl,
  FoldersResponse,
  MeResponse,
  MessageChanges,
  MessageResponse,
  MessageSummary,
  Page,
  SearchResponse,
  SendRequest,
  SendResponse,
  SystemFolder,
  ThreadResponse,
  UploadResponse,
} from "@sesame/core/dto";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Sends the browser through sign-in and back to where it was. */
export function signIn(returnTo = location.pathname + location.search): never {
  location.assign(`/api/auth/login?return=${encodeURIComponent(returnTo)}`);
  throw new ApiError(401, "redirecting to sign-in");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") headers.set("X-Requested-With", "sesame");
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin" });
  if (res.status === 401) signIn();
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

const mbx = (mailboxId: string) => `/mailboxes/${encodeURIComponent(mailboxId)}`;

/** A folder or the cross-folder flagged view. */
export type View = SystemFolder | "flagged";

/** What the message list can show: a view, or search results. */
export type ListView = View | "search";

export const api = {
  me: () => request<MeResponse>("/me"),

  folders: (mailboxId: string) => request<FoldersResponse>(`${mbx(mailboxId)}/folders`),

  messages: (mailboxId: string, view: View, opts: { cursor?: string; unread?: boolean; limit?: number }) => {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (view === "flagged") params.set("flagged", "1");
    else params.set("folder", view);
    if (opts.unread && view !== "flagged") params.set("unread", "1");
    if (opts.cursor) params.set("cursor", opts.cursor);
    return request<Page<MessageSummary>>(`${mbx(mailboxId)}/messages?${params}`);
  },

  search: (mailboxId: string, q: string, cursor?: string) => {
    const params = new URLSearchParams({ q, limit: "50" });
    if (cursor) params.set("cursor", cursor);
    return request<SearchResponse>(`${mbx(mailboxId)}/search?${params}`);
  },

  message: (mailboxId: string, id: string) => request<MessageResponse>(`${mbx(mailboxId)}/messages/${id}`),

  thread: (mailboxId: string, threadId: string) =>
    request<ThreadResponse>(`${mbx(mailboxId)}/threads/${threadId}`),

  update: (mailboxId: string, id: string, changes: MessageChanges) =>
    request<{ message: MessageSummary }>(`${mbx(mailboxId)}/messages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    }),

  remove: (mailboxId: string, id: string) =>
    request<{ result: "trashed" | "purged" }>(`${mbx(mailboxId)}/messages/${id}`, { method: "DELETE" }),

  batch: (mailboxId: string, body: BatchRequest) =>
    request<BatchResponse>(`${mbx(mailboxId)}/messages/batch`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** A short-lived URL for showing an inline image. */
  inlineImageUrl: (mailboxId: string, id: string, partId: string) =>
    request<DownloadUrl>(
      `${mbx(mailboxId)}/messages/${id}/attachments/${encodeURIComponent(partId)}?inline=1&as=url`,
    ),

  send: (mailboxId: string, body: SendRequest) =>
    request<SendResponse>(`${mbx(mailboxId)}/send`, { method: "POST", body: JSON.stringify(body) }),

  /** Uploads one attachment straight to S3 and returns its upload ID. */
  async upload(file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
    const contentType = file.type || "application/octet-stream";
    const target = await request<UploadResponse>("/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentType, size: file.size }),
    });
    const form = new FormData();
    for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
    form.append("file", file);
    // XMLHttpRequest, because fetch() can't report upload progress.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", target.url);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, "upload failed"));
      xhr.onerror = () => reject(new ApiError(0, "upload failed: network error"));
      xhr.onabort = () => reject(new ApiError(0, "upload cancelled"));
      signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(form);
    });
    return target.uploadId;
  },

  appPasswords: () => request<AppPasswordsResponse>("/app-passwords"),

  createAppPassword: (body: CreateAppPasswordRequest) =>
    request<CreateAppPasswordResponse>("/app-passwords", { method: "POST", body: JSON.stringify(body) }),

  revokeAppPassword: (id: string) =>
    request<{ ok: true }>(`/app-passwords/${encodeURIComponent(id)}`, { method: "DELETE" }),

  async signOut() {
    const { logoutUrl } = await request<{ logoutUrl: string }>("/auth/logout", { method: "POST" });
    location.assign(logoutUrl);
  },
};

/** Plain links: the API answers with a redirect to a presigned download. */
export const links = {
  attachment: (mailboxId: string, id: string, partId: string) =>
    `/api${mbx(mailboxId)}/messages/${id}/attachments/${encodeURIComponent(partId)}`,
  raw: (mailboxId: string, id: string) => `/api${mbx(mailboxId)}/messages/${id}/raw`,
};
