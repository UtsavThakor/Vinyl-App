import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

const LRCLIB_BASE = 'https://lrclib.net/api';
const LYRICS_STORAGE_PREFIX = 'vinyl_lyrics:';

export type LyricsStatus = 'idle' | 'loading' | 'found' | 'instrumental' | 'notfound' | 'error';

export type LyricsResult = {
  status: LyricsStatus;
  plainLyrics: string | null;
  trackId: string | null;
};

type CachedLyrics = {
  status: 'found' | 'instrumental' | 'notfound';
  plainLyrics: string | null;
};

type UseLyricsOptions = {
  trackId: string | null;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  enabled: boolean;
};

function getLyricsStorageKey(trackId: string) {
  return `${LYRICS_STORAGE_PREFIX}${trackId}`;
}

async function loadCachedLyrics(trackId: string): Promise<CachedLyrics | null> {
  try {
    const raw = await AsyncStorage.getItem(getLyricsStorageKey(trackId));

    if (!raw) return null;

    return JSON.parse(raw) as CachedLyrics;
  } catch {
    return null;
  }
}

async function saveCachedLyrics(trackId: string, value: CachedLyrics) {
  try {
    await AsyncStorage.setItem(getLyricsStorageKey(trackId), JSON.stringify(value));
  } catch {
    // Caching is best-effort and should never break the insert.
  }
}

async function fetchFromLrclib(
  title: string,
  artist: string,
  album: string,
  durationMs: number,
  signal: AbortSignal
): Promise<CachedLyrics> {
  const durationSec = Math.round(durationMs / 1000);

  // 1. Exact get with duration — most accurate match for this pressing.
  const getParams = new URLSearchParams({
    track_name: title,
    artist_name: artist,
  });

  if (album) getParams.set('album_name', album);
  if (durationSec > 0) getParams.set('duration', String(durationSec));

  try {
    const res = await fetch(`${LRCLIB_BASE}/get?${getParams.toString()}`, {
      signal,
      headers: { Accept: 'application/json' },
    });

    if (res.status === 200) {
      const data = await res.json();

      if (data?.instrumental) {
        return { status: 'instrumental', plainLyrics: null };
      }

      if (typeof data?.plainLyrics === 'string' && data.plainLyrics.trim()) {
        return { status: 'found', plainLyrics: data.plainLyrics };
      }
    }
  } catch (e) {
    if ((e as any)?.name === 'AbortError') throw e;
    // fall through to the search fallback
  }

  // 2. Fallback: looser search by track + artist, take first usable hit.
  const searchParams = new URLSearchParams({
    track_name: title,
    artist_name: artist,
  });

  try {
    const res = await fetch(`${LRCLIB_BASE}/search?${searchParams.toString()}`, {
      signal,
      headers: { Accept: 'application/json' },
    });

    if (res.status === 200) {
      const results = await res.json();

      if (Array.isArray(results)) {
        const withLyrics = results.find(
          (r) => typeof r?.plainLyrics === 'string' && r.plainLyrics.trim()
        );

        if (withLyrics) {
          return { status: 'found', plainLyrics: withLyrics.plainLyrics };
        }

        if (results.some((r) => r?.instrumental)) {
          return { status: 'instrumental', plainLyrics: null };
        }
      }
    }
  } catch (e) {
    if ((e as any)?.name === 'AbortError') throw e;
  }

  return { status: 'notfound', plainLyrics: null };
}

export function useLyrics({
  trackId,
  title,
  artist,
  album,
  durationMs,
  enabled,
}: UseLyricsOptions): LyricsResult {
  const [result, setResult] = useState<LyricsResult>({
    status: 'idle',
    plainLyrics: null,
    trackId: null,
  });

  const requestedTrackIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!trackId) return;

    // Need both fields to query LRCLIB meaningfully.
    if (!title || !artist) {
      setResult({ status: 'notfound', plainLyrics: null, trackId });
      return;
    }

    // Already resolved this track — keep what we have, no refetch.
    if (requestedTrackIdRef.current === trackId) return;

    requestedTrackIdRef.current = trackId;

    const controller = new AbortController();
    let cancelled = false;

    async function run() {
      setResult({ status: 'loading', plainLyrics: null, trackId });

      const cached = await loadCachedLyrics(trackId);

      if (cancelled) return;

      if (cached) {
        setResult({ status: cached.status, plainLyrics: cached.plainLyrics, trackId });
        return;
      }

      try {
        const fetched = await fetchFromLrclib(title, artist, album, durationMs, controller.signal);

        if (cancelled) return;

        setResult({ status: fetched.status, plainLyrics: fetched.plainLyrics, trackId });
        void saveCachedLyrics(trackId, fetched);
      } catch (e) {
        if (cancelled) return;
        if ((e as any)?.name === 'AbortError') return;

        setResult({ status: 'error', plainLyrics: null, trackId });
      }
    }

    void run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, trackId, title, artist, album, durationMs]);

  return result;
}