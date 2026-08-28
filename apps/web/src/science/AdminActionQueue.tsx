import { useCallback, useEffect, useRef, useState } from "react";
import { Chip } from "@puppetmaster/ui";
import {
  scienceApi,
  type ScienceAdminActionQueueItem,
  type SciencePage,
} from "../api.js";
import { scienceError } from "./science-utils.js";

const ADMIN_QUEUE_PAGE_SIZE = 12;
const ADMIN_QUEUE_REFRESH_MS = 30_000;
const ADMIN_REASON_LABELS: Record<ScienceAdminActionQueueItem["reason"], string> = {
  compute_reconciliation_required: "Compute run needs administrator reconciliation.",
  upload_quarantined: "Upload is quarantined and needs review.",
  upload_cleanup_retry_pending: "Upload cleanup is waiting for another retry.",
  artifact_version_quarantined: "Artifact version is quarantined and needs review.",
  artifact_version_cleanup_retry_pending: "Artifact cleanup is waiting for another retry.",
  render_session_cleanup_pending: "Render session cleanup is waiting for administrator attention.",
};

function retryUtc(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed
    .toISOString()
    .replace("T", " ")
    .replace(/\.000Z$/, " UTC");
}

function RetryReadout({ value }: { value: string | null }) {
  return value
    ? <time dateTime={value} title={value}>{retryUtc(value)}</time>
    : <span>NONE</span>;
}
const EMPTY_QUEUE: SciencePage<ScienceAdminActionQueueItem> = {
  items: [],
  nextCursor: null,
};

export function AdminActionQueue(props: {
  onNavigate: (item: ScienceAdminActionQueueItem) => Promise<void>;
}) {
  const [page, setPage] = useState<SciencePage<ScienceAdminActionQueueItem>>(EMPTY_QUEUE);
  const [cursor, setCursor] = useState<string | null>(null);
  const [back, setBack] = useState<(string | null)[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [navigatingId, setNavigatingId] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async (nextCursor: string | null) => {
    const requestId = ++request.current;
    setLoading(true);
    try {
      const next = await scienceApi.adminActionQueue({
        cursor: nextCursor,
        limit: ADMIN_QUEUE_PAGE_SIZE,
      });
      if (requestId !== request.current) return;
      setPage(next);
      setLoadError(null);
    } catch (error) {
      if (requestId !== request.current) return;
      setLoadError(scienceError(error));
    } finally {
      if (requestId === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(cursor);
    return () => {
      request.current++;
    };
  }, [cursor, load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(cursor);
    }, ADMIN_QUEUE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [cursor, load]);

  const navigate = async (item: ScienceAdminActionQueueItem) => {
    setNavigatingId(item.id);
    setNavigationError(null);
    try {
      await props.onNavigate(item);
    } catch (error) {
      setNavigationError(scienceError(error));
    } finally {
      setNavigatingId(null);
    }
  };

  const previousPage = () => {
    if (loading || back.length === 0) return;
    const previous = back[back.length - 1] ?? null;
    setBack((history) => history.slice(0, -1));
    setCursor(previous);
  };

  const nextPage = () => {
    if (loading || !page.nextCursor) return;
    setBack((history) => [...history, cursor]);
    setCursor(page.nextCursor);
  };

  return (
    <section
      className="sci-admin-action-queue"
      aria-labelledby="science-admin-action-queue-title"
      aria-busy={loading}
    >
      <div className="sci-admin-queue-head">
        <span id="science-admin-action-queue-title">
          ADMIN ACTION QUEUE // <b>{page.items.length}</b>
        </span>
        <Chip tiny disabled={loading} onClick={() => void load(cursor)}>
          {loading ? "REFRESHING" : "REFRESH"}
        </Chip>
      </div>

      {loading && page.items.length === 0 && (
        <p className="sci-admin-queue-state" role="status">LOADING REDACTED ACTION QUEUE...</p>
      )}
      {loadError && <p className="sci-error sci-admin-queue-error" role="alert">{loadError}</p>}
      {navigationError && (
        <p className="sci-error sci-admin-queue-error" role="alert">{navigationError}</p>
      )}
      {!loading && !loadError && page.items.length === 0 && (
        <p className="sci-admin-queue-state">NO ADMIN ACTIONS REQUIRE ATTENTION.</p>
      )}

      {page.items.length > 0 && (
        <ol className="sci-admin-queue-list">
          {page.items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <div className="sci-admin-queue-item-head">
                <b>{item.kind}</b>
                <code>{item.id}</code>
              </div>
              <dl className="sci-admin-queue-facts">
                <div>
                  <dt>REASON</dt>
                  <dd>
                    <span>{ADMIN_REASON_LABELS[item.reason]}</span>
                    <code title="Exact redacted reason code">{item.reason}</code>
                  </dd>
                </div>
                <div><dt>STATE</dt><dd>{item.state}</dd></div>
                <div><dt>AGE SECONDS</dt><dd>{item.ageSeconds}</dd></div>
                <div><dt>ATTEMPTS</dt><dd>{item.attempts}</dd></div>
                <div><dt>NEXT RETRY</dt><dd><RetryReadout value={item.nextRetryAt} /></dd></div>
              </dl>
              <div className="sci-admin-queue-actions">
                <span>LINKS // {item.links.map((link) => link.rel).join(" / ") || "NONE"}</span>
                <Chip
                  tiny
                  disabled={item.links.length === 0 || navigatingId !== null}
                  onClick={() => void navigate(item)}
                >
                  {navigatingId === item.id ? "NAVIGATING" : "OPEN LINKED CONTEXT"}
                </Chip>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="sci-pager sci-admin-queue-pager">
        <Chip tiny disabled={loading || back.length === 0} onClick={previousPage}>PREV</Chip>
        <span>OFFSET {cursor ?? "0"}</span>
        <Chip tiny disabled={loading || !page.nextCursor} onClick={nextPage}>NEXT</Chip>
      </div>
    </section>
  );
}
