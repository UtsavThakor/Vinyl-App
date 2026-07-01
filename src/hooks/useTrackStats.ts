import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

const TRACK_STATS_STORAGE_PREFIX = 'vinyl_track_stats:';

export type TrackStats = {
  trackId: string;
  firstPlayedAt: number;
  lastPlayedAt: number;
  playCount: number;
  totalMs: number;
  loopCount: number;
};

type UseTrackStatsOptions = {
  trackId: string | null;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  isLooping: boolean;
  isScrubbing: boolean;
};

function getStatsStorageKey(trackId: string) {
  return `${TRACK_STATS_STORAGE_PREFIX}${trackId}`;
}

function canUseLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function createInitialStats(trackId: string): TrackStats {
  const now = Date.now();

  return {
    trackId,
    firstPlayedAt: now,
    lastPlayedAt: now,
    playCount: 1,
    totalMs: 0,
    loopCount: 0,
  };
}

function normalizeStats(value: unknown, trackId: string): TrackStats | null {
  if (!value || typeof value !== 'object') return null;

  const maybeStats = value as Partial<TrackStats>;

  if (maybeStats.trackId !== trackId) return null;

  const firstPlayedAt = Number(maybeStats.firstPlayedAt);
  const lastPlayedAt = Number(maybeStats.lastPlayedAt);
  const playCount = Number(maybeStats.playCount);
  const totalMs = Number(maybeStats.totalMs);
  const loopCount = Number(maybeStats.loopCount);

  if (!Number.isFinite(firstPlayedAt) || firstPlayedAt <= 0) return null;

  return {
    trackId,
    firstPlayedAt,
    lastPlayedAt: Number.isFinite(lastPlayedAt) && lastPlayedAt > 0 ? lastPlayedAt : firstPlayedAt,
    playCount: Number.isFinite(playCount) && playCount > 0 ? playCount : 1,
    totalMs: Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : 0,
    loopCount: Number.isFinite(loopCount) && loopCount >= 0 ? loopCount : 0,
  };
}

async function loadTrackStats(trackId: string): Promise<TrackStats | null> {
  const key = getStatsStorageKey(trackId);

  try {
    const raw = await AsyncStorage.getItem(key);

    if (raw) {
      const parsed = JSON.parse(raw);
      const normalized = normalizeStats(parsed, trackId);

      if (normalized) return normalized;
    }
  } catch {
    // Fall back to localStorage below.
  }

  try {
    if (!canUseLocalStorage()) return null;

    const raw = window.localStorage.getItem(key);

    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const normalized = normalizeStats(parsed, trackId);

    if (normalized) {
      try {
        await AsyncStorage.setItem(key, JSON.stringify(normalized));
      } catch {
        // Sync-back is nice-to-have.
      }

      return normalized;
    }
  } catch {
    return null;
  }

  return null;
}

async function saveTrackStats(stats: TrackStats) {
  const key = getStatsStorageKey(stats.trackId);
  const serialized = JSON.stringify(stats);

  try {
    await AsyncStorage.setItem(key, serialized);
  } catch {
    // Keep trying localStorage below.
  }

  try {
    if (canUseLocalStorage()) {
      window.localStorage.setItem(key, serialized);
    }
  } catch {
    // Stats should never break playback.
  }
}

function isRealLoopRestart(previousProgressMs: number, currentProgressMs: number, durationMs: number) {
  if (durationMs <= 0) return false;

  const nearEndMs = durationMs * 0.82;
  const nearBeginningMs = 8000;
  const jumpedBackEnough = previousProgressMs - currentProgressMs > 30000;

  return previousProgressMs >= nearEndMs && currentProgressMs <= nearBeginningMs && jumpedBackEnough;
}

export function formatNeedleTime(totalMs: number) {
  const totalSeconds = Math.floor(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export function formatShortDate(timestamp: number) {
  if (!timestamp) return '—';

  const date = new Date(timestamp);

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function useTrackStats({
  trackId,
  isPlaying,
  progressMs,
  durationMs,
  isLooping,
  isScrubbing,
}: UseTrackStatsOptions) {
  const [currentStats, setCurrentStats] = useState<TrackStats | null>(null);

  const statsRef = useRef<TrackStats | null>(null);
  const activeTrackIdRef = useRef<string | null>(null);
  const previousProgressMsRef = useRef(0);
  const lastSnapshotAtRef = useRef<number | null>(null);
  const lastLoopCountedAtRef = useRef(0);

  const commitStats = useCallback((nextStats: TrackStats) => {
    statsRef.current = nextStats;
    setCurrentStats(nextStats);
    void saveTrackStats(nextStats);
  }, []);

  useEffect(() => {
    return () => {
      if (statsRef.current) {
        void saveTrackStats(statsRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function setupTrack() {
      if (!trackId) {
        activeTrackIdRef.current = null;
        statsRef.current = null;
        setCurrentStats(null);
        previousProgressMsRef.current = 0;
        lastSnapshotAtRef.current = null;
        lastLoopCountedAtRef.current = 0;
        return;
      }

      if (activeTrackIdRef.current === trackId) return;

      activeTrackIdRef.current = trackId;
      previousProgressMsRef.current = progressMs;
      lastSnapshotAtRef.current = Date.now();
      lastLoopCountedAtRef.current = 0;

      const existingStats = await loadTrackStats(trackId);

      if (cancelled || activeTrackIdRef.current !== trackId) return;

      const now = Date.now();

      const nextStats: TrackStats = existingStats
        ? {
            ...existingStats,
            lastPlayedAt: now,
            playCount: existingStats.playCount + 1,
          }
        : createInitialStats(trackId);

      commitStats(nextStats);
    }

    void setupTrack();

    return () => {
      cancelled = true;
    };
  }, [trackId, commitStats]);

  useEffect(() => {
    if (!trackId) return;
    if (activeTrackIdRef.current !== trackId) return;
    if (!statsRef.current) return;

    const now = Date.now();
    const previousSnapshotAt = lastSnapshotAtRef.current;
    const previousProgressMs = previousProgressMsRef.current;

    lastSnapshotAtRef.current = now;
    previousProgressMsRef.current = progressMs;

    if (!previousSnapshotAt) return;
    if (!isPlaying) return;
    if (isScrubbing) return;

    const elapsedMs = Math.max(0, now - previousSnapshotAt);
    const safeElapsedMs = Math.min(elapsedMs, 2500);

    if (safeElapsedMs <= 0) return;

    const didLoop =
      isLooping &&
      now - lastLoopCountedAtRef.current > 12000 &&
      isRealLoopRestart(previousProgressMs, progressMs, durationMs);

    if (didLoop) {
      lastLoopCountedAtRef.current = now;
    }

    const current = statsRef.current;

    const nextStats: TrackStats = {
      ...current,
      lastPlayedAt: now,
      totalMs: current.totalMs + safeElapsedMs,
      loopCount: current.loopCount + (didLoop ? 1 : 0),
    };

    commitStats(nextStats);
  }, [trackId, isPlaying, isScrubbing, isLooping, progressMs, durationMs, commitStats]);

  return {
    currentStats,
  };
}