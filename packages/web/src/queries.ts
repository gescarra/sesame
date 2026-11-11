// Server state: TanStack Query hooks over the API, with optimistic updates for actions.
import type { MessageChanges, MessageSummary, Page, SystemFolder } from "@sesame/core/dto";
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, api, type View } from "./api.ts";

/** New mail is found by polling folder counts; lists refresh when the counts change. */
const POLL_MS = 60_000;

export const keys = {
  me: ["me"] as const,
  folders: (mbx: string) => ["folders", mbx] as const,
  messages: (mbx: string) => ["messages", mbx] as const,
  list: (mbx: string, view: View, unread: boolean) => ["messages", mbx, view, unread] as const,
  search: (mbx: string, q: string) => ["messages", mbx, "search", q] as const,
  message: (mbx: string, id: string) => ["message", mbx, id] as const,
  thread: (mbx: string, threadId: string) => ["thread", mbx, threadId] as const,
  appPasswords: ["app-passwords"] as const,
};

export function retryUnlessClientError(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failures < 2;
}

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: api.me, staleTime: 5 * 60_000 });
}

export function useAppPasswords() {
  return useQuery({ queryKey: keys.appPasswords, queryFn: api.appPasswords });
}

/** Creating and revoking app passwords; both refresh the list. */
export function useAppPasswordActions() {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: keys.appPasswords });
  const create = useMutation({ mutationFn: api.createAppPassword, onSettled: refresh });
  const revoke = useMutation({ mutationFn: api.revokeAppPassword, onSettled: refresh });
  return { create, revoke };
}

export function useFolders(mbx: string) {
  return useQuery({
    queryKey: keys.folders(mbx),
    queryFn: () => api.folders(mbx),
    refetchInterval: POLL_MS,
  });
}

export function useMessageList(mbx: string, view: View, unread: boolean, enabled = true) {
  return useInfiniteQuery({
    enabled,
    queryKey: keys.list(mbx, view, unread),
    queryFn: ({ pageParam }) =>
      api.messages(mbx, view, pageParam ? { cursor: pageParam, unread } : { unread }),
    initialPageParam: "",
    getNextPageParam: (last) => last.cursor,
    refetchInterval: POLL_MS,
  });
}

export function useSearch(mbx: string, q: string) {
  return useInfiniteQuery({
    enabled: q.trim().length > 0,
    queryKey: keys.search(mbx, q),
    queryFn: ({ pageParam }) => api.search(mbx, q, pageParam || undefined),
    initialPageParam: "",
    getNextPageParam: (last) => last.cursor,
  });
}

export function useMessage(mbx: string, id: string | undefined) {
  return useQuery({
    queryKey: keys.message(mbx, id ?? ""),
    queryFn: () => api.message(mbx, id ?? ""),
    enabled: Boolean(id),
  });
}

export function useThread(mbx: string, threadId: string | undefined) {
  return useQuery({
    queryKey: keys.thread(mbx, threadId ?? ""),
    queryFn: () => api.thread(mbx, threadId ?? ""),
    enabled: Boolean(threadId),
  });
}

export function useInlineImage(mbx: string, id: string, partId: string) {
  return useQuery({
    queryKey: ["inline", mbx, id, partId],
    queryFn: () => api.inlineImageUrl(mbx, id, partId),
    // Presigned for 5 minutes; refresh a little before that.
    staleTime: 4 * 60_000,
  });
}

type ListData = InfiniteData<Page<MessageSummary>, string>;

/**
 * Applies a change to every cached list. Messages that leave a list (moved out of its folder,
 * unflagged in the flagged view, read in an unread-only list) disappear right away.
 */
export function patchLists(
  client: QueryClient,
  mbx: string,
  ids: Set<string>,
  change: MessageChanges | "delete",
) {
  for (const [key, data] of client.getQueriesData<ListData>({ queryKey: keys.messages(mbx) })) {
    if (!data) continue;
    const [, , view] = key as ReturnType<typeof keys.list> | ReturnType<typeof keys.search>;
    client.setQueryData<ListData>(key, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((m) => {
          if (!ids.has(m.id)) return [m];
          if (change === "delete") return [];
          const next = { ...m, ...change };
          // Search results span folders, so a moved message stays in them.
          if (view === "search") return [next];
          if (view === "flagged" ? !next.flagged : next.folder !== view) return [];
          // A message read in an unread-only list stays (shown read) until the next refresh,
          // so the list doesn't jump while the user is reading it.
          return [next];
        }),
      })),
    });
  }
}

/** Read/flag/move/delete for one or more messages, applied optimistically. */
export function useMessageActions(mbx: string) {
  const client = useQueryClient();

  const settle = (ids: string[]) => {
    void client.invalidateQueries({ queryKey: keys.folders(mbx) });
    void client.invalidateQueries({ queryKey: keys.messages(mbx) });
    for (const id of ids) void client.invalidateQueries({ queryKey: keys.message(mbx, id) });
    void client.invalidateQueries({ queryKey: ["thread", mbx] });
    // Purging from trash frees space, which /me reports.
    void client.invalidateQueries({ queryKey: keys.me });
  };

  const optimistic = async (ids: string[], change: MessageChanges | "delete") => {
    await client.cancelQueries({ queryKey: keys.messages(mbx) });
    patchLists(client, mbx, new Set(ids), change);
    if (change !== "delete") {
      for (const id of ids) {
        client.setQueryData(
          keys.message(mbx, id),
          (old: Awaited<ReturnType<typeof api.message>> | undefined) =>
            old ? { ...old, message: { ...old.message, ...change } } : old,
        );
      }
    }
  };

  const update = useMutation({
    mutationFn: async ({ ids, changes }: { ids: string[]; changes: MessageChanges }) => {
      const [only] = ids;
      if (ids.length === 1 && only) {
        await api.update(mbx, only, changes);
        return;
      }
      const action =
        changes.folder !== undefined
          ? "move"
          : changes.flagged !== undefined
            ? changes.flagged
              ? "flag"
              : "unflag"
            : changes.read
              ? "read"
              : "unread";
      const body = changes.folder ? { ids, action, folder: changes.folder } : { ids, action };
      await api.batch(mbx, body as Parameters<typeof api.batch>[1]);
    },
    onMutate: ({ ids, changes }) => optimistic(ids, changes),
    onSettled: (_data, _error, { ids }) => settle(ids),
  });

  /** Moves to trash, or deletes for good when already in trash. */
  const remove = useMutation({
    mutationFn: async ({ ids }: { ids: string[]; inTrash: boolean }) => {
      const [only] = ids;
      if (ids.length === 1 && only) await api.remove(mbx, only);
      else await api.batch(mbx, { ids, action: "delete" });
    },
    onMutate: ({ ids, inTrash }) => optimistic(ids, inTrash ? "delete" : { folder: "trash" }),
    onSettled: (_data, _error, { ids }) => settle(ids),
  });

  return {
    setRead: (ids: string[], read: boolean) => update.mutate({ ids, changes: { read } }),
    setFlagged: (ids: string[], flagged: boolean) => update.mutate({ ids, changes: { flagged } }),
    move: (ids: string[], folder: SystemFolder) => update.mutate({ ids, changes: { folder } }),
    remove: (ids: string[], inTrash: boolean) => remove.mutate({ ids, inTrash }),
    error: update.error ?? remove.error,
    pending: update.isPending || remove.isPending,
  };
}
