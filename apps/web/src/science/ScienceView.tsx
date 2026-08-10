import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Chip, HoldButton, Panel, Stat } from "@puppetmaster/ui";
import {
  ApiError,
  prefsApi,
  scienceApi,
  type ScienceArtifact,
  type ScienceArtifactVersion,
  type ScienceComputeProfile,
  type ScienceComputeProfileInput,
  type ScienceLayout,
  type ScienceManifest,
  type SciencePage,
  type ScienceRenderSession,
  type ScienceRun,
  type ScienceRunComparison,
  type ScienceRunInput,
  type ScienceStudy,
  type ScienceWorkspaceAdmission,
} from "../api.js";
import type { SignalEntry } from "../Signal.js";
import { ArtifactVersionControl } from "./ArtifactVersionControl.js";
import { ComputeProfileManager } from "./ComputeProfileManager.js";
import { ManifestInspector } from "./ManifestInspector.js";
import { PipelineStrip } from "./PipelineStrip.js";
import { RunConfigurator } from "./RunConfigurator.js";
import { RunDossier } from "./RunDossier.js";
import { ScienceRail } from "./ScienceRail.js";
import { ScienceViewport, type ScienceFallbackMode } from "./ScienceViewport.js";
import {
  fmtBytes,
  fmtElapsed,
  randomIdempotencyKey,
  SCIENCE_ACTIVE_RUN_STATES,
  SCIENCE_PAGE_SIZE,
  scienceError,
  sha256Blob,
  usePrefersReducedMotion,
} from "./science-utils.js";

const EMPTY_PAGE = <T,>(): SciencePage<T> => ({ items: [], nextCursor: null });

