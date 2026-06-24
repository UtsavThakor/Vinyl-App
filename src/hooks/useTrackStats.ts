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

async function loadTrackStats(trackId: string): Promise<TrackStats | null> {
  try {
    const raw = await AsyncStorage.getItem(getStatsStorageKey(trackId));

    if (!raw) return null;

    return JSON.parse(raw) as TrackStats;
  } catch {
    return null;
  }
}

async function saveTrackStats(stats: TrackStats) {
  try {
    await AsyncStorage.setItem(getStatsStorageKey(stats.trackId), JSON.stringify(stats));
  } catch {
    // Stats should never break playback.
  }
}

function isRealLoopRestart(previousProgressMs: number, currentProgressMs: number, durationMs: number) {
  if (durationMs <= 0) return false;

  const nearEndMs = durationMs * 0.82;
  const nearBeginningMs = 8000;

  return previousProgressMs >= nearEndMs && currentProgressMs <= nearBeginningMs;
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

  const activeTrackIdRef = useRef<string | null>(null);
  const previousProgressMsRef = useRef(0);
  const lastTickAtRef = useRef<number | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveSoon = useCallback((nextStats: TrackStats) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      void saveTrackStats(nextStats);
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function setupTrack() {
      if (!trackId) {
        activeTrackIdRef.current = null;
        setCurrentStats(null);
        previousProgressMsRef.current = 0;
        lastTickAtRef.current = null;
        return;
      }

      if (activeTrackIdRef.current === trackId) return;

      activeTrackIdRef.current = trackId;
      previousProgressMsRef.current = progressMs;
      lastTickAtRef.current = Date.now();

      const existing = await loadTrackStats(trackId);

      if (cancelled) return;

      const now = Date.now();

      const nextStats: TrackStats = existing
        ? {
            ...existing,
            lastPlayedAt: now,
            playCount: existing.playCount + 1,
          }
        : createInitialStats(trackId);

      setCurrentStats(nextStats);
      saveSoon(nextStats);
    }

    void setupTrack();

    return () => {
      cancelled = true;
    };
  }, [trackId, progressMs, saveSoon]);

  useEffect(() => {
    if (!trackId || !currentStats) return;

    const now = Date.now();
    const previousTickAt = lastTickAtRef.current;
    const previousProgressMs = previousProgressMsRef.current;

    lastTickAtRef.current = now;
    previousProgressMsRef.current = progressMs;

    if (!previousTickAt) return;
    if (!isPlaying) return;
    if (isScrubbing) return;
    if (activeTrackIdRef.current !== trackId) return;

    const elapsedMs = Math.max(0, now - previousTickAt);
    const safeElapsedMs = Math.min(elapsedMs, 2000);

    const didLoop = isLooping && isRealLoopRestart(previousProgressMs, progressMs, durationMs);

    const nextStats: TrackStats = {
      ...currentStats,
      lastPlayedAt: now,
      totalMs: currentStats.totalMs + safeElapsedMs,
      loopCount: currentStats.loopCount + (didLoop ? 1 : 0),
    };

    setCurrentStats(nextStats);
    saveSoon(nextStats);
  }, [trackId, currentStats, isPlaying, isScrubbing, isLooping, progressMs, durationMs, saveSoon]);

  return {
    currentStats,
  };
}