export function ScienceView(props: {
  canBuild: boolean;
  isAdmin: boolean;
  connected: boolean;
  signals: SignalEntry[];
  onTrackMission: (missionId: string) => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [studyPage, setStudyPage] = useState<SciencePage<ScienceStudy>>(EMPTY_PAGE);
  const [studyCursor, setStudyCursor] = useState<string | null>(null);
  const [studyBack, setStudyBack] = useState<(string | null)[]>([]);
  const [studiesLoading, setStudiesLoading] = useState(true);
  const [studiesError, setStudiesError] = useState<string | null>(null);
  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null);
  const [studyDetail, setStudyDetail] = useState<ScienceStudy | null>(null);

  const [artifactPage, setArtifactPage] = useState<SciencePage<ScienceArtifact>>(EMPTY_PAGE);
  const [artifactCursor, setArtifactCursor] = useState<string | null>(null);
  const [artifactBack, setArtifactBack] = useState<(string | null)[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [selectedArtifactDetail, setSelectedArtifactDetail] =
    useState<ScienceArtifact | null>(null);
  const [artifactVersionPage, setArtifactVersionPage] =
    useState<SciencePage<ScienceArtifactVersion>>(EMPTY_PAGE);
  const [artifactVersionCursor, setArtifactVersionCursor] =
    useState<string | null>(null);
  const [artifactVersionBack, setArtifactVersionBack] =
    useState<(string | null)[]>([]);
  const [artifactVersionsLoading, setArtifactVersionsLoading] = useState(false);
  const [artifactVersionsError, setArtifactVersionsError] =
    useState<string | null>(null);
  const [selectedArtifactVersion, setSelectedArtifactVersion] =
    useState<ScienceArtifactVersion | null>(null);

  const [runPage, setRunPage] = useState<SciencePage<ScienceRun>>(EMPTY_PAGE);
  const [runCursor, setRunCursor] = useState<string | null>(null);
  const [runBack, setRunBack] = useState<(string | null)[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<ScienceRun | null>(null);

  const [profiles, setProfiles] = useState<ScienceComputeProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [admission, setAdmission] = useState<ScienceWorkspaceAdmission | null>(null);
  const [admissionLoading, setAdmissionLoading] = useState(true);
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const [admissionReason, setAdmissionReason] = useState("");
  const [admissionBusy, setAdmissionBusy] = useState(false);
  const [manifest, setManifest] = useState<ScienceManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<ScienceRunComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [renderSession, setRenderSession] = useState<ScienceRenderSession | null>(null);
  const renderSessionRef = useRef<ScienceRenderSession | null>(null);

  const [railCollapsed, setRailCollapsed] = useState(false);
  const [dossierCollapsed, setDossierCollapsed] = useState(false);
  const [fallbackMode, setFallbackMode] = useState<ScienceFallbackMode>("auto");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Science Operations initialized.");
  const [utcClock, setUtcClock] = useState(() => new Date().toISOString().slice(11, 19));
  const [syncState, setSyncState] = useState<"live" | "disconnected" | "resyncing">(
    props.connected ? "live" : "disconnected",
  );
  const prefsReady = useRef(false);
  const studiesRequest = useRef(0);
  const artifactsRequest = useRef(0);
  const artifactVersionsRequest = useRef(0);
  const runsRequest = useRef(0);
  const comparisonRequest = useRef(0);
  const admissionReadRequest = useRef(0);
  const admissionMutationRequest = useRef(0);
  const admissionMutationPending = useRef(false);
  const previousConnected = useRef(props.connected);

  const selectedStudy = useMemo(
    () => studyPage.items.find((study) => study.id === selectedStudyId) ?? studyDetail,
    [studyPage.items, selectedStudyId, studyDetail],
  );
  const selectedArtifact = useMemo(
    () =>
      artifactPage.items.find((artifact) => artifact.id === selectedArtifactId) ??
      (selectedArtifactDetail?.id === selectedArtifactId ? selectedArtifactDetail : null),
    [artifactPage.items, selectedArtifactDetail, selectedArtifactId],
  );
  const inspectedArtifact = useMemo(
    () =>
      selectedArtifact
        ? {
            ...selectedArtifact,
            latestVersion:
              selectedArtifactVersion?.artifactId === selectedArtifact.id
                ? selectedArtifactVersion
                : selectedArtifact.latestVersion,
          }
        : null,
    [selectedArtifact, selectedArtifactVersion],
  );
  const selectedRun = useMemo(
    () => runPage.items.find((run) => run.id === selectedRunId) ?? runDetail,
    [runPage.items, selectedRunId, runDetail],
  );
  const latestScienceSignal = props.signals.find((signal) => signal.type.startsWith("science.")) ?? null;
  const newWorkEnabled =
    props.canBuild && admission?.admitted === true && !admissionBusy;
  const admissionState = admission
    ? admission.admitted ? "admitted" : "blocked"
    : admissionLoading ? "checking" : "unknown";

  const loadStudies = useCallback(async (cursor: string | null = null) => {
    const request = ++studiesRequest.current;
    setStudiesLoading(true);
    try {
      const page = await scienceApi.studies({ cursor, limit: SCIENCE_PAGE_SIZE });
      if (request !== studiesRequest.current) return;
      setStudyPage(page);
      setStudiesError(null);
      setSelectedStudyId((current) => current ?? page.items[0]?.id ?? null);
    } catch (error) {
      if (request !== studiesRequest.current) return;
      setStudiesError(scienceError(error));
      setStudyPage(EMPTY_PAGE());
    } finally {
      if (request === studiesRequest.current) setStudiesLoading(false);
    }
  }, []);

  const loadArtifacts = useCallback(async (
    studyId: string,
    cursor: string | null = null,
  ) => {
    const request = ++artifactsRequest.current;
    setArtifactsLoading(true);
    try {
      const page = await scienceApi.artifacts(studyId, { cursor, limit: SCIENCE_PAGE_SIZE });
      if (request !== artifactsRequest.current) return;
      setArtifactPage(page);
      setArtifactsError(null);
      setSelectedArtifactId((current) =>
        page.items.some((artifact) => artifact.id === current) ? current : page.items[0]?.id ?? null);
    } catch (error) {
      if (request !== artifactsRequest.current) return;
      setArtifactsError(scienceError(error));
      setArtifactPage(EMPTY_PAGE());
      setSelectedArtifactId(null);
    } finally {
      if (request === artifactsRequest.current) setArtifactsLoading(false);
    }
  }, []);

  const loadArtifactVersions = useCallback(async (
    artifactId: string,
    cursor: string | null = null,
  ) => {
    const request = ++artifactVersionsRequest.current;
    setArtifactVersionsLoading(true);
    try {
      const page = await scienceApi.artifactVersions(artifactId, {
        cursor,
        limit: 20,
      });
      if (request !== artifactVersionsRequest.current) return;
      setArtifactVersionPage(page);
      setArtifactVersionsError(null);
      setSelectedArtifactVersion((current) =>
        current?.artifactId === artifactId &&
        page.items.some(
          (version) =>
            version.id === current.id &&
            version.status === "ready",
        )
          ? current
          : page.items.find((version) => version.status === "ready") ?? null);
    } catch (error) {
      if (request !== artifactVersionsRequest.current) return;
      setArtifactVersionsError(scienceError(error));
      setArtifactVersionPage(EMPTY_PAGE());
      setSelectedArtifactVersion(null);
    } finally {
      if (request === artifactVersionsRequest.current) {
        setArtifactVersionsLoading(false);
      }
    }
  }, []);

  const loadRuns = useCallback(async (
    studyId: string,
    cursor: string | null = null,
  ) => {
    const request = ++runsRequest.current;
    setRunsLoading(true);
    try {
      const page = await scienceApi.runs(studyId, { cursor, limit: 12 });
      if (request !== runsRequest.current) return;
      setRunPage(page);
      setRunsError(null);
      setSelectedRunId((current) => current ?? page.items[0]?.id ?? null);
    } catch (error) {
      if (request !== runsRequest.current) return;
      setRunsError(scienceError(error));
      setRunPage(EMPTY_PAGE());
      setSelectedRunId(null);
    } finally {
      if (request === runsRequest.current) setRunsLoading(false);
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    setProfilesLoading(true);
    try {
      setProfiles(await scienceApi.computeProfiles());
      setProfilesError(null);
    } catch (error) {
      setProfiles([]);
      setProfilesError(scienceError(error));
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  const loadAdmission = useCallback(async (showLoading = true) => {
    if (admissionMutationPending.current) return;
    const request = ++admissionReadRequest.current;
    if (showLoading) setAdmissionLoading(true);
    try {
      const next = await scienceApi.workspaceAdmission();
      if (request !== admissionReadRequest.current || admissionMutationPending.current) return;
      setAdmission(next);
      setAdmissionError(null);
    } catch (error) {
      if (request !== admissionReadRequest.current || admissionMutationPending.current) return;
      setAdmission(null);
      setAdmissionError(scienceError(error));
    } finally {
      if (request === admissionReadRequest.current && !admissionMutationPending.current) {
        setAdmissionLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadAdmission();
  }, [loadAdmission]);

  useEffect(() => {
    const refreshAdmission = () => {
      if (!document.hidden && !admissionMutationPending.current) loadAdmission(false);
    };
    const timer = setInterval(() => {
      refreshAdmission();
    }, 30_000);
    window.addEventListener("focus", refreshAdmission);
    document.addEventListener("visibilitychange", refreshAdmission);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshAdmission);
      document.removeEventListener("visibilitychange", refreshAdmission);
    };
  }, [loadAdmission]);

  const refreshRun = useCallback(async (runId: string) => {
    try {
      const run = await scienceApi.run(runId);
      setRunDetail(run);
      setRunPage((page) => ({
        ...page,
        items: page.items.map((item) => item.id === run.id ? run : item),
      }));
      setRunsError(null);
      return run;
    } catch (error) {
      setRunsError(scienceError(error));
      return null;
    }
  }, []);

  useEffect(() => {
    prefsApi.get().then(({ layout }) => {
      const science = layout.science;
      if (science) {
        setSelectedStudyId(science.studyId ?? null);
        setSelectedRunId(science.runId ?? null);
        setRailCollapsed(science.railCollapsed ?? false);
        setDossierCollapsed(science.dossierCollapsed ?? false);
        setFallbackMode(science.fallbackMode ?? "auto");
      }
    }).catch(() => {}).finally(() => {
      prefsReady.current = true;
      loadStudies(null);
      loadProfiles();
    });
  }, [loadProfiles, loadStudies]);

  useEffect(() => {
    if (!prefsReady.current) return;
    const layout: ScienceLayout = {
      ...(selectedStudyId ? { studyId: selectedStudyId } : {}),
      ...(selectedRunId ? { runId: selectedRunId } : {}),
      railCollapsed,
      dossierCollapsed,
      fallbackMode,
    };
    const timer = setTimeout(() => {
      prefsApi.save({ science: layout }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [selectedStudyId, selectedRunId, railCollapsed, dossierCollapsed, fallbackMode]);

  useEffect(() => {
    if (!selectedStudyId) {
      setStudyDetail(null);
      setArtifactPage(EMPTY_PAGE());
      setSelectedArtifactId(null);
      setSelectedArtifactDetail(null);
      setArtifactVersionPage(EMPTY_PAGE());
      setSelectedArtifactVersion(null);
      setRunPage(EMPTY_PAGE());
      return;
    }
    if (!studyPage.items.some((study) => study.id === selectedStudyId)) {
      scienceApi.study(selectedStudyId).then(setStudyDetail).catch(() => setStudyDetail(null));
    } else {
      setStudyDetail(null);
    }
    setArtifactCursor(null);
    setArtifactBack([]);
    setRunCursor(null);
    setRunBack([]);
    loadArtifacts(selectedStudyId, null);
    loadRuns(selectedStudyId, null);
  }, [selectedStudyId, studyPage.items, loadArtifacts, loadRuns]);

  useEffect(() => {
    if (!selectedArtifactId) {
      setSelectedArtifactDetail(null);
      setArtifactVersionPage(EMPTY_PAGE());
      setArtifactVersionCursor(null);
      setArtifactVersionBack([]);
      setSelectedArtifactVersion(null);
      setArtifactVersionsError(null);
      return;
    }
    setArtifactVersionCursor(null);
    setArtifactVersionBack([]);
    loadArtifactVersions(selectedArtifactId, null);
  }, [selectedArtifactId, loadArtifactVersions]);

  useEffect(() => {
    comparisonRequest.current++;
    setComparison(null);
    setComparisonError(null);
    setComparisonLoading(false);
    if (!selectedRunId) {
      setRunDetail(null);
      setManifest(null);
      setManifestError(null);
      return;
    }
    refreshRun(selectedRunId);
  }, [selectedRunId, refreshRun]);

  useEffect(() => {
    if (!selectedRunId) return;
    let dead = false;
    setManifestLoading(true);
    scienceApi.manifest(selectedRunId).then((next) => {
      if (dead) return;
      setManifest(next);
      setManifestError(null);
    }).catch((error) => {
      if (dead) return;
      if (error instanceof ApiError && error.status === 404 && selectedRun?.state !== "succeeded") {
        setManifest(null);
        setManifestError(null);
      } else {
        setManifest(null);
        setManifestError(scienceError(error));
      }
    }).finally(() => {
      if (!dead) setManifestLoading(false);
    });
    return () => {
      dead = true;
    };
  }, [selectedRunId, selectedRun?.state, selectedRun?.manifestHash]);

  useEffect(() => {
    if (!selectedRun || !SCIENCE_ACTIVE_RUN_STATES.has(selectedRun.state)) return;
    const timer = setInterval(() => {
      if (!document.hidden) refreshRun(selectedRun.id);
    }, 3_000);
    return () => clearInterval(timer);
  }, [selectedRun, refreshRun]);

  useEffect(() => {
    if (!latestScienceSignal || !selectedStudyId) return;
    loadArtifacts(selectedStudyId, artifactCursor);
    if (selectedArtifactId) {
      loadArtifactVersions(selectedArtifactId, artifactVersionCursor);
    }
    loadRuns(selectedStudyId, runCursor);
    if (selectedRunId) refreshRun(selectedRunId);
  }, [
    latestScienceSignal?.seq,
    selectedStudyId,
    selectedArtifactId,
    selectedRunId,
    artifactCursor,
    artifactVersionCursor,
    runCursor,
    loadArtifacts,
    loadArtifactVersions,
    loadRuns,
    refreshRun,
  ]);

  useEffect(() => {
    const wasConnected = previousConnected.current;
    previousConnected.current = props.connected;
    if (!props.connected) {
      setSyncState("disconnected");
      return;
    }
    if (!wasConnected) {
      setSyncState("resyncing");
      setNotice("Event bus restored. Re-reading authoritative Science state from REST.");
      Promise.all([
        loadStudies(studyCursor),
        loadProfiles(),
        loadAdmission(false),
        selectedStudyId ? loadArtifacts(selectedStudyId, artifactCursor) : Promise.resolve(),
        selectedArtifactId
          ? loadArtifactVersions(selectedArtifactId, artifactVersionCursor)
          : Promise.resolve(),
        selectedStudyId ? loadRuns(selectedStudyId, runCursor) : Promise.resolve(),
      ]).finally(() => setSyncState("live"));
    } else {
      setSyncState("live");
    }
  }, [
    props.connected,
    selectedStudyId,
    selectedArtifactId,
    studyCursor,
    artifactCursor,
    artifactVersionCursor,
    runCursor,
    loadStudies,
    loadProfiles,
    loadAdmission,
    loadArtifacts,
    loadArtifactVersions,
    loadRuns,
  ]);

  useEffect(() => {
    renderSessionRef.current = renderSession;
  }, [renderSession]);

  useEffect(() => {
    if (!renderSession || !["starting", "ready"].includes(renderSession.state)) return;
    const session = renderSession;
    let dead = false;
    const retire = (message: string) => {
      if (dead || renderSessionRef.current?.id !== session.id) return;
      renderSessionRef.current = null;
      setRenderSession(null);
      setFallbackMode("table");
      setNotice(message);
      scienceApi.closeRenderSession(session.id).catch(() => {});
    };
    if (admission?.admitted !== true) {
      retire("PILOT NOT ADMITTED; the short-lived renderer was closed without renewing.");
      return () => {
        dead = true;
      };
    }

    const refresh = async () => {
      const expiresAt = Date.parse(session.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        retire("Render session expired; switched to the structured fallback.");
        return;
      }
      if (document.hidden) return;
      try {
        const next = await scienceApi.renewRenderSession(session.id);
        if (dead || renderSessionRef.current?.id !== session.id) return;
        if (!["starting", "ready"].includes(next.state)) {
          retire(`Render session became ${next.state}; switched to the structured fallback.`);
          return;
        }
        setRenderSession(next);
      } catch (error) {
        retire(`Render renewal failed (${scienceError(error)}); switched to the structured fallback.`);
      }
    };
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      retire("Render session expired; switched to the structured fallback.");
      return () => {
        dead = true;
      };
    }
    const expiryTimer = setTimeout(
      () => retire("Render session expired; switched to the structured fallback."),
      Math.max(0, expiresAt - Date.now() + 50),
    );
    const refreshTimer = setInterval(refresh, session.state === "starting" ? 2_000 : 30_000);
    return () => {
      dead = true;
      clearTimeout(expiryTimer);
      clearInterval(refreshTimer);
    };
  }, [admission?.admitted, renderSession?.expiresAt, renderSession?.id, renderSession?.state]);

  useEffect(() => {
    const timer = setInterval(() => {
      setUtcClock(new Date().toISOString().slice(11, 19));
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => () => {
    const session = renderSessionRef.current;
    if (session) scienceApi.closeRenderSession(session.id).catch(() => {});
  }, []);

  const releaseRenderSession = () => {
    const session = renderSessionRef.current;
    renderSessionRef.current = null;
    setRenderSession(null);
    if (session) scienceApi.closeRenderSession(session.id).catch(() => {});
  };

  const selectStudy = (study: ScienceStudy) => {
    releaseRenderSession();
    setSelectedStudyId(study.id);
    setSelectedArtifactId(null);
    setSelectedArtifactDetail(null);
    setSelectedArtifactVersion(null);
    setSelectedRunId(null);
    setManifest(null);
    setRenderSession(null);
    setNotice(`Study selected: ${study.name}.`);
  };

  const selectRun = (run: ScienceRun) => {
    if (renderSessionRef.current?.runId && renderSessionRef.current.runId !== run.id) {
      releaseRenderSession();
    }
    setSelectedRunId(run.id);
    setRunDetail(run);
    if (run.missionId) props.onTrackMission(run.missionId);
    setNotice(`Run ${run.id.slice(0, 8)} selected.`);
  };

  const doAction = async (message: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setNotice(message);
    } catch (error) {
      setNotice(scienceError(error));
      if (error instanceof ApiError && error.status === 503) void loadAdmission(false);
    } finally {
      setBusy(false);
    }
  };

  const allowNewWork = () => {
    if (newWorkEnabled) return true;
    setNotice(
      admission?.admitted === false
        ? "PILOT NOT ADMITTED; new Science resources are disabled while reads and cleanup remain available."
        : props.canBuild
          ? "Pilot admission could not be confirmed; new Science resources remain disabled."
          : "This role may inspect Science resources but cannot create or update them.",
    );
    return false;
  };

  const createStudy = (name: string) => {
    if (!allowNewWork()) return;
    doAction(`Study created: ${name}.`, async () => {
      const study = await scienceApi.createStudy({ name, classification: "non_regulated" });
      setStudyPage((page) => ({ ...page, items: [study, ...page.items] }));
      selectStudy(study);
    });
  };

  const ingest = (input: { logicalName: string; kind: string; format: string; file: File }) => {
    if (!allowNewWork()) return;
    if (!selectedStudyId) return;
    doAction(`Artifact uploaded: ${input.logicalName}.`, async () => {
      setNotice(`Hashing ${fmtBytes(input.file.size)} locally with SHA-256 before upload.`);
      const sha256 = await sha256Blob(input.file);
      setNotice(`Checksum ${sha256.slice(0, 16)}… measured; creating immutable upload intent.`);
      const artifact = await scienceApi.createArtifact(selectedStudyId, {
        logicalName: input.logicalName,
        kind: input.kind,
        format: input.format,
      });
      const upload = await scienceApi.beginUpload(artifact.id, {
        filename: input.file.name,
        expectedSizeBytes: input.file.size,
        expectedSha256: sha256,
        mediaType: input.file.type || "application/octet-stream",
      });
      await scienceApi.putUpload(upload.uploadToken, input.file, upload.uploadUrl);
      const version = await scienceApi.completeUpload(upload.uploadToken, {
        mediaType: input.file.type || "application/octet-stream",
        metadata: { filename: input.file.name },
      });
      await loadArtifacts(selectedStudyId, artifactCursor);
      setSelectedArtifactId(artifact.id);
      setSelectedArtifactDetail({ ...artifact, latestVersion: version });
      setSelectedArtifactVersion(version);
    });
  };

  const uploadArtifactVersion = (input: {
    file: File;
    parentVersionId: string | null;
  }) => {
    if (!allowNewWork()) return;
    if (!selectedArtifact || !selectedStudyId) return;
    const artifact = selectedArtifact;
    doAction(`New immutable version uploaded to ${artifact.logicalName}.`, async () => {
      setNotice(`Hashing ${fmtBytes(input.file.size)} locally with SHA-256 before upload.`);
      const sha256 = await sha256Blob(input.file);
      setNotice(
        `Checksum ${sha256.slice(0, 16)}… measured; appending to the existing logical artifact.`,
      );
      const upload = await scienceApi.beginUpload(artifact.id, {
        filename: input.file.name,
        expectedSizeBytes: input.file.size,
        expectedSha256: sha256,
        mediaType: input.file.type || "application/octet-stream",
      });
      await scienceApi.putUpload(upload.uploadToken, input.file, upload.uploadUrl);
      const version = await scienceApi.completeUpload(upload.uploadToken, {
        mediaType: input.file.type || "application/octet-stream",
        metadata: { filename: input.file.name },
        parentVersionId: input.parentVersionId,
      });
      const updatedArtifact = { ...artifact, latestVersion: version };
      setSelectedArtifactDetail(updatedArtifact);
      setSelectedArtifactVersion(version);
      setArtifactPage((page) => ({
        ...page,
        items: page.items.map((item) =>
          item.id === artifact.id ? updatedArtifact : item),
      }));
      setArtifactVersionCursor(null);
      setArtifactVersionBack([]);
      await loadArtifactVersions(artifact.id, null);
    });
  };

  const expireArtifactVersion = (version: ScienceArtifactVersion) => {
    if (!selectedArtifact) return;
    const artifact = selectedArtifact;
    doAction(
      `Artifact v${version.version} bytes purged; immutable tombstone retained.`,
      async () => {
        if (
          renderSession?.artifactVersionId === version.id &&
          ["starting", "ready"].includes(renderSession.state)
        ) {
          throw new Error(
            "Close the active render session before purging this artifact version.",
          );
        }
        await scienceApi.expireArtifactVersion(version.id, version.sha256);
        setArtifactVersionCursor(null);
        setArtifactVersionBack([]);
        await Promise.all([
          loadArtifactVersions(artifact.id, null),
          loadArtifacts(artifact.studyId, artifactCursor),
        ]);
      },
    );
  };

  const submitRun = (input: ScienceRunInput) => {
    if (!allowNewWork()) return;
    if (!selectedStudyId) return;
    doAction("Run submitted; durable state is authoritative.", async () => {
      const run = await scienceApi.createRun(selectedStudyId, input);
      setRunPage((page) => ({ ...page, items: [run, ...page.items.filter((item) => item.id !== run.id)] }));
      selectRun(run);
    });
  };

  const cancelRun = () => {
    if (!selectedRun) return;
    doAction(`Cancellation requested for generation ${selectedRun.executionGeneration}.`, async () => {
      const run = await scienceApi.cancelRun(selectedRun.id, {
        generation: selectedRun.executionGeneration,
        reason: "Operator requested cancellation from Science Operations.",
      });
      setRunDetail(run);
      await loadRuns(run.studyId, runCursor);
    });
  };

  const reproduce = () => {
    if (!allowNewWork()) return;
    if (!selectedRun) return;
    doAction("Manifest re-run submitted as a new immutable run.", async () => {
      const run = await scienceApi.reproduce(selectedRun.id, {
        idempotencyKey: randomIdempotencyKey(),
      });
      setRunPage((page) => ({ ...page, items: [run, ...page.items.filter((item) => item.id !== run.id)] }));
      selectRun(run);
    });
  };

  const compareRun = async (candidateRunId: string) => {
    if (!selectedRun) return;
    const request = ++comparisonRequest.current;
    setComparisonLoading(true);
    setComparisonError(null);
    try {
      const result = await scienceApi.compareRuns(selectedRun.id, candidateRunId);
      if (request !== comparisonRequest.current) return;
      setComparison(result);
      setNotice(
        `Compared OP ${result.leftRunId.slice(0, 8)} with OP ${result.rightRunId.slice(0, 8)}; numerical equivalence is reported only when a tolerance validation exists.`,
      );
    } catch (error) {
      if (request !== comparisonRequest.current) return;
      setComparison(null);
      setComparisonError(scienceError(error));
    } finally {
      if (request === comparisonRequest.current) setComparisonLoading(false);
    }
  };

  const createComputeProfile = (input: ScienceComputeProfileInput) => {
    if (!allowNewWork()) return;
    doAction(`Compute profile created: ${input.name}.`, async () => {
      const profile = await scienceApi.createComputeProfile(input);
      setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
    });
  };

  const updateComputeProfile = (
    profileId: string,
    patch: Partial<ScienceComputeProfileInput>,
  ) => {
    if (!allowNewWork()) return;
    doAction("Compute profile updated.", async () => {
      const profile = await scienceApi.updateComputeProfile(profileId, patch);
      setProfiles((current) => current.map((item) => item.id === profile.id ? profile : item));
    });
  };

  const startRender = () => {
    if (!allowNewWork()) return;
    if (!selectedRun) return;
    doAction("Short-lived render session requested.", async () => {
      const session = await scienceApi.createRenderSession(selectedRun.id, {
        ...(inspectedArtifact?.latestVersion?.id
          ? { artifactVersionId: inspectedArtifact.latestVersion.id }
          : {}),
      });
      setRenderSession(session);
    });
  };

  const closeRender = () => {
    if (!renderSession) return;
    const session = renderSession;
    renderSessionRef.current = null;
    setRenderSession(null);
    doAction("Render session closed.", () => scienceApi.closeRenderSession(session.id));
  };


  const updateAdmission = (admitted: boolean) => {
    const reason = admissionReason.trim();
    if (
      !props.isAdmin ||
      !admission ||
      admissionBusy ||
      admissionMutationPending.current ||
      !reason
    ) return;
    const mutation = ++admissionMutationRequest.current;
    admissionMutationPending.current = true;
    admissionReadRequest.current++;
    setAdmissionBusy(true);
    setAdmissionError(null);
    scienceApi.updateWorkspaceAdmission({ admitted, reason }).then((next) => {
      if (mutation !== admissionMutationRequest.current) return;
      setAdmission(next);
      setAdmissionReason("");
      setNotice(
        next.admitted
          ? "Science pilot admitted; new resource-bearing work is enabled."
          : "PILOT NOT ADMITTED; new work is disabled and existing resources remain inspectable.",
      );
    }).catch((error) => {
      if (mutation !== admissionMutationRequest.current) return;
      const message = scienceError(error);
      setAdmissionError(message);
      setNotice(`Admission update failed: ${message}`);
    }).finally(() => {
      if (mutation !== admissionMutationRequest.current) return;
      admissionMutationPending.current = false;
      setAdmissionBusy(false);
      setAdmissionLoading(false);
      void loadAdmission(false);
    });
  };

  const queueAge = selectedRun?.queuedAt
    ? fmtElapsed(selectedRun.queuedAt, selectedRun.startedAt)
    : "N/A";
  const wallTime = selectedRun?.startedAt
    ? fmtElapsed(selectedRun.startedAt, selectedRun.finishedAt)
    : "N/A";
  const resource = selectedRun
    ? `${(selectedRun.resourceRequest.cpuMillicores / 1_000).toFixed(2)} CPU · `
      + `${selectedRun.resourceRequest.memoryMb} MiB · `
      + `${selectedRun.resourceRequest.gpuCount} GPU · `
      + `${selectedRun.resourceRequest.wallTimeSeconds}s`
    : "N/A";
  const manifestReadout = selectedRun
    ? manifest ? manifest.complete ? "COMPLETE" : "INCOMPLETE" : "N/A"
    : "N/A";

  const moveStudyPage = (direction: -1 | 1) => {
    if (direction > 0 && studyPage.nextCursor) {
      setStudyBack((back) => [...back, studyCursor]);
      setStudyCursor(studyPage.nextCursor);
      loadStudies(studyPage.nextCursor);
    } else if (direction < 0 && studyBack.length > 0) {
      const cursor = studyBack[studyBack.length - 1] ?? null;
      setStudyBack((back) => back.slice(0, -1));
      setStudyCursor(cursor);
      loadStudies(cursor);
    }
  };
  const moveArtifactPage = (direction: -1 | 1) => {
    if (!selectedStudyId) return;
    if (direction > 0 && artifactPage.nextCursor) {
      setArtifactBack((back) => [...back, artifactCursor]);
      setArtifactCursor(artifactPage.nextCursor);
      loadArtifacts(selectedStudyId, artifactPage.nextCursor);
    } else if (direction < 0 && artifactBack.length > 0) {
      const cursor = artifactBack[artifactBack.length - 1] ?? null;
      setArtifactBack((back) => back.slice(0, -1));
      setArtifactCursor(cursor);
      loadArtifacts(selectedStudyId, cursor);
    }
  };
  const moveArtifactVersionPage = (direction: -1 | 1) => {
    if (!selectedArtifactId) return;
    if (direction > 0 && artifactVersionPage.nextCursor) {
      setArtifactVersionBack((back) => [...back, artifactVersionCursor]);
      setArtifactVersionCursor(artifactVersionPage.nextCursor);
      loadArtifactVersions(selectedArtifactId, artifactVersionPage.nextCursor);
    } else if (direction < 0 && artifactVersionBack.length > 0) {
      const cursor = artifactVersionBack[artifactVersionBack.length - 1] ?? null;
      setArtifactVersionBack((back) => back.slice(0, -1));
      setArtifactVersionCursor(cursor);
      loadArtifactVersions(selectedArtifactId, cursor);
    }
  };
  const moveRunPage = (direction: -1 | 1) => {
    if (!selectedStudyId) return;
    if (direction > 0 && runPage.nextCursor) {
      setRunBack((back) => [...back, runCursor]);
      setRunCursor(runPage.nextCursor);
      loadRuns(selectedStudyId, runPage.nextCursor);
    } else if (direction < 0 && runBack.length > 0) {
      const cursor = runBack[runBack.length - 1] ?? null;
      setRunBack((back) => back.slice(0, -1));
      setRunCursor(cursor);
      loadRuns(selectedStudyId, cursor);
    }
  };

  return (
    <div className={`science-ops ${reducedMotion ? "reduced-motion" : ""}`}>
      <div className={`sci-connection state-${syncState}`} role="status">
        <span>{syncState === "live" ? "BUS LIVE" : syncState === "resyncing" ? "REST RESYNC" : "BUS DISCONNECTED"}</span>
        <span>
          {syncState === "disconnected"
            ? "Live events are paused. Displayed records may be stale; writes still rely on REST responses."
            : syncState === "resyncing"
              ? "Re-reading studies, artifacts, profiles, and runs from authoritative REST state."
              : "Events accelerate the display; persisted REST state remains authoritative."}
        </span>
      </div>
      <section
        className={`sci-admission state-${admissionState}`}
        aria-labelledby="science-admission-title"
      >
        <div className="sci-admission-readout" role="status" aria-live="polite">
          <strong id="science-admission-title">
            {admissionState === "admitted"
              ? "PILOT ADMITTED"
              : admissionState === "blocked"
                ? "PILOT NOT ADMITTED"
                : admissionState === "checking"
                  ? "PILOT ADMISSION CHECK"
                  : "PILOT ADMISSION UNKNOWN"}
          </strong>
          <span>
            {admissionState === "admitted"
              ? "New Science work may be requested; server policy remains authoritative."
              : admissionState === "blocked"
                ? "New resource-bearing work is disabled. Existing records and cleanup controls remain available."
                : admissionState === "checking"
                  ? "Reading persisted workspace admission from the Science service."
                  : "Admission could not be confirmed. New Science work remains disabled."}
          </span>
          <time dateTime={admission?.updatedAt ?? undefined}>
            {admission?.updatedAt
              ? `UPDATED ${admission.updatedAt.replace("T", " ").replace("Z", " UTC")}`
              : "NO RECORDED CHANGE"}
          </time>
        </div>
        {props.isAdmin && (
          <div className="sci-admission-control">
            <label className="sci-field">
              <span>ADMINISTRATIVE REASON / {admissionReason.trim().length}/1000</span>
              <textarea
                rows={2}
                maxLength={1000}
                value={admissionReason}
                disabled={admissionBusy || !admission}
                onChange={(event) => setAdmissionReason(event.target.value)}
                aria-describedby="science-admission-help"
                placeholder="Required audit reason for this workspace admission change"
              />
            </label>
            <div className="sci-admission-ceremony">
              <HoldButton
                key={admission ? String(admission.admitted) : "unknown"}
                tiny
                tone={admission?.admitted ? "danger" : "accent"}
                disabled={admissionBusy || !admission || !admissionReason.trim()}
                onComplete={() => {
                  if (admission) updateAdmission(!admission.admitted);
                }}
                title={admission?.admitted
                  ? "Hold to revoke this workspace pilot admission"
                  : "Hold to admit this workspace to the Science pilot"}
              >
                {admissionBusy
                  ? "UPDATING ADMISSION"
                  : `HOLD TO ${admission?.admitted ? "DISABLE" : "ENABLE"} PILOT`}
              </HoldButton>
              <span id="science-admission-help">
                Reason is required and audited. Revocation blocks new work; reads, cancellation,
                renderer close, accepted-upload completion, and checksum purge stay available.
              </span>
            </div>
          </div>
        )}
      </section>
      {admissionError && (
        <p className="sci-error sci-admission-error" role="alert">
          ADMISSION STATUS / {admissionError}
        </p>
      )}

      <div className="sci-operation-state" role="status" aria-live="polite">
        <span>OP LOG //</span>
        <span>{notice}</span>
      </div>

      <div className="sci-stat-row">
        <Panel><Stat label="STUDY / RUN" value={selectedStudy ? selectedRun ? `${selectedStudy.name} / ${selectedRun.id.slice(0, 8)}` : selectedStudy.name : "N/A"} /></Panel>
        <Panel><Stat label="QUEUE AGE" value={queueAge} /></Panel>
        <Panel><Stat label="WALL TIME" value={wallTime} /></Panel>
        <Panel><Stat label="RESOURCE REQUEST" value={resource} /></Panel>
        <Panel><Stat label="MANIFEST" value={manifestReadout} tone={manifest?.complete ? "ok" : selectedRun && manifest ? "warn" : "default"} /></Panel>
      </div>

      <div className={`sci-workspace ${railCollapsed ? "rail-collapsed" : ""} ${dossierCollapsed ? "dossier-collapsed" : ""}`}>
        {!railCollapsed && (
          <ScienceRail
            studies={studyPage.items}
            studiesLoading={studiesLoading}
            studiesError={studiesError}
            selectedStudyId={selectedStudyId}
            onSelectStudy={selectStudy}
            studyPage={{
              hasPrevious: studyBack.length > 0,
              hasNext: !!studyPage.nextCursor,
              onPrevious: () => moveStudyPage(-1),
              onNext: () => moveStudyPage(1),
            }}
            artifacts={artifactPage.items}
            artifactsLoading={artifactsLoading}
            artifactsError={artifactsError}
            selectedArtifactId={selectedArtifactId}
            onSelectArtifact={(artifact) => {
              releaseRenderSession();
              setSelectedArtifactId(artifact.id);
              setSelectedArtifactDetail(artifact);
              setNotice(`Artifact selected: ${artifact.logicalName}, latest immutable version.`);
            }}
            artifactPage={{
              hasPrevious: artifactBack.length > 0,
              hasNext: !!artifactPage.nextCursor,
              onPrevious: () => moveArtifactPage(-1),
              onNext: () => moveArtifactPage(1),
            }}
            canBuild={props.canBuild}
            newWorkEnabled={newWorkEnabled}
            busy={busy}
            onCreateStudy={createStudy}
            onIngest={ingest}
          />
        )}

        <main className="sci-center">
          <div className="sci-center-controls">
            <Chip tiny onClick={() => setRailCollapsed((value) => !value)}>
              {railCollapsed ? "SHOW STUDIES" : "HIDE STUDIES"}
            </Chip>
            <span>ANALYSIS SURFACE · OPAQUE PIXEL ISOLATION</span>
            <Chip tiny onClick={() => setDossierCollapsed((value) => !value)}>
              {dossierCollapsed ? "SHOW DOSSIER" : "HIDE DOSSIER"}
            </Chip>
          </div>
          <ScienceViewport
            artifact={inspectedArtifact}
            run={selectedRun}
            session={renderSession}
            mode={fallbackMode}
            onModeChange={setFallbackMode}
            canBuild={props.canBuild}
            newWorkEnabled={newWorkEnabled}
            busy={busy}
            onStartSession={startRender}
            onCloseSession={closeRender}
          />
          <ArtifactVersionControl
            artifact={selectedArtifact}
            versions={artifactVersionPage.items}
            selectedVersion={selectedArtifactVersion}
            loading={artifactVersionsLoading}
            error={artifactVersionsError}
            hasPreviousPage={artifactVersionBack.length > 0}
            hasNextPage={!!artifactVersionPage.nextCursor}
            isAdmin={props.isAdmin}
            busy={busy}
            canBuild={props.canBuild}
            newWorkEnabled={newWorkEnabled}
            onSelectVersion={(version) => {
              releaseRenderSession();
              setSelectedArtifactVersion(version);
              setNotice(
                `Artifact ${selectedArtifact?.logicalName ?? ""} version ${version.version} selected.`,
              );
            }}
            onPreviousPage={() => moveArtifactVersionPage(-1)}
            onExpireVersion={expireArtifactVersion}
            onNextPage={() => moveArtifactVersionPage(1)}
            onUploadVersion={uploadArtifactVersion}
          />
          {props.isAdmin && (
            <details className="sci-admin-profiles">
              <summary>COMPUTE PROFILE CONTROL · ADMIN</summary>
              <ComputeProfileManager
                profiles={profiles}
                loading={profilesLoading}
                error={profilesError}
                busy={busy}
                newWorkEnabled={newWorkEnabled}
                onCreate={createComputeProfile}
                onUpdate={updateComputeProfile}
              />
            </details>
          )}
        </main>

        {!dossierCollapsed && (
          <RunDossier
            runs={runPage.items}
            runsLoading={runsLoading}
            runsError={runsError}
            selectedRun={selectedRun}
            selectedRunId={selectedRunId}
            onSelectRun={selectRun}
            hasPreviousPage={runBack.length > 0}
            hasNextPage={!!runPage.nextCursor}
            onPreviousPage={() => moveRunPage(-1)}
            onNextPage={() => moveRunPage(1)}
            canBuild={props.canBuild}
            busy={busy}
            onRefresh={() => {
              if (selectedStudyId) loadRuns(selectedStudyId, runCursor);
              if (selectedRunId) refreshRun(selectedRunId);
            }}
            onCancel={cancelRun}
            configurator={
              <RunConfigurator
                study={selectedStudy}
                artifacts={artifactPage.items}
                inspectedArtifact={selectedArtifact}
                artifactVersions={artifactVersionPage.items}
                profiles={profiles}
                profilesLoading={profilesLoading}
                profilesError={profilesError}
                canBuild={props.canBuild}
                newWorkEnabled={newWorkEnabled}
                busy={busy}
                onSubmit={submitRun}
              />
            }
            manifestInspector={
              <ManifestInspector
                manifest={manifest}
                manifestHash={selectedRun?.manifestHash ?? null}
                loading={manifestLoading}
                error={manifestError}
                canBuild={props.canBuild}
                newWorkEnabled={newWorkEnabled}
                busy={busy}
                comparisonCandidates={runPage.items.filter(
                  (run) =>
                    run.id !== selectedRun?.id &&
                    run.state === "succeeded" &&
                    Boolean(run.manifestHash),
                )}
                comparison={comparison}
                comparisonLoading={comparisonLoading}
                comparisonError={comparisonError}
                onCompare={compareRun}
                onReproduce={reproduce}
              />
            }
          />
        )}
      </div>

      <PipelineStrip artifacts={artifactPage.items} run={selectedRun} manifest={manifest} />
      <footer className="sci-live-rail" aria-label="Science Operations status">
        <span>SCI //</span>
        <span>{latestScienceSignal ? `${latestScienceSignal.type} · ${latestScienceSignal.label}` : "NO SCIENCE EVENT TRAFFIC · REST STATE LOADED"}</span>
        <span>{props.connected ? "LINK ONLINE" : "LINK OFFLINE"}</span>
        <time dateTime={new Date().toISOString()}>{utcClock} UTC</time>
      </footer>
    </div>
  );
}
