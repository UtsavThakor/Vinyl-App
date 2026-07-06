import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthRequest } from 'expo-auth-session';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ColorValue,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Defs, Path, Svg, Text as SvgText, TextPath } from 'react-native-svg';
import { useLyrics } from '../hooks/useLyrics';
import { formatNeedleTime, formatShortDate, useTrackStats } from '../hooks/useTrackStats';
import { useVinylSfx } from '../hooks/useVinylSfx';
import { CLIENT_ID, DISCOVERY, REDIRECT_URI, SCOPES } from '../spotify';

WebBrowser.maybeCompleteAuthSession();

const PEEK_HEIGHT = 72;
const FALLBACK_ART = 'https://picsum.photos/400/400';
const LOCKED_Y = 0;
const ARM_WIDTH = 14;
const ARM_REST_DEG = 4;
const ARM_PLAY_DEG = 17;

const SOFT_EASING = Easing.bezier(0.16, 1, 0.3, 1);

const RIM_ACCENT_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#007aff'] as const;

const SLEEVE_PEEK_COLORS = [
  '#b54848',
  '#327a83',
  '#3d7355',
  '#9b7d37',
  '#6c518f',
  '#b45f91',
  '#4169a3',
  '#bd7143',
] as const;

const COVER_FLOW_ACCENTS = [
  '#f4d56f',
  '#fff0b8',
  '#f0b46f',
  '#c2a3ff',
  '#8fd9ee',
  '#9fe5b2',
  '#f2a7a7',
  '#ffe08a',
] as const;

type GradientColors = readonly [ColorValue, ColorValue, ColorValue];

type SpotifyAuth = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

type SpotifyTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type PlayerStatsSnapshot = {
  trackId: string | null;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  isLooping: boolean;
  isScrubbing: boolean;
};

type SpotifyPlaylist = {
  id: string;
  name: string;
  imageUrl: string | null;
  trackCount: number | null;
};

type SpotifyTrack = {
  id: string;
  title: string;
  artist: string;
  albumArt: string | null;
  uri: string;
};

type TrackPageResult = {
  tracks: SpotifyTrack[];
  nextUrl: string | null;
  error: string | null;
  emptyMessage: string | null;
};

const FALLBACK_GRADIENT: GradientColors = ['#1a1a2e', '#16161f', '#0a0a0f'];
const TOKEN_STORAGE_KEY = 'spotify_auth';
const LEGACY_TOKEN_STORAGE_KEY = 'spotify_token';
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

function getHashIndex(id: string, length: number) {
  let hash = 0;

  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  }

  return Math.abs(hash) % length;
}

function getCoverFlowAccent(id: string) {
  return COVER_FLOW_ACCENTS[getHashIndex(id, COVER_FLOW_ACCENTS.length)];
}

function getLayout(width: number, height: number) {
  const isLandscape = width > height;
  const shortSide = Math.min(width, height);
  const discSize = isLandscape ? shortSide * 0.641 : width * 0.641;
  const albumSize = isLandscape ? discSize * 0.504 : width * 0.266;
  const coverSize = discSize * 1;

  const discCenterX = isLandscape ? width * 0.68 : width * 0.66;
  const discCenterY = isLandscape ? height * 0.52 : height * 0.47;
  const discLeft = discCenterX - discSize / 2;
  const discTop = discCenterY - discSize / 2;

  const albumLeft = isLandscape ? width * 0.17 : width * 0.15;
  const albumTop = isLandscape ? height * 0.36 : height * 0.33;

  const coverLeft = discCenterX - coverSize / 2;
  const coverTop = discCenterY - coverSize / 2;
  const hiddenY = -(coverTop + coverSize - PEEK_HEIGHT);

  const armPivotX = width - (isLandscape ? 96 : 78);
  const armPivotY = isLandscape ? height * 0.15 : height * 0.11;
  const armLength = Math.hypot(discCenterX - armPivotX, discCenterY - armPivotY) * 0.74;

  return {
    albumLeft,
    albumSize,
    albumTop,
    armLength,
    armPivotX,
    armPivotY,
    coverLeft,
    coverSize,
    coverTop,
    discLeft,
    discSize,
    discTop,
    hiddenY,
    isLandscape,
    screenHeight: height,
    screenWidth: width,
  };
}

type PlayerLayout = ReturnType<typeof getLayout>;

function getExpiresAt(expiresIn = 3600) {
  return Date.now() + expiresIn * 1000;
}

function getRandomRimAccentColor() {
  const index = Math.floor(Math.random() * RIM_ACCENT_COLORS.length);
  return RIM_ACCENT_COLORS[index];
}

async function extractColors(imageUrl: string): Promise<GradientColors> {
  if (typeof document === 'undefined') return FALLBACK_GRADIENT;

  return new Promise((resolve) => {
    try {
      const img = new (window as any).Image();
      img.crossOrigin = 'Anonymous';

      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const w = (canvas.width = 50);
          const h = (canvas.height = 50);
          const ctx = canvas.getContext('2d');

          if (!ctx) return resolve(FALLBACK_GRADIENT);

          ctx.drawImage(img, 0, 0, w, h);

          const data = ctx.getImageData(0, 0, w, h).data;
          let r = 0;
          let g = 0;
          let b = 0;
          let count = 0;

          for (let i = 0; i < data.length; i += 4) {
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
          }

          r = Math.round(r / count);
          g = Math.round(g / count);
          b = Math.round(b / count);

          resolve([
            `rgb(${r},${g},${b})`,
            `rgb(${Math.round(r * 0.4)},${Math.round(g * 0.4)},${Math.round(b * 0.4)})`,
            `rgb(${Math.round(r * 0.15)},${Math.round(g * 0.15)},${Math.round(b * 0.15)})`,
          ]);
        } catch {
          resolve(FALLBACK_GRADIENT);
        }
      };

      img.onerror = () => resolve(FALLBACK_GRADIENT);
      img.src = imageUrl;
    } catch {
      resolve(FALLBACK_GRADIENT);
    }
  });
}

function RimText({ size, text }: { size: number; text: string }) {
  const r = size * 0.455;
  const cx = size / 2;
  const cy = size / 2;
  const d = `M ${cx - r}, ${cy} a ${r},${r} 0 1,1 ${2 * r},0 a ${r},${r} 0 1,1 ${-2 * r},0`;

  return (
    <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <Path id="rim" d={d} fill="none" />
      </Defs>

      <SvgText fill="#d4af37" fontSize={17} fontWeight="600" letterSpacing={5}>
        <TextPath href="#rim" startOffset="2%">
          {text}
        </TextPath>
      </SvgText>
    </Svg>
  );
}

const AnimatedGradient = Animated.createAnimatedComponent(LinearGradient);

export default function VinylPlayer() {
  const { width, height } = useWindowDimensions();
  const layout = getLayout(width, height);
  const faderHeight = layout.isLandscape ? 120 : 110;
  const styles = getStyles(layout);

  const { playManualRecordChange } = useVinylSfx();

  const [auth, setAuth] = useState<SpotifyAuth | null>(null);
  const [albumArt, setAlbumArt] = useState<string>(FALLBACK_ART);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trackInfo, setTrackInfo] = useState({ title: '', album: '', artist: '' });
  const [rimAccentColor, setRimAccentColor] = useState<ColorValue>(getRandomRimAccentColor());
  const [isInsertOpen, setIsInsertOpen] = useState(false);

  const [playerStatsSnapshot, setPlayerStatsSnapshot] = useState<PlayerStatsSnapshot>({
    trackId: null,
    isPlaying: false,
    progressMs: 0,
    durationMs: 0,
    isLooping: false,
    isScrubbing: false,
  });

  const [isCrateOpen, setIsCrateOpen] = useState(false);
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [openedBox, setOpenedBox] = useState<{
    type: 'playlist' | 'liked';
    id: string;
    tracks: SpotifyTrack[];
    nextUrl: string | null;
    error: string | null;
    emptyMessage: string | null;
  } | null>(null);

  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [isLoadingMoreTracks, setIsLoadingMoreTracks] = useState(false);
  const [selectedTrackIndex, setSelectedTrackIndex] = useState(0);

  const crateTranslateX = useSharedValue(0);
  const drawerKnobScale = useSharedValue(1);

  const [bottomGrad, setBottomGrad] = useState<GradientColors>(FALLBACK_GRADIENT);
  const [topGrad, setTopGrad] = useState<GradientColors>(FALLBACK_GRADIENT);

  const [volumePercent, setVolumePercent] = useState(50);

  const faderPosition = useSharedValue(50);
  const lastVolumeUpdate = useRef(0);

  const gradFade = useSharedValue(1);
  const insertProgress = useSharedValue(0);
  const token = auth?.accessToken ?? null;

  const { currentStats } = useTrackStats(playerStatsSnapshot);

  const lyrics = useLyrics({
    trackId: playerStatsSnapshot.trackId,
    title: trackInfo.title,
    artist: trackInfo.artist,
    album: trackInfo.album,
    durationMs: playerStatsSnapshot.durationMs,
    enabled: isInsertOpen,
  });

  const currentTrackIdRef = useRef<string | null>(null);
  const durationSv = useSharedValue(0);
  const progressSv = useSharedValue(0);
  const isPlayingSv = useSharedValue(false);
  const isScrubbingSv = useSharedValue(false);
  const scrubActive = useSharedValue(false);
  const scrubScale = useSharedValue(1);
  const scrubBaseRotation = useSharedValue(0);
  const scrubStartProgress = useSharedValue(0);
  const scrubAccumulated = useSharedValue(0);
  const scrubPrevAngle = useSharedValue(0);
  const scrubTarget = useSharedValue(0);

  const rotation = useSharedValue(0);
  const coverY = useSharedValue(layout.hiddenY);
  const armAngle = useSharedValue(ARM_REST_DEG);

  const lastSeekRef = useRef(0);
  const suppressPollUntilRef = useRef(0);
  const suppressRepeatSyncUntilRef = useRef(0);
  const isLooping = useRef(false);
  const lastSwipeLeft = useRef<number | null>(null);

  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: CLIENT_ID,
      scopes: SCOPES,
      usePKCE: true,
      redirectUri: REDIRECT_URI,
    },
    DISCOVERY
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const html = document.documentElement;
    const body = document.body;

    html.style.backgroundColor = '#050509';
    html.style.margin = '0';
    html.style.padding = '0';
    html.style.height = '100%';
    html.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'none';

    body.style.backgroundColor = '#050509';
    body.style.margin = '0';
    body.style.padding = '0';
    body.style.height = '100%';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    body.style.touchAction = 'none';

    let viewport = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;

    if (!viewport) {
      viewport = document.createElement('meta');
      viewport.name = 'viewport';
      document.head.appendChild(viewport);
    }

    viewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  }, []);

  const saveAuth = useCallback(async (nextAuth: SpotifyAuth) => {
    setAuth(nextAuth);
    await AsyncStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(nextAuth));
    await AsyncStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
  }, []);

  const clearAuth = useCallback(async () => {
    setAuth(null);
    await AsyncStorage.multiRemove([TOKEN_STORAGE_KEY, LEGACY_TOKEN_STORAGE_KEY]);
  }, []);

  const refreshAccessToken = useCallback(
    async (refreshToken = auth?.refreshToken) => {
      if (!refreshToken) {
        await clearAuth();
        return null;
      }

      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }).toString();

        const res = await fetch(DISCOVERY.tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });

        const data = (await res.json()) as SpotifyTokenResponse;

        if (!res.ok || !data.access_token) {
          console.log('Refresh error:', data);
          await clearAuth();
          return null;
        }

        const nextAuth: SpotifyAuth = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token || refreshToken,
          expiresAt: getExpiresAt(data.expires_in),
        };

        await saveAuth(nextAuth);
        return nextAuth.accessToken;
      } catch (e) {
        console.log('Refresh error:', e);
        return null;
      }
    },
    [auth?.refreshToken, clearAuth, saveAuth]
  );

  const getValidAccessToken = useCallback(async () => {
    if (!auth) return null;

    if (auth.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return auth.accessToken;
    }

    return refreshAccessToken(auth.refreshToken);
  }, [auth, refreshAccessToken]);

  const exchangeCodeForToken = useCallback(
    async (code: string, verifier: string) => {
      try {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }).toString();

        const res = await fetch(DISCOVERY.tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });

        const data = (await res.json()) as SpotifyTokenResponse;

        if (data.access_token) {
          await saveAuth({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: getExpiresAt(data.expires_in),
          });
        } else {
          console.log('Token error:', data);
        }
      } catch (e) {
        console.log('Exchange error:', e);
      }
    },
    [saveAuth]
  );

  useEffect(() => {
    let mounted = true;

    async function loadAuth() {
      const saved = await AsyncStorage.getItem(TOKEN_STORAGE_KEY);

      if (saved) {
        try {
          const parsed = JSON.parse(saved) as SpotifyAuth;

          if (mounted && parsed.accessToken && parsed.expiresAt) {
            setAuth(parsed);
          }

          return;
        } catch {
          await AsyncStorage.removeItem(TOKEN_STORAGE_KEY);
        }
      }

      const legacyToken = await AsyncStorage.getItem(LEGACY_TOKEN_STORAGE_KEY);

      if (mounted && legacyToken) {
        setAuth({
          accessToken: legacyToken,
          expiresAt: getExpiresAt(),
        });
      }
    }

    loadAuth();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (response?.type === 'success' && response.params.code && request?.codeVerifier) {
      exchangeCodeForToken(response.params.code, request.codeVerifier);
    }
  }, [exchangeCodeForToken, request?.codeVerifier, response]);

  const fetchNowPlaying = useCallback(async () => {
    const accessToken = await getValidAccessToken();

    if (!accessToken) return;

    try {
      const res = await fetch('https://api.spotify.com/v1/me/player', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 200) {
        const data = await res.json();

        if (typeof data?.device?.volume_percent === 'number') {
          setVolumePercent(data.device.volume_percent);
          faderPosition.value = data.device.volume_percent;
        }

        durationSv.value = data?.item?.duration_ms || 0;

        if (!isScrubbingSv.value && Date.now() > suppressPollUntilRef.current) {
          if (typeof data?.progress_ms === 'number') {
            progressSv.value = data.progress_ms;
          }
        }

        const art = data?.item?.album?.images?.[0]?.url;
        const nextTrackId = data?.item?.id || null;
        const nextIsPlaying = !!data?.is_playing;
        const nextProgressMs = typeof data?.progress_ms === 'number' ? data.progress_ms : 0;
        const nextDurationMs = data?.item?.duration_ms || 0;

        if (art) setAlbumArt(art);

        if (nextTrackId && currentTrackIdRef.current !== nextTrackId) {
          currentTrackIdRef.current = nextTrackId;
          setRimAccentColor(getRandomRimAccentColor());
        }

        setIsPlaying(nextIsPlaying);

        if (Date.now() > suppressRepeatSyncUntilRef.current) {
          const spotifyRepeat = data?.repeat_state === 'track';

          if (spotifyRepeat !== isLooping.current) {
            isLooping.current = spotifyRepeat;

            coverY.value = withTiming(spotifyRepeat ? LOCKED_Y : layout.hiddenY, {
              duration: 500,
              easing: SOFT_EASING,
            });
          }
        }

        setPlayerStatsSnapshot({
          trackId: nextTrackId,
          isPlaying: nextIsPlaying,
          progressMs: nextProgressMs,
          durationMs: nextDurationMs,
          isLooping: isLooping.current,
          isScrubbing: isScrubbingSv.value,
        });

        setTrackInfo({
          title: data?.item?.name || '',
          album: data?.item?.album?.name || '',
          artist: data?.item?.artists?.[0]?.name || '',
        });
      } else if (res.status === 204) {
        setIsPlaying(false);

        setPlayerStatsSnapshot((prev) => ({
          ...prev,
          isPlaying: false,
          isScrubbing: false,
        }));
      } else if (res.status === 401) {
        await clearAuth();
      }
    } catch (e) {
      console.log('Now playing error:', e);
    }
  }, [clearAuth, getValidAccessToken, layout.hiddenY]);

  useEffect(() => {
    if (!token) return;

    fetchNowPlaying();

    const interval = setInterval(fetchNowPlaying, 1000);

    return () => clearInterval(interval);
  }, [token, fetchNowPlaying]);

  const fetchPlaylistTrackCount = useCallback(
    async (playlistId: string, accessToken: string) => {
      try {
        const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=tracks(total)`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (res.status === 200) {
          const data = await res.json();
          const total = Number(data?.tracks?.total);

          return Number.isFinite(total) ? total : null;
        }
      } catch {
        // Count is nice-to-have.
      }

      return null;
    },
    []
  );

  const fetchPlaylists = useCallback(async () => {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return;

    try {
      let url: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50';
      const collected: any[] = [];

      while (url) {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!res.ok) break;

        const data = await res.json();
        collected.push(...(data.items || []));
        url = data.next || null;
      }

      const items: SpotifyPlaylist[] = await Promise.all(
        collected.map(async (playlist: any) => {
          const rawTotal = Number(playlist?.tracks?.total);
          const fallbackTotal = playlist?.id ? await fetchPlaylistTrackCount(playlist.id, accessToken) : null;
          const trackCount = Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : fallbackTotal;

          return {
            id: playlist.id,
            name: playlist.name,
            imageUrl: playlist.images?.[0]?.url || null,
            trackCount,
          };
        })
      );

      setPlaylists(items);
    } catch (e) {
      console.log('Playlists error:', e);
    }
  }, [fetchPlaylistTrackCount, getValidAccessToken]);

  const getSpotifyTrackFromRow = useCallback((row: any) => {
    const spotifyItem = row?.item || row?.track;

    if (!spotifyItem?.uri) return null;
    if (spotifyItem.type && spotifyItem.type !== 'track') return null;

    return spotifyItem;
  }, []);

  const mapSpotifyTracks = useCallback(
    (items: any[]) => {
      return (items || [])
        .map((row: any, index: number) => {
          const spotifyTrack = getSpotifyTrackFromRow(row);

          if (!spotifyTrack) return null;

          return {
            id: `${spotifyTrack.id || spotifyTrack.uri}-${index}`,
            title: spotifyTrack.name || 'Unknown Track',
            artist: spotifyTrack.artists?.[0]?.name || '',
            albumArt: spotifyTrack.album?.images?.[0]?.url || null,
            uri: spotifyTrack.uri,
          } as SpotifyTrack;
        })
        .filter(Boolean) as SpotifyTrack[];
    },
    [getSpotifyTrackFromRow]
  );

  const getEmptyTrackPageMessage = useCallback((items: any[], label: string) => {
    const rawCount = items?.length || 0;
    if (rawCount === 0) return null;

    const first = items[0];
    const spotifyTrack = getSpotifyTrackFromRow(first);
    const legacyTrack = first?.track;
    const currentItem = first?.item;
    const itemKeys = first ? Object.keys(first).slice(0, 8).join(', ') : 'none';
    const itemShape = currentItem ? 'item' : legacyTrack ? 'track' : 'missing';

    console.log('Unmapped Spotify page:', {
      label,
      rawCount,
      itemShape,
      itemKeys,
      currentItemType: currentItem?.type,
      legacyTrackType: legacyTrack?.type,
      hasNormalizedTrack: Boolean(spotifyTrack),
    });

    return `${label} did not include playable Spotify tracks.`;
  }, [getSpotifyTrackFromRow]);

  const formatSpotifyError = useCallback(async (res: Response, label: string) => {
    const errorText = await res.text();

    if (!errorText) {
      return `${label} failed with ${res.status} ${res.statusText || 'Spotify error'}.`;
    }

    try {
      const parsed = JSON.parse(errorText);
      const message = parsed?.error?.message || parsed?.error_description || parsed?.message || errorText;

      return `${label} failed with ${res.status}: ${message}`;
    } catch {
      return `${label} failed with ${res.status}: ${errorText}`;
    }
  }, []);

  const fetchTrackPage = useCallback(
    async (url: string, label = 'Track page'): Promise<TrackPageResult> => {
      const accessToken = await getValidAccessToken();

      if (!accessToken) {
        return { tracks: [], nextUrl: null, error: 'Spotify session expired. Sign in again.', emptyMessage: null };
      }

      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!res.ok) {
          const error = await formatSpotifyError(res, label);
          console.log('Track page fetch failed:', error);

          return { tracks: [], nextUrl: null, error, emptyMessage: null };
        }

        const data = await res.json();
        const rawItems = data.items || [];
        const tracks = mapSpotifyTracks(rawItems);

        return {
          tracks,
          nextUrl: data.next || null,
          error: null,
          emptyMessage: tracks.length === 0 ? getEmptyTrackPageMessage(rawItems, label) : null,
        };
      } catch (e) {
        console.log('Track page error:', e);

        return {
          tracks: [],
          nextUrl: null,
          error: e instanceof Error ? `${label} failed: ${e.message}` : `${label} failed with an unknown error.`,
          emptyMessage: null,
        };
      }
    },
    [formatSpotifyError, getEmptyTrackPageMessage, getValidAccessToken, mapSpotifyTracks]
  );

  const fetchPlaylistTrackPage = useCallback(
    async (playlistId: string, nextUrl?: string | null) => {
      const url =
        nextUrl ||
        `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50&market=from_token&additional_types=track`;

      const page = await fetchTrackPage(url, 'Playlist records');

      setPlaylists((previous) =>
        previous.map((playlist) =>
          playlist.id === playlistId && page.tracks.length > 0
            ? { ...playlist, trackCount: playlist.trackCount === null ? page.tracks.length : playlist.trackCount }
            : playlist
        )
      );

      return page;
    },
    [fetchTrackPage]
  );

  const fetchLikedTrackPage = useCallback(
    async (nextUrl?: string | null) => {
      const url = nextUrl || 'https://api.spotify.com/v1/me/tracks?limit=50&market=from_token';

      return fetchTrackPage(url, 'Liked records');
    },
    [fetchTrackPage]
  );

  const playTrack = useCallback(
    async (uri: string) => {
      const accessToken = await getValidAccessToken();
      if (!accessToken) return;

      try {
        await fetch('https://api.spotify.com/v1/me/player/play', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ uris: [uri] }),
        });

        setTimeout(fetchNowPlaying, 300);
      } catch (e) {
        console.log('Play track error:', e);
      }
    },
    [getValidAccessToken, fetchNowPlaying]
  );

  useEffect(() => {
    let active = true;

    extractColors(albumArt).then((cols) => {
      if (!active) return;

      setTopGrad(cols);

      gradFade.value = 0;
      gradFade.value = withTiming(1, { duration: 1000 }, (finished) => {
        if (finished) {
          runOnJS(setBottomGrad)(cols);
        }
      });
    });

    return () => {
      active = false;
    };
  }, [albumArt]);

  const topGradStyle = useAnimatedStyle(() => ({
    opacity: gradFade.value,
  }));

  const insertBackdropStyle = useAnimatedStyle(() => ({
    opacity: insertProgress.value,
  }));

  const insertBookStyle = useAnimatedStyle(() => ({
    opacity: insertProgress.value,
    transform: [{ translateY: (1 - insertProgress.value) * 18 }, { scale: 0.92 + insertProgress.value * 0.08 }],
  }));

  const openInsert = useCallback(() => {
    setIsInsertOpen(true);

    insertProgress.value = withTiming(1, {
      duration: 360,
      easing: SOFT_EASING,
    });
  }, [insertProgress]);

  const closeInsert = useCallback(() => {
    insertProgress.value = withTiming(
      0,
      {
        duration: 260,
        easing: SOFT_EASING,
      },
      (finished) => {
        if (finished) {
          runOnJS(setIsInsertOpen)(false);
        }
      }
    );
  }, [insertProgress]);

  const openCrate = useCallback(() => {
    setIsCrateOpen(true);
    fetchPlaylists();

    crateTranslateX.value = withTiming(layout.screenWidth, {
      duration: 420,
      easing: SOFT_EASING,
    });

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      // Ignore haptic failures.
    }
  }, [fetchPlaylists, crateTranslateX, layout.screenWidth]);

  const closeCrate = useCallback(() => {
    setOpenedBox(null);
    setSelectedTrackIndex(0);

    crateTranslateX.value = withTiming(
      0,
      {
        duration: 380,
        easing: SOFT_EASING,
      },
      (finished) => {
        if (finished) runOnJS(setIsCrateOpen)(false);
      }
    );
  }, [crateTranslateX]);

  const openBox = useCallback(
    async (type: 'playlist' | 'liked', id: string) => {
      setIsLoadingTracks(true);
      setSelectedTrackIndex(0);

      const firstPage = type === 'liked' ? await fetchLikedTrackPage() : await fetchPlaylistTrackPage(id);

      setOpenedBox({
        type,
        id,
        tracks: firstPage.tracks,
        nextUrl: firstPage.nextUrl,
        error: firstPage.error,
        emptyMessage: firstPage.emptyMessage,
      });

      setIsLoadingTracks(false);
    },
    [fetchLikedTrackPage, fetchPlaylistTrackPage]
  );

  const loadMoreOpenedBoxTracks = useCallback(async () => {
    if (!openedBox?.nextUrl || isLoadingMoreTracks) return;

    setIsLoadingMoreTracks(true);

    const nextPage =
      openedBox.type === 'liked'
        ? await fetchLikedTrackPage(openedBox.nextUrl)
        : await fetchPlaylistTrackPage(openedBox.id, openedBox.nextUrl);

    setOpenedBox((current) => {
      if (!current) return current;

      const existingIds = new Set(current.tracks.map((track) => track.id));
      const freshTracks = nextPage.tracks.filter((track) => !existingIds.has(track.id));

      return {
        ...current,
        tracks: [...current.tracks, ...freshTracks],
        nextUrl: nextPage.nextUrl,
        error: nextPage.error,
        emptyMessage: nextPage.emptyMessage,
      };
    });

    setIsLoadingMoreTracks(false);
  }, [fetchLikedTrackPage, fetchPlaylistTrackPage, isLoadingMoreTracks, openedBox]);

  useEffect(() => {
    if (!openedBox?.nextUrl) return;
    if (openedBox.tracks.length === 0) return;

    const shouldPreloadMore = selectedTrackIndex >= openedBox.tracks.length - 12;

    if (shouldPreloadMore) {
      loadMoreOpenedBoxTracks();
    }
  }, [loadMoreOpenedBoxTracks, openedBox, selectedTrackIndex]);

  const preventContextMenu = useCallback((event: any) => {
    event.preventDefault();
  }, []);

  const sendCommand = useCallback(
    async (method: 'POST' | 'PUT', endpoint: string) => {
      const accessToken = await getValidAccessToken();

      if (!accessToken) return;

      try {
        await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
          method,
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        setTimeout(fetchNowPlaying, 200);
      } catch (e) {
        console.log('Command error:', e);
      }
    },
    [fetchNowPlaying, getValidAccessToken]
  );

  const sendVolume = useCallback(
    async (volume: number) => {
      const accessToken = await getValidAccessToken();

      if (!accessToken) return;

      const clamped = Math.max(0, Math.min(100, Math.round(volume)));

      try {
        await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${clamped}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
      } catch (e) {
        console.log(`Volume error:`, e);
      }
    },
    [getValidAccessToken]
  );

  const updateVolumeLive = useCallback (
    (volume: number) => {
      const now = Date.now();

      if (now - lastVolumeUpdate.current < 250) return;

      lastVolumeUpdate.current = now;

      sendVolume(volume);
    },
    [sendVolume]
  );

  const handleManualNext = useCallback(async () => {
    await playManualRecordChange();
    await sendCommand('POST', 'next');
  }, [playManualRecordChange, sendCommand]);

  const handleManualPrevious = useCallback(async () => {
    await playManualRecordChange();
    await sendCommand('POST', 'previous');
  }, [playManualRecordChange, sendCommand]);

  const handleTogglePlay = useCallback(async () => {
    const accessToken = await getValidAccessToken();

    if (!accessToken) return;

    try {
      await fetch(`https://api.spotify.com/v1/me/player/${isPlaying ? 'pause' : 'play'}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      setTimeout(fetchNowPlaying, 200);
    } catch (e) {
      console.log('Toggle error:', e);
    }
  }, [isPlaying, getValidAccessToken, fetchNowPlaying]);

  const sendSeekRaw = useCallback(
    async (positionMs: number, isFinal = false) => {
      const accessToken = await getValidAccessToken();

      if (!accessToken) return;

      try {
        await fetch(
          `https://api.spotify.com/v1/me/player/seek?position_ms=${Math.max(0, Math.round(positionMs))}`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );

        if (isFinal) {
          setTimeout(fetchNowPlaying, 350);
        }
      } catch (e) {
        console.log('Seek error:', e);
      }
    },
    [getValidAccessToken, fetchNowPlaying]
  );

  const scrubSeekThrottled = useCallback(
    (positionMs: number) => {
      const now = Date.now();

      if (now - lastSeekRef.current < 250) return;

      lastSeekRef.current = now;
      sendSeekRaw(positionMs, false);
    },
    [sendSeekRaw]
  );

  const finalizeScrub = useCallback(
    (positionMs: number) => {
      suppressPollUntilRef.current = Date.now() + 900;
      sendSeekRaw(positionMs, true);
    },
    [sendSeekRaw]
  );

  const onScrubEngage = useCallback(() => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // Ignore haptic failures.
    }
  }, []);

  useEffect(() => {
    if (!isLooping.current) {
      coverY.value = layout.hiddenY;
    }
  }, [layout.hiddenY]);

  useEffect(() => {
    isPlayingSv.value = isPlaying;

    if (isScrubbingSv.value) return;

    if (isPlaying) {
      rotation.value = withRepeat(
        withTiming(rotation.value + 1, {
          duration: 12000,
          easing: Easing.linear,
        }),
        -1,
        false
      );

      armAngle.value = withTiming(ARM_PLAY_DEG, {
        duration: 900,
        easing: SOFT_EASING,
      });
    } else {
      cancelAnimation(rotation);

      armAngle.value = withTiming(ARM_REST_DEG, {
        duration: 900,
        easing: SOFT_EASING,
      });
    }
  }, [isPlaying]);

  const discAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 360}deg` }, { scale: scrubScale.value }],
  }));

  const coverAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: coverY.value }],
  }));

  const armAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${armAngle.value}deg` }],
  }));

  const crateSlideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: crateTranslateX.value }],
  }));

  const drawerKnobAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: drawerKnobScale.value }],
  }));

  const faderCapStyle = useAnimatedStyle(() => {
    const travel = faderHeight - 36;

    const top = 
      18 + 
      ((100 - faderPosition.value) / 100) * travel;

    return {
      top,
    };
  });

  const discCx = layout.discLeft + layout.discSize / 2;
  const discCy = layout.discTop + layout.discSize / 2;

  const scrubGesture = Gesture.Pan()
    .activateAfterLongPress(100)
    .onStart((e) => {
      if (durationSv.value <= 0) {
        scrubActive.value = false;
        return;
      }

      scrubActive.value = true;
      isScrubbingSv.value = true;
      cancelAnimation(rotation);

      scrubBaseRotation.value = rotation.value;
      scrubStartProgress.value = progressSv.value;
      scrubAccumulated.value = 0;

      const a = Math.atan2(e.absoluteY - discCy, e.absoluteX - discCx);
      scrubPrevAngle.value = a;

      scrubTarget.value = progressSv.value;
      scrubScale.value = withTiming(1.04, { duration: 180 });

      runOnJS(onScrubEngage)();
    })
    .onUpdate((e) => {
      if (!scrubActive.value) return;

      const raw = Math.atan2(e.absoluteY - discCy, e.absoluteX - discCx);
      let delta = raw - scrubPrevAngle.value;

      if (delta > Math.PI) {
        delta -= 2 * Math.PI;
      } else if (delta < -Math.PI) {
        delta += 2 * Math.PI;
      }

      scrubAccumulated.value += delta;
      scrubPrevAngle.value = raw;

      rotation.value = scrubBaseRotation.value + scrubAccumulated.value / (2 * Math.PI);

      const frac = scrubAccumulated.value / Math.PI;
      let target = scrubStartProgress.value + frac * durationSv.value;

      if (target < 0) target = 0;
      if (target > durationSv.value) target = durationSv.value;

      scrubTarget.value = target;

      runOnJS(scrubSeekThrottled)(target);
    })
    .onFinalize(() => {
      if (!scrubActive.value) return;

      scrubActive.value = false;
      isScrubbingSv.value = false;
      scrubScale.value = withTiming(1, { duration: 100 });
      progressSv.value = scrubTarget.value;

      runOnJS(finalizeScrub)(scrubTarget.value);

      if (isPlayingSv.value) {
        rotation.value = withRepeat(
          withTiming(rotation.value + 1, {
            duration: 12000,
            easing: Easing.linear,
          }),
          -1,
          false
        );
      }
    });

  const swipeGesture = Gesture.Pan().onEnd((e) => {
    if (e.translationX > 60) {
      runOnJS(handleManualNext)();
    } else if (e.translationX < -60) {
      const now = Date.now();

      if (lastSwipeLeft.current && now - lastSwipeLeft.current < 1500) {
        runOnJS(handleManualPrevious)();
        lastSwipeLeft.current = null;
      } else {
        runOnJS(sendCommand)('PUT', 'seek?position_ms=0');
        lastSwipeLeft.current = now;
      }
    }
  });

  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(handleTogglePlay)();
  });

  const discGesture = Gesture.Exclusive(scrubGesture, swipeGesture, tapGesture);

  const volumeGesture = Gesture.Pan()
    .onUpdate((e) => {
      const travel = faderHeight - 36;

      let y = e.y;

      y = Math.max(18, Math.min(travel + 18, y));

      const percent = Math.round(100 - ((y - 18) / travel) * 100);
      
      faderPosition.value = percent;
      runOnJS(setVolumePercent)(percent);
      runOnJS(updateVolumeLive)(percent);
    })
    .onEnd(() => {
      runOnJS(sendVolume)(faderPosition.value);
    });

  const markRepeatSuppression = () => {
    suppressRepeatSyncUntilRef.current = Date.now() + 2500;
  };

  const coverGesture = Gesture.Pan().onEnd((e) => {
    if (e.translationY > 40 && !isLooping.current) {
      isLooping.current = true;

      coverY.value = withTiming(LOCKED_Y, {
        duration: 700,
        easing: SOFT_EASING,
      });

      runOnJS(markRepeatSuppression)();
      runOnJS(sendCommand)('PUT', 'repeat?state=track');
    } else if (e.translationY < -40 && isLooping.current) {
      isLooping.current = false;

      coverY.value = withTiming(layout.hiddenY, {
        duration: 700,
        easing: SOFT_EASING,
      });

      runOnJS(markRepeatSuppression)();
      runOnJS(sendCommand)('PUT', 'repeat?state=off');
    }
  });

  const drawerKnobGesture = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationX > 0) {
        drawerKnobScale.value = 1 + Math.min(e.translationX / 200, 0.3);
      }
    })
    .onEnd((e) => {
      drawerKnobScale.value = withTiming(1, { duration: 200 });

      if (e.translationX > 40) {
        runOnJS(openCrate)();
      }
    });

  const rimString =
    trackInfo.title || trackInfo.artist
      ? `${trackInfo.title}  ✺  ${trackInfo.album}  ✺  ${trackInfo.artist}`
      : '';

  const openedBoxTitle =
    openedBox?.type === 'liked' ? 'Liked Vinyls' : playlists.find((playlist) => playlist.id === openedBox?.id)?.name || '';

  const selectedTrack =
    openedBox && openedBox.tracks.length > 0
      ? openedBox.tracks[Math.min(selectedTrackIndex, openedBox.tracks.length - 1)]
      : null;

  const previousTrack =
    openedBox && openedBox.tracks.length > 1
      ? openedBox.tracks[(selectedTrackIndex - 1 + openedBox.tracks.length) % openedBox.tracks.length]
      : null;

  const nextTrack =
    openedBox && openedBox.tracks.length > 1 ? openedBox.tracks[(selectedTrackIndex + 1) % openedBox.tracks.length] : null;

  const selectedAccent = selectedTrack ? getCoverFlowAccent(selectedTrack.id) : '#f4d56f';

  if (!token) {
    return (
      <View style={styles.loginContainer}>
        <Text style={styles.loginTitle}>Vinyl</Text>

        <Pressable style={styles.loginButton} disabled={!request} onPress={() => promptAsync()}>
          <Text style={styles.loginButtonText}>Connect Spotify</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.container}>
        <LinearGradient colors={bottomGrad} style={StyleSheet.absoluteFill} />
        <AnimatedGradient colors={topGrad} style={[StyleSheet.absoluteFill, topGradStyle]} />

        <View style={styles.hardwareLayer} pointerEvents="box-none">
          <LinearGradient
            colors={['rgba(118,121,124,0.96)', 'rgba(44,47,50,0.98)', 'rgba(22,24,27,0.99)']}
            start={{ x: 0.1, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={styles.turntableChassis}
          >
            <View style={styles.chassisTopHighlight} />
            <View style={styles.chassisInnerLip} />
            <View style={styles.chassisContactShadow} />
          </LinearGradient>

          <View style={styles.albumRecess}>
            <View style={styles.albumRecessFloor} />
            <View style={styles.albumRecessHighlight} />
          </View>

          <View style={styles.platterRecess}>
            <View style={styles.platterInnerShadow} />
            <View style={styles.platterMetalRing} />
            <View style={styles.platterCenterDimple} />
          </View>

          <GestureDetector gesture={volumeGesture}>
            <View style={styles.faderAssembly}>
              <Text style={styles.faderLabel}>VOLUME</Text>
              <View style={styles.faderSlot}>
                {[...Array(9)].map((_, index) => (
                  <View
                    key={index}
                    style={[
                      styles.faderTick,
                      {
                        top: 9 + index * (layout.isLandscape ? 12 : 11),
                        width: index % 2 === 0 ? 14 : 8,
                      },
                    ]}
                  />
                ))}
                <View style={styles.faderRail} />

                <Animated.View style={[styles.faderCap, faderCapStyle]}>
                  <LinearGradient
                    colors={['#d8d9d6', '#8c8f8f', '#3f4245']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={{
                      width: '100%',
                      height: '100%',
                      borderRadius: 5,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <View style={styles.faderCapGroove} />
                  </LinearGradient>
                </Animated.View>
              </View>
            </View>
          </GestureDetector>

          <View style={styles.shuffleAssembly}>
            <View style={styles.togglePlate}>
              <View style={styles.toggleSlot}>
                <LinearGradient
                  colors={['#e7e4d8', '#9c9a93', '#4f5151']}
                  start={{ x: 0.2, y: 0 }}
                  end={{ x: 0.85, y: 1 }}
                  style={styles.toggleLever}
                />
              </View>
            </View>
            <Text style={styles.shuffleLabel}>SHUFFLE</Text>
          </View>
        </View>

        <Pressable
          style={styles.albumWrapper}
          delayLongPress={420}
          onLongPress={openInsert}
          onContextMenu={preventContextMenu as any}
        >
          <Image
            source={{ uri: albumArt }}
            style={[styles.albumArt, styles.noImageCallout as any]}
            pointerEvents="none"
            draggable={false as any}
          />

          <View style={styles.sleeveHint} pointerEvents="none">
            <Text style={styles.sleeveHintText}>hold sleeve</Text>
          </View>
        </Pressable>

        {isInsertOpen ? (
          <Animated.View style={[styles.insertOverlay, insertBackdropStyle]}>
            <Pressable style={styles.insertBackdrop} onPress={closeInsert} />

            <Animated.View style={[styles.insertBook, insertBookStyle]}>
              <View style={styles.insertSpine} />

              <View style={[styles.insertPage, styles.insertLeftPage]}>
                <ScrollView showsVerticalScrollIndicator={false}>
                  <Text style={styles.insertStamp}>VINYL INSERT</Text>

                  <Text style={styles.insertPageTitle}>Lyric Sheet</Text>

                  <Text style={styles.insertTrackTitle}>{trackInfo.title || 'Unknown Track'}</Text>

                  <Text style={styles.insertSubTitle}>
                    {trackInfo.artist || 'Unknown Artist'} · {trackInfo.album || 'Unknown Album'}
                  </Text>

                  <View style={styles.insertRule} />

                  {lyrics.status === 'loading' ? (
                    <Text style={styles.lyricMuted}>Reading the grooves…</Text>
                  ) : lyrics.status === 'found' && lyrics.plainLyrics ? (
                    <Text style={styles.lyricText}>{lyrics.plainLyrics}</Text>
                  ) : lyrics.status === 'instrumental' ? (
                    <Text style={styles.lyricMuted}>This pressing is instrumental — no lyric sheet.</Text>
                  ) : (
                    <Text style={styles.lyricMuted}>No lyric sheet found for this pressing.</Text>
                  )}

                  <View style={styles.noteBox}>
                    <Text style={styles.noteBoxLabel}>LINER NOTE</Text>
                    <Text style={styles.noteBoxText}>
                      This record has been played on your turntable. Stats are printed on the right page.
                    </Text>
                  </View>
                </ScrollView>
              </View>

              <View style={[styles.insertPage, styles.insertRightPage]}>
                <ScrollView showsVerticalScrollIndicator={false}>
                  <Text style={styles.insertStamp}>PRESSING NOTES</Text>

                  <Text style={styles.insertPageTitle}>Turntable Stats</Text>

                  <Text style={styles.insertTrackTitle}>{trackInfo.title || 'Unknown Track'}</Text>

                  <Text style={styles.insertSubTitle}>
                    {trackInfo.artist || 'Unknown Artist'} · {trackInfo.album || 'Unknown Album'}
                  </Text>

                  <View style={styles.insertRule} />

                  <View style={styles.bigStatBlock}>
                    <Text style={styles.bigStatValue}>{currentStats ? currentStats.playCount : '—'}</Text>
                    <Text style={styles.bigStatLabel}>Times on turntable</Text>
                  </View>

                  <View style={styles.statsGrid}>
                    <View style={styles.statCell}>
                      <Text style={styles.statCellLabel}>First spun</Text>
                      <Text style={styles.statCellValue}>
                        {currentStats ? formatShortDate(currentStats.firstPlayedAt) : '—'}
                      </Text>
                    </View>

                    <View style={styles.statCell}>
                      <Text style={styles.statCellLabel}>Needle time</Text>
                      <Text style={styles.statCellValue}>
                        {currentStats ? formatNeedleTime(currentStats.totalMs) : '—'}
                      </Text>
                    </View>

                    <View style={styles.statCell}>
                      <Text style={styles.statCellLabel}>Loop rituals</Text>
                      <Text style={styles.statCellValue}>{currentStats ? currentStats.loopCount : '—'}</Text>
                    </View>

                    <View style={styles.statCell}>
                      <Text style={styles.statCellLabel}>Last played</Text>
                      <Text style={styles.statCellValue}>
                        {currentStats ? formatShortDate(currentStats.lastPlayedAt) : '—'}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.noteBox}>
                    <Text style={styles.noteBoxLabel}>TURNTABLE MEMORY</Text>
                    <Text style={styles.noteBoxText}>
                      These stats only count when this Vinyl app is open and watching playback.
                    </Text>
                  </View>

                  <Pressable style={styles.closeInsertButton} onPress={closeInsert}>
                    <Text style={styles.closeInsertText}>close insert</Text>
                  </Pressable>
                </ScrollView>
              </View>
            </Animated.View>
          </Animated.View>
        ) : null}

        <GestureDetector gesture={drawerKnobGesture}>
          <Animated.View style={[styles.drawerHandle, drawerKnobAnimatedStyle]}>
            <View style={styles.drawerKnob} />
          </Animated.View>
        </GestureDetector>

        {isCrateOpen ? (
          <Animated.View style={[styles.crateScreen, crateSlideStyle]}>
            <View style={styles.crateBackground} />

            <View style={styles.crateHeader}>
              <View>
                <Text style={styles.crateHeaderEyebrow}>vinyl library</Text>
                <Text style={styles.crateHeaderTitle}>Your Crate</Text>
              </View>

              <Pressable onPress={closeCrate} style={styles.crateCloseBtn}>
                <Text style={styles.crateCloseBtnText}>close</Text>
              </Pressable>
            </View>

            {openedBox ? (
              <View style={styles.crateBoxOpen}>
                <View style={styles.crateBoxOpenHeader}>
                  <Pressable onPress={() => setOpenedBox(null)} style={styles.crateBackBtn}>
                    <Text style={styles.crateBackBtnText}>← back</Text>
                  </Pressable>

                  <View style={styles.openedBoxTitleWrap}>
                    <Text style={styles.openedBoxEyebrow}>cover flow</Text>
                    <Text style={styles.crateBoxOpenTitle} numberOfLines={1}>
                      {openedBoxTitle}
                    </Text>
                  </View>
                </View>

                <View style={styles.coverFlowStage}>
                  <View style={[styles.coverFlowGlow, { backgroundColor: selectedAccent }]} />
                  <View style={styles.coverFlowGlass} />

                  {isLoadingTracks ? (
                    <View style={styles.coverFlowLoading}>
                      <Text style={styles.coverFlowLoadingText}>opening the shelf…</Text>
                    </View>
                  ) : selectedTrack ? (
                    <>
                      <View style={styles.coverFlowHero}>
                        {previousTrack ? (
                          <Pressable
                            style={[styles.coverFlowSidePreview, styles.coverFlowSidePreviewLeft]}
                            onPress={() =>
                              setSelectedTrackIndex((current) =>
                                openedBox.tracks.length ? (current - 1 + openedBox.tracks.length) % openedBox.tracks.length : 0
                              )
                            }
                          >
                            <View style={styles.coverFlowSideVinyl}>
                              <View style={styles.coverFlowSideVinylGrooveOne} />
                              <View style={styles.coverFlowSideVinylGrooveTwo} />
                              <View style={styles.coverFlowSideVinylLabel} />
                            </View>

                            {previousTrack.albumArt ? (
                              <Image source={{ uri: previousTrack.albumArt }} style={styles.coverFlowSideImage} />
                            ) : (
                              <View style={[styles.coverFlowSideImage, styles.coverFlowFallback]} />
                            )}

                            <View style={styles.coverFlowSideSheen} />
                          </Pressable>
                        ) : null}

                        <Pressable
                          style={styles.coverFlowMainPressable}
                          onPress={async () => {
                            await playManualRecordChange();
                            await playTrack(selectedTrack.uri);
                            closeCrate();
                          }}
                        >
                          <View style={styles.coverFlowVinylBehind}>
                            <View style={styles.coverFlowVinylGrooveOne} />
                            <View style={styles.coverFlowVinylGrooveTwo} />
                            <View style={styles.coverFlowVinylGrooveThree} />
                            <View style={[styles.coverFlowVinylLabel, { backgroundColor: selectedAccent }]} />
                          </View>

                          <View style={styles.coverFlowMainShadow} />

                          {selectedTrack.albumArt ? (
                            <Image source={{ uri: selectedTrack.albumArt }} style={styles.coverFlowMainCover} />
                          ) : (
                            <View style={[styles.coverFlowMainCover, styles.coverFlowFallback]}>
                              <Text style={styles.coverFlowFallbackText}>VINYL</Text>
                            </View>
                          )}

                          <View style={styles.coverFlowReflection} />
                        </Pressable>

                        {nextTrack ? (
                          <Pressable
                            style={[styles.coverFlowSidePreview, styles.coverFlowSidePreviewRight]}
                            onPress={() =>
                              setSelectedTrackIndex((current) =>
                                openedBox.tracks.length ? (current + 1) % openedBox.tracks.length : 0
                              )
                            }
                          >
                            <View style={styles.coverFlowSideVinyl}>
                              <View style={styles.coverFlowSideVinylGrooveOne} />
                              <View style={styles.coverFlowSideVinylGrooveTwo} />
                              <View style={styles.coverFlowSideVinylLabel} />
                            </View>

                            {nextTrack.albumArt ? (
                              <Image source={{ uri: nextTrack.albumArt }} style={styles.coverFlowSideImage} />
                            ) : (
                              <View style={[styles.coverFlowSideImage, styles.coverFlowFallback]} />
                            )}

                            <View style={styles.coverFlowSideSheen} />
                          </Pressable>
                        ) : null}
                      </View>

                      <View style={styles.coverFlowMeta}>
                        <Text style={styles.coverFlowTrackNumber}>
                          {String(selectedTrackIndex + 1).padStart(2, '0')} / {String(openedBox.tracks.length).padStart(2, '0')}
                          {openedBox.nextUrl ? ' +' : ''}
                        </Text>

                        <Text style={styles.coverFlowTitle} numberOfLines={2}>
                          {selectedTrack.title}
                        </Text>

                        <Text style={styles.coverFlowArtist} numberOfLines={1}>
                          {selectedTrack.artist || 'Unknown Artist'}
                        </Text>

                        <Text style={styles.coverFlowHint}>tap cover to drop the needle</Text>
                      </View>

                      <ScrollView
                        horizontal
                        style={styles.coverFlowThumbStrip}
                        contentContainerStyle={styles.coverFlowThumbContent}
                        showsHorizontalScrollIndicator={false}
                      >
                        {openedBox.tracks.map((track, index) => {
                          const isSelected = index === selectedTrackIndex;

                          return (
                            <Pressable
                              key={track.id}
                              style={[styles.coverFlowThumb, isSelected ? styles.coverFlowThumbActive : null]}
                              onPress={() => setSelectedTrackIndex(index)}
                            >
                              {track.albumArt ? (
                                <Image source={{ uri: track.albumArt }} style={styles.coverFlowThumbImage} />
                              ) : (
                                <View style={[styles.coverFlowThumbImage, styles.coverFlowFallback]} />
                              )}

                              <View style={styles.coverFlowThumbNeedle}>
                                <View
                                  style={[
                                    styles.coverFlowThumbNeedleDot,
                                    { backgroundColor: isSelected ? selectedAccent : 'rgba(255,255,255,0.28)' },
                                  ]}
                                />
                              </View>
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                    </>
                  ) : (
                    <View style={styles.coverFlowLoading}>
                      <Text style={styles.coverFlowLoadingText}>
                        {openedBox.error || openedBox.emptyMessage || 'No records found in this box.'}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            ) : (
              <ScrollView style={styles.crateGrid} contentContainerStyle={styles.crateGridContent}>
                <Pressable style={styles.crateBox} onPress={() => openBox('liked', 'liked')}>
                  <View style={styles.crateBoxGlow} />
                  <View style={styles.crateBoxInner}>
                    <View style={styles.crateBoxIconWrap}>
                      <Text style={styles.crateBoxLabel}>♥</Text>
                    </View>

                    <Text style={styles.crateBoxName}>Liked Vinyls</Text>
                    <Text style={styles.crateBoxCount}>saved records</Text>

                    <View style={styles.cratePeekRow}>
                      {SLEEVE_PEEK_COLORS.slice(0, 6).map((color, index) => (
                        <View key={index} style={[styles.cratePeekSleeve, { backgroundColor: color }]} />
                      ))}
                    </View>
                  </View>
                </Pressable>

                {playlists.map((playlist, playlistIndex) => (
                  <Pressable key={playlist.id} style={styles.crateBox} onPress={() => openBox('playlist', playlist.id)}>
                    <View style={styles.crateBoxGlow} />
                    <View style={styles.crateBoxInner}>
                      {playlist.imageUrl ? (
                        <Image source={{ uri: playlist.imageUrl }} style={styles.crateBoxArt} />
                      ) : (
                        <View style={[styles.crateBoxArt, styles.crateBoxArtFallback]} />
                      )}

                      <Text style={styles.crateBoxName} numberOfLines={2}>
                        {playlist.name}
                      </Text>

                      <Text style={styles.crateBoxCount}>{playlist.trackCount === null ? 'records inside' : `${playlist.trackCount} records`}</Text>

                      <View style={styles.cratePeekRow}>
                        {SLEEVE_PEEK_COLORS.slice(0, 6).map((color, index) => (
                          <View
                            key={index}
                            style={[
                              styles.cratePeekSleeve,
                              { backgroundColor: SLEEVE_PEEK_COLORS[(playlistIndex + index) % SLEEVE_PEEK_COLORS.length] || color },
                            ]}
                          />
                        ))}
                      </View>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </Animated.View>
        ) : null}

        <GestureDetector gesture={discGesture}>
          <Animated.View style={[styles.discWrapper, discAnimatedStyle]}>
            <View style={styles.disc}>
              {[...Array(18)].map((_, i) => {
                const size = layout.discSize * 0.22 + i * layout.discSize * 0.042;

                return (
                  <View
                    key={i}
                    style={{
                      position: 'absolute',
                      width: size,
                      height: size,
                      borderRadius: size / 2,
                      borderWidth: 1.5,
                      borderColor: i % 2 === 0 ? 'rgba(72,72,72,0.55)' : 'rgba(12,12,12,0.80)',
                    }}
                  />
                );
              })}

              <LinearGradient
                colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0)', 'rgba(255,255,255,0.06)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{
                  position: 'absolute',
                  width: layout.discSize,
                  height: layout.discSize,
                  borderRadius: layout.discSize / 2,
                  zIndex: 2,
                }}
                pointerEvents="none"
              />

              <View
                style={{
                  position: 'absolute',
                  width: layout.discSize * 0.31,
                  height: layout.discSize * 0.31,
                  borderRadius: layout.discSize * 0.155,
                  backgroundColor: rimAccentColor,
                  zIndex: 3,
                }}
              />

              <Image source={{ uri: albumArt }} style={styles.discLabel} />
              <View style={styles.centerHole} />
            </View>

            {rimString ? <RimText size={layout.discSize} text={rimString} /> : null}
          </Animated.View>
        </GestureDetector>

        <View style={styles.armBase} pointerEvents="none">
          <View style={styles.armBaseInner} />
        </View>

        <Animated.View style={[styles.armPivot, armAnimatedStyle]} pointerEvents="none">
          <View style={styles.armShaft} />
          <View style={styles.armHead}>
            <View style={styles.armNeedle} />
          </View>
        </Animated.View>

        <Pressable style={styles.armTapZone} onPress={handleTogglePlay} />

        <GestureDetector gesture={coverGesture}>
          <Animated.View style={[styles.cover, coverAnimatedStyle]}>
            <View style={styles.coverGlass} />
          </Animated.View>
        </GestureDetector>
      </View>
    </GestureHandlerRootView>
  );
}

function getStyles(layout: PlayerLayout) {
  const crateBoxWidth = layout.isLandscape ? Math.min((layout.screenWidth - 92) / 3, 220) : (layout.screenWidth - 52) / 2;
  const mainCoverSize = layout.isLandscape ? Math.min(layout.screenHeight * 0.36, 230) : Math.min(layout.screenWidth * 0.48, 210);
  const sideCoverSize = mainCoverSize * 0.67;
  const chassisLeft = layout.isLandscape ? 62 : 34;
  const chassisTop = layout.isLandscape ? 58 : 92;
  const chassisRight = layout.isLandscape ? 38 : 18;
  const chassisBottom = Math.min(
    layout.screenHeight - 34,
    Math.max(layout.albumTop + layout.albumSize + 52, layout.discTop + layout.discSize + 56)
  );
  const chassisWidth = layout.screenWidth - chassisLeft - chassisRight;
  const chassisHeight = chassisBottom - chassisTop;
  const chassisRadius = layout.isLandscape ? 34 : 28;
  const albumRecessInset = layout.albumSize * 0.16;
  const platterInset = layout.discSize * 0.075;
  const faderHeight = layout.isLandscape ? 120 : 110;
  const controlGap = layout.isLandscape ? 22 : 16;
  const faderTop = chassisTop + (layout.isLandscape ? 34 : 28);
  const toggleSize = layout.isLandscape ? 64 : 56;
  const faderWidth = 62;
  const faderLeft = chassisLeft + (layout.isLandscape ? 34 : 20);
  const toggleLeft = faderLeft + faderWidth + controlGap;
  const toggleTop = faderTop + 16;

  return StyleSheet.create({
    loginContainer: {
      flex: 1,
      backgroundColor: '#16161f',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 40,
    },
    loginTitle: {
      color: '#fff',
      fontSize: 48,
      fontWeight: 'bold',
      letterSpacing: 2,
    },
    loginButton: {
      backgroundColor: '#1DB954',
      paddingVertical: 16,
      paddingHorizontal: 40,
      borderRadius: 30,
    },
    loginButtonText: {
      color: '#fff',
      fontSize: 18,
      fontWeight: 'bold',
    },
    container: {
      flex: 1,
      backgroundColor: '#050509',
      overflow: 'hidden',
    },
    hardwareLayer: {
      position: 'absolute',
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      zIndex: 2,
    },
    turntableChassis: {
      position: 'absolute',
      left: chassisLeft,
      top: chassisTop,
      width: chassisWidth,
      height: chassisHeight,
      borderRadius: chassisRadius,
      borderWidth: 1,
      borderColor: 'rgba(230,232,229,0.18)',
      overflow: 'hidden',
      boxShadow:
        '0px 34px 80px rgba(0,0,0,0.56), 0px 12px 22px rgba(0,0,0,0.45), inset 0px 1px 0px rgba(255,255,255,0.23), inset 0px -18px 34px rgba(0,0,0,0.28)',
    },
    chassisTopHighlight: {
      position: 'absolute',
      left: 18,
      right: 18,
      top: 10,
      height: 1,
      backgroundColor: 'rgba(255,255,255,0.34)',
    },
    chassisInnerLip: {
      position: 'absolute',
      left: 10,
      right: 10,
      top: 10,
      bottom: 10,
      borderRadius: Math.max(18, chassisRadius - 9),
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.065)',
      backgroundColor: 'rgba(255,255,255,0.015)',
      boxShadow: 'inset 0px 0px 30px rgba(0,0,0,0.18)',
    },
    chassisContactShadow: {
      position: 'absolute',
      left: 26,
      right: 26,
      bottom: 8,
      height: 18,
      borderRadius: 18,
      backgroundColor: 'rgba(0,0,0,0.26)',
      opacity: 0.74,
    },
    albumRecess: {
      position: 'absolute',
      left: layout.albumLeft - albumRecessInset,
      top: layout.albumTop - albumRecessInset,
      width: layout.albumSize + albumRecessInset * 2,
      height: layout.albumSize + albumRecessInset * 2,
      borderRadius: 12,
      transform: [{ rotate: layout.isLandscape ? '-3deg' : '-2deg' }],
      backgroundColor: 'rgba(5,6,7,0.82)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.085)',
      overflow: 'hidden',
      boxShadow:
        'inset 0px 18px 30px rgba(0,0,0,0.82), inset 0px -2px 0px rgba(255,255,255,0.12), inset 8px 0px 18px rgba(0,0,0,0.38), 0px 2px 5px rgba(255,255,255,0.035)',
    },
    albumRecessFloor: {
      position: 'absolute',
      left: 10,
      right: 10,
      top: 10,
      bottom: 10,
      borderRadius: 8,
      backgroundColor: 'rgba(12,14,16,0.92)',
      borderWidth: 1,
      borderColor: 'rgba(0,0,0,0.58)',
      boxShadow: 'inset 0px 10px 18px rgba(0,0,0,0.58)',
    },
    albumRecessHighlight: {
      position: 'absolute',
      left: 10,
      right: 10,
      top: 7,
      height: 1,
      backgroundColor: 'rgba(255,255,255,0.22)',
    },
    platterRecess: {
      position: 'absolute',
      left: layout.discLeft - platterInset,
      top: layout.discTop - platterInset,
      width: layout.discSize + platterInset * 2,
      height: layout.discSize + platterInset * 2,
      borderRadius: (layout.discSize + platterInset * 2) / 2,
      backgroundColor: 'rgba(4,5,6,0.84)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.085)',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow:
        'inset 0px 22px 44px rgba(0,0,0,0.84), inset 0px -2px 0px rgba(255,255,255,0.13), 0px 1px 0px rgba(255,255,255,0.08)',
    },
    platterInnerShadow: {
      position: 'absolute',
      width: layout.discSize * 1.02,
      height: layout.discSize * 1.02,
      borderRadius: layout.discSize * 0.51,
      backgroundColor: 'rgba(0,0,0,0.36)',
      boxShadow: 'inset 0px 0px 56px rgba(0,0,0,0.86)',
    },
    platterMetalRing: {
      width: layout.discSize * 1.01,
      height: layout.discSize * 1.01,
      borderRadius: layout.discSize * 0.505,
      borderWidth: 1,
      borderColor: 'rgba(226,226,218,0.18)',
      backgroundColor: 'rgba(125,128,126,0.08)',
      boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.14)',
    },
    platterCenterDimple: {
      position: 'absolute',
      width: layout.discSize * 0.12,
      height: layout.discSize * 0.12,
      borderRadius: layout.discSize * 0.06,
      backgroundColor: 'rgba(26,28,30,0.78)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.10)',
    },
    faderAssembly: {
      position: 'absolute',
      left: faderLeft,
      top: faderTop,
      width: 62,
      height: faderHeight + 34,
      alignItems: 'center',
    },
    faderLabel: {
      color: 'rgba(222,224,218,0.50)',
      fontSize: 8,
      fontWeight: '900',
      letterSpacing: 1.2,
      marginBottom: 8,
    },
    faderSlot: {
      width: 46,
      height: faderHeight,
      borderRadius: 15,
      backgroundColor: 'rgba(8,9,10,0.72)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.10)',
      alignItems: 'center',
      overflow: 'hidden',
      boxShadow:
        'inset 0px 7px 16px rgba(0,0,0,0.72), inset 0px -1px 0px rgba(255,255,255,0.10), 0px 1px 0px rgba(255,255,255,0.05)',
    },
    faderTick: {
      position: 'absolute',
      left: 6,
      height: 1,
      backgroundColor: 'rgba(220,222,216,0.32)',
    },
    faderRail: {
      position: 'absolute',
      top: 12,
      bottom: 12,
      width: 4,
      borderRadius: 4,
      backgroundColor: 'rgba(0,0,0,0.72)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.08)',
    },
    faderCap: {
      position: 'absolute',

      width: 34,
      height: 18,

      borderRadius: 5,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.28)',

      alignItems: 'center',
      justifyContent: 'center',

      boxShadow: '0px 4px 9px rgba(0,0,0,0.55), inset 0px 1px 0px rgba(255,255,255,0.46)',
    },
    faderCapGroove: {
      width: 22,
      height: 2,
      borderRadius: 2,
      backgroundColor: 'rgba(28,30,31,0.46)',
    },
    shuffleAssembly: {
      position: 'absolute',
      left: toggleLeft,
      top: toggleTop,
      width: toggleSize,
      alignItems: 'center',
    },
    togglePlate: {
      width: toggleSize,
      height: toggleSize * 0.74,
      borderRadius: 16,
      backgroundColor: 'rgba(17,19,21,0.66)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.12)',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow:
        'inset 0px 8px 18px rgba(0,0,0,0.70), inset 0px -1px 0px rgba(255,255,255,0.11), 0px 1px 0px rgba(255,255,255,0.06)',
    },
    toggleSlot: {
      width: toggleSize * 0.34,
      height: toggleSize * 0.52,
      borderRadius: 999,
      backgroundColor: 'rgba(3,4,5,0.82)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.10)',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    toggleLever: {
      width: toggleSize * 0.15,
      height: toggleSize * 0.45,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.24)',
      transform: [{ rotate: '-14deg' }, { translateY: -3 }],
      boxShadow: '0px 5px 9px rgba(0,0,0,0.56), inset 0px 1px 0px rgba(255,255,255,0.48)',
    },
    shuffleLabel: {
      color: 'rgba(222,224,218,0.54)',
      fontSize: 8,
      fontWeight: '900',
      letterSpacing: 1.2,
      marginTop: 7,
    },
    albumWrapper: {
      position: 'absolute',
      left: layout.albumLeft,
      top: layout.albumTop,
      zIndex: 7,
      transform: [{ rotate: layout.isLandscape ? '-3deg' : '-2deg' }],
      boxShadow: '8px 18px 28px rgba(0,0,0,0.48)',
    },
    albumArt: {
      width: layout.albumSize,
      height: layout.albumSize,
      borderRadius: 6,
      opacity: 0.9,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.18)',
    },
    noImageCallout: {
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
    },
    sleeveHint: {
      position: 'absolute',
      left: 8,
      bottom: 8,
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: 999,
      backgroundColor: 'rgba(0,0,0,0.44)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.12)',
    },
    sleeveHintText: {
      color: 'rgba(255,255,255,0.78)',
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    insertOverlay: {
      position: 'absolute',
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      zIndex: 90,
      alignItems: 'center',
      justifyContent: 'center',
    },
    insertBackdrop: {
      position: 'absolute',
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.58)',
    },
    insertBook: {
      width: layout.isLandscape ? Math.min(layout.screenWidth * 0.76, 820) : layout.screenWidth * 0.9,
      height: layout.isLandscape ? Math.min(layout.screenHeight * 0.72, 460) : layout.screenHeight * 0.72,
      flexDirection: layout.isLandscape ? 'row' : 'column',
      borderRadius: 16,
      overflow: 'hidden',
      backgroundColor: 'rgba(238,222,185,1)',
      borderWidth: 1,
      borderColor: 'rgba(95,70,38,0.38)',
      boxShadow: '14px 22px 42px rgba(0,0,0,0.52)',
    },
    insertSpine: {
      position: 'absolute',
      left: layout.isLandscape ? '50%' : 0,
      top: layout.isLandscape ? 0 : '50%',
      width: layout.isLandscape ? 2 : '100%',
      height: layout.isLandscape ? '100%' : 2,
      backgroundColor: 'rgba(92,63,31,0.32)',
      zIndex: 4,
    },
    insertPage: {
      flex: 1,
      paddingVertical: 22,
      paddingHorizontal: 24,
    },
    insertLeftPage: {
      backgroundColor: 'rgba(242,229,195,1)',
      borderRightWidth: layout.isLandscape ? 1 : 0,
      borderRightColor: 'rgba(95,70,38,0.18)',
    },
    insertRightPage: {
      backgroundColor: 'rgba(235,218,181,1)',
    },
    insertStamp: {
      alignSelf: 'flex-start',
      color: 'rgba(78,49,24,0.58)',
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1.8,
      textTransform: 'uppercase',
      borderWidth: 1,
      borderColor: 'rgba(78,49,24,0.28)',
      paddingVertical: 4,
      paddingHorizontal: 8,
      marginBottom: 14,
    },
    insertPageTitle: {
      color: 'rgba(39,27,16,0.95)',
      fontSize: 24,
      fontWeight: '900',
      letterSpacing: 0.2,
      marginBottom: 8,
    },
    insertTrackTitle: {
      color: 'rgba(39,27,16,0.94)',
      fontSize: 17,
      fontWeight: '900',
      marginBottom: 4,
    },
    insertSubTitle: {
      color: 'rgba(63,43,25,0.68)',
      fontSize: 12,
      fontWeight: '700',
      lineHeight: 17,
    },
    insertRule: {
      height: 1,
      backgroundColor: 'rgba(85,58,31,0.24)',
      marginVertical: 16,
    },
    lyricText: {
      color: 'rgba(38,27,18,0.78)',
      fontFamily: 'Courier, monospace',
      fontSize: 14,
      fontWeight: '600',
      lineHeight: 22,
    },
    lyricMuted: {
      color: 'rgba(63,43,25,0.55)',
      fontFamily: 'Courier, monospace',
      fontSize: 13,
      fontWeight: '600',
      fontStyle: 'italic',
      lineHeight: 20,
    },
    noteBox: {
      marginTop: 18,
      padding: 12,
      borderRadius: 10,
      backgroundColor: 'rgba(255,248,224,0.42)',
      borderWidth: 1,
      borderColor: 'rgba(84,58,30,0.18)',
    },
    noteBoxLabel: {
      color: 'rgba(75,48,23,0.58)',
      fontSize: 9,
      fontWeight: '900',
      letterSpacing: 1.4,
      marginBottom: 6,
    },
    noteBoxText: {
      color: 'rgba(39,27,16,0.76)',
      fontSize: 12,
      fontWeight: '700',
      lineHeight: 18,
    },
    bigStatBlock: {
      paddingVertical: 14,
      paddingHorizontal: 14,
      borderRadius: 14,
      backgroundColor: 'rgba(255,248,224,0.44)',
      borderWidth: 1,
      borderColor: 'rgba(84,58,30,0.18)',
      marginBottom: 14,
    },
    bigStatValue: {
      color: 'rgba(37,25,15,0.98)',
      fontSize: 42,
      fontWeight: '900',
      lineHeight: 46,
    },
    bigStatLabel: {
      color: 'rgba(64,42,23,0.68)',
      fontSize: 12,
      fontWeight: '900',
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    statsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
    },
    statCell: {
      width: '47%',
      paddingVertical: 11,
      paddingHorizontal: 12,
      borderRadius: 12,
      backgroundColor: 'rgba(255,248,224,0.32)',
      borderWidth: 1,
      borderColor: 'rgba(84,58,30,0.14)',
    },
    statCellLabel: {
      color: 'rgba(72,47,26,0.62)',
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 0.7,
      textTransform: 'uppercase',
      marginBottom: 5,
    },
    statCellValue: {
      color: 'rgba(35,24,14,0.96)',
      fontSize: 15,
      fontWeight: '900',
    },
    closeInsertButton: {
      alignSelf: 'flex-start',
      marginTop: 18,
      paddingVertical: 9,
      paddingHorizontal: 14,
      borderRadius: 999,
      backgroundColor: 'rgba(58,38,21,0.12)',
      borderWidth: 1,
      borderColor: 'rgba(58,38,21,0.18)',
    },
    closeInsertText: {
      color: 'rgba(45,30,18,0.78)',
      fontSize: 11,
      fontWeight: '900',
      letterSpacing: 1.1,
      textTransform: 'uppercase',
    },
    drawerHandle: {
      position: 'absolute',
      left: 0,
      top: '50%',
      width: 18,
      height: 64,
      marginTop: -32,
      zIndex: 50,
      backgroundColor: '#2a1a0e',
      borderTopRightRadius: 8,
      borderBottomRightRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '2px 0px 8px rgba(0,0,0,0.5)',
    },
    drawerKnob: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: '#d4af37',
      borderWidth: 1,
      borderColor: 'rgba(255,220,100,0.5)',
    },
    crateScreen: {
      position: 'absolute',
      left: -layout.screenWidth,
      top: 0,
      width: layout.screenWidth,
      height: layout.screenHeight,
      zIndex: 80,
      backgroundColor: '#050509',
    },
    crateBackground: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(5,5,9,0.985)',
    },
    crateHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 54,
      paddingHorizontal: 22,
      paddingBottom: 16,
      borderBottomWidth: 1,
      borderBottomColor: 'rgba(255,240,184,0.13)',
    },
    crateHeaderEyebrow: {
      color: 'rgba(255,240,184,0.58)',
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1.8,
      textTransform: 'uppercase',
      marginBottom: 4,
    },
    crateHeaderTitle: {
      color: '#fff0b8',
      fontSize: 25,
      fontWeight: '900',
      letterSpacing: 0.6,
    },
    crateCloseBtn: {
      paddingVertical: 7,
      paddingHorizontal: 14,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,240,184,0.23)',
      backgroundColor: 'rgba(255,255,255,0.035)',
    },
    crateCloseBtnText: {
      color: 'rgba(255,240,184,0.88)',
      fontSize: 11,
      fontWeight: '900',
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    crateGrid: {
      flex: 1,
    },
    crateGridContent: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      padding: 18,
      gap: 16,
    },
    crateBox: {
      width: crateBoxWidth,
      aspectRatio: 0.92,
      borderRadius: 18,
      overflow: 'hidden',
      backgroundColor: 'rgba(255,255,255,0.05)',
      borderWidth: 1,
      borderColor: 'rgba(255,240,184,0.13)',
      position: 'relative',
      boxShadow: '8px 12px 30px rgba(0,0,0,0.42)',
    },
    crateBoxGlow: {
      position: 'absolute',
      left: -30,
      top: -30,
      width: 120,
      height: 120,
      borderRadius: 60,
      backgroundColor: 'rgba(143,217,238,0.10)',
    },
    crateBoxInner: {
      flex: 1,
      padding: 14,
      justifyContent: 'space-between',
    },
    crateBoxIconWrap: {
      width: 52,
      height: 52,
      borderRadius: 18,
      backgroundColor: 'rgba(255,240,184,0.10)',
      borderWidth: 1,
      borderColor: 'rgba(255,240,184,0.22)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    crateBoxLabel: {
      color: '#fff0b8',
      fontSize: 28,
      lineHeight: 30,
    },
    crateBoxArt: {
      width: 58,
      height: 58,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.14)',
    },
    crateBoxArtFallback: {
      backgroundColor: 'rgba(143,217,238,0.16)',
    },
    crateBoxName: {
      color: 'rgba(255,250,235,0.96)',
      fontSize: 14,
      fontWeight: '900',
      lineHeight: 17,
      letterSpacing: 0.1,
    },
    crateBoxCount: {
      color: 'rgba(255,250,235,0.50)',
      fontSize: 10,
      fontWeight: '800',
      textTransform: 'uppercase',
      letterSpacing: 0.9,
      marginTop: 4,
    },
    cratePeekRow: {
      flexDirection: 'row',
      gap: 4,
      height: 28,
      marginTop: 10,
      alignItems: 'flex-end',
    },
    cratePeekSleeve: {
      width: 8,
      height: '100%',
      borderRadius: 2,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.12)',
    },
    crateBoxOpen: {
      flex: 1,
    },
    crateBoxOpenHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 22,
      paddingVertical: 16,
      gap: 14,
    },
    crateBackBtn: {
      paddingVertical: 8,
      paddingHorizontal: 13,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,240,184,0.23)',
      backgroundColor: 'rgba(255,255,255,0.035)',
    },
    crateBackBtnText: {
      color: 'rgba(255,240,184,0.88)',
      fontSize: 11,
      fontWeight: '900',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    openedBoxTitleWrap: {
      flex: 1,
    },
    openedBoxEyebrow: {
      color: 'rgba(143,217,238,0.54)',
      fontSize: 9,
      fontWeight: '900',
      letterSpacing: 1.5,
      textTransform: 'uppercase',
      marginBottom: 3,
    },
    crateBoxOpenTitle: {
      color: '#fff5c9',
      fontSize: 18,
      fontWeight: '900',
      letterSpacing: 0.2,
    },
    coverFlowStage: {
      flex: 1,
      marginHorizontal: 18,
      marginBottom: 20,
      borderRadius: 28,
      backgroundColor: 'rgba(255,255,255,0.045)',
      borderWidth: 1,
      borderColor: 'rgba(255,240,184,0.13)',
      overflow: 'hidden',
      position: 'relative',
      alignItems: 'center',
      boxShadow: '12px 18px 44px rgba(0,0,0,0.54), inset 0px 1px 0px rgba(255,255,255,0.07)',
    },
    coverFlowGlow: {
      position: 'absolute',
      top: -130,
      width: layout.isLandscape ? 440 : 350,
      height: layout.isLandscape ? 440 : 350,
      borderRadius: layout.isLandscape ? 220 : 175,
      opacity: 0.24,
    },
    coverFlowGlass: {
      position: 'absolute',
      left: 18,
      right: 18,
      top: 18,
      bottom: 18,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.055)',
      backgroundColor: 'rgba(0,0,0,0.09)',
    },
    coverFlowLoading: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    coverFlowLoadingText: {
      color: 'rgba(255,250,235,0.60)',
      fontSize: 14,
      fontStyle: 'italic',
      fontWeight: '700',
      maxWidth: '82%',
      textAlign: 'center',
    },
    coverFlowHero: {
      height: layout.isLandscape ? mainCoverSize + 34 : mainCoverSize + 18,
      width: '100%',
      marginTop: layout.isLandscape ? 14 : 12,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    },
    coverFlowMainPressable: {
      width: mainCoverSize + 72,
      height: mainCoverSize + 44,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      zIndex: 8,
    },
    coverFlowVinylBehind: {
      position: 'absolute',
      right: 16,
      top: 18,
      width: mainCoverSize * 0.92,
      height: mainCoverSize * 0.92,
      borderRadius: mainCoverSize * 0.46,
      backgroundColor: '#050505',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.13)',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '10px 14px 30px rgba(0,0,0,0.62), inset 0px 0px 22px rgba(255,255,255,0.06)',
    },
    coverFlowVinylGrooveOne: {
      position: 'absolute',
      width: '80%',
      height: '80%',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.095)',
    },
    coverFlowVinylGrooveTwo: {
      position: 'absolute',
      width: '60%',
      height: '60%',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.085)',
    },
    coverFlowVinylGrooveThree: {
      position: 'absolute',
      width: '40%',
      height: '40%',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.08)',
    },
    coverFlowVinylLabel: {
      width: mainCoverSize * 0.18,
      height: mainCoverSize * 0.18,
      borderRadius: mainCoverSize * 0.09,
      opacity: 0.62,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.20)',
    },
    coverFlowMainShadow: {
      position: 'absolute',
      left: 28,
      top: 22,
      width: mainCoverSize,
      height: mainCoverSize,
      borderRadius: 20,
      backgroundColor: 'rgba(0,0,0,0.42)',
      transform: [{ translateX: 8 }, { translateY: 10 }],
    },
    coverFlowMainCover: {
      position: 'absolute',
      left: 20,
      top: 12,
      width: mainCoverSize,
      height: mainCoverSize,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.20)',
      backgroundColor: '#17130f',
      boxShadow: '12px 16px 34px rgba(0,0,0,0.5)',
    },
    coverFlowFallback: {
      backgroundColor: 'rgba(143,217,238,0.13)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    coverFlowFallbackText: {
      color: 'rgba(255,240,184,0.60)',
      fontSize: 13,
      fontWeight: '900',
      letterSpacing: 1.4,
    },
    coverFlowReflection: {
      position: 'absolute',
      left: 20,
      top: mainCoverSize + 16,
      width: mainCoverSize,
      height: 24,
      borderRadius: 18,
      backgroundColor: 'rgba(255,255,255,0.10)',
      opacity: 0.32,
      transform: [{ scaleY: 0.55 }],
    },
    coverFlowSidePreview: {
      position: 'absolute',
      top: layout.isLandscape ? 34 : 42,
      width: sideCoverSize + 42,
      height: sideCoverSize + 28,
      opacity: 0.72,
      zIndex: 3,
    },
    coverFlowSidePreviewLeft: {
      left: layout.isLandscape ? '10%' : '2%',
      transform: [{ rotate: '-8deg' }, { scale: 0.95 }],
    },
    coverFlowSidePreviewRight: {
      right: layout.isLandscape ? '10%' : '2%',
      transform: [{ rotate: '8deg' }, { scale: 0.95 }],
    },
    coverFlowSideVinyl: {
      position: 'absolute',
      right: 0,
      top: 13,
      width: sideCoverSize * 0.82,
      height: sideCoverSize * 0.82,
      borderRadius: sideCoverSize * 0.41,
      backgroundColor: '#050505',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.15)',
      alignItems: 'center',
      justifyContent: 'center',
      opacity: 0.95,
      boxShadow: '6px 10px 22px rgba(0,0,0,0.52), inset 0px 0px 16px rgba(255,255,255,0.07)',
    },
    coverFlowSideVinylGrooveOne: {
      position: 'absolute',
      width: '78%',
      height: '78%',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.12)',
    },
    coverFlowSideVinylGrooveTwo: {
      position: 'absolute',
      width: '54%',
      height: '54%',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.10)',
    },
    coverFlowSideVinylLabel: {
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: 'rgba(255,240,184,0.34)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.18)',
    },
    coverFlowSideImage: {
      position: 'absolute',
      left: 0,
      top: 0,
      width: sideCoverSize,
      height: sideCoverSize,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.16)',
      boxShadow: '6px 10px 24px rgba(0,0,0,0.44)',
    },
    coverFlowSideSheen: {
      position: 'absolute',
      left: 0,
      top: 0,
      width: sideCoverSize,
      height: sideCoverSize,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.07)',
      backgroundColor: 'rgba(255,255,255,0.045)',
    },
    coverFlowMeta: {
      alignItems: 'center',
      paddingHorizontal: 24,
      marginTop: layout.isLandscape ? 2 : 0,
      zIndex: 4,
    },
    coverFlowTrackNumber: {
      color: 'rgba(143,217,238,0.62)',
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1.4,
      marginBottom: 6,
      textTransform: 'uppercase',
    },
    coverFlowTitle: {
      color: 'rgba(255,250,235,0.98)',
      fontSize: layout.isLandscape ? 22 : 19,
      fontWeight: '900',
      textAlign: 'center',
      lineHeight: layout.isLandscape ? 27 : 24,
      maxWidth: layout.isLandscape ? 520 : 320,
    },
    coverFlowArtist: {
      color: 'rgba(255,250,235,0.58)',
      fontSize: 12,
      fontWeight: '900',
      textAlign: 'center',
      marginTop: 7,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
    },
    coverFlowHint: {
      color: 'rgba(255,240,184,0.58)',
      fontSize: 10,
      fontWeight: '900',
      marginTop: 11,
      textTransform: 'uppercase',
      letterSpacing: 1.4,
    },
    coverFlowThumbStrip: {
      width: '100%',
      marginTop: layout.isLandscape ? 18 : 14,
      maxHeight: layout.isLandscape ? 92 : 84,
      zIndex: 5,
    },
    coverFlowThumbContent: {
      paddingHorizontal: 24,
      gap: 12,
      alignItems: 'center',
      paddingBottom: 14,
    },
    coverFlowThumb: {
      width: layout.isLandscape ? 64 : 56,
      height: layout.isLandscape ? 74 : 66,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.09)',
      backgroundColor: 'rgba(255,255,255,0.045)',
      opacity: 0.76,
    },
    coverFlowThumbActive: {
      opacity: 1,
      borderColor: 'rgba(255,240,184,0.68)',
      backgroundColor: 'rgba(143,217,238,0.08)',
    },
    coverFlowThumbImage: {
      width: layout.isLandscape ? 46 : 40,
      height: layout.isLandscape ? 46 : 40,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.14)',
    },
    coverFlowThumbNeedle: {
      marginTop: 6,
      width: 22,
      height: 2,
      borderRadius: 2,
      backgroundColor: 'rgba(255,255,255,0.14)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    coverFlowThumbNeedleDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
    },
    discWrapper: {
      position: 'absolute',
      left: layout.discLeft,
      top: layout.discTop,
      width: layout.discSize,
      height: layout.discSize,
      borderRadius: layout.discSize / 2,
      zIndex: 8,
      opacity: 1,
      boxShadow: '10px 18px 34px rgba(0,0,0,0.44)',
    },
    disc: {
      width: layout.discSize,
      height: layout.discSize,
      borderRadius: layout.discSize / 2,
      backgroundColor: '#070707',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: '#2e2e2e',
      overflow: 'hidden',
      boxShadow: 'inset 0px 0px 60px rgba(0,0,0,0.9), inset 0px 0px 12px rgba(255,255,255,0.06)',
    },
    discLabel: {
      position: 'absolute',
      width: layout.discSize * 0.26,
      height: layout.discSize * 0.26,
      borderRadius: layout.discSize * 0.13,
      opacity: 0.92,
      zIndex: 4,
    },
    centerHole: {
      position: 'absolute',
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: '#0a0a0a',
      borderWidth: 2,
      borderColor: '#555',
      zIndex: 5,
    },
    armTapZone: {
      position: 'absolute',
      left: layout.armPivotX - 70,
      top: layout.armPivotY - 45,
      width: 150,
      height: layout.armLength + 120,
      zIndex: 30,
      backgroundColor: 'rgba(255,255,255,0)',
    },
    armBase: {
      position: 'absolute',
      left: layout.armPivotX - 30,
      top: layout.armPivotY - 30,
      width: 74,
      height: 74,
      borderRadius: 37,
      zIndex: 9,
      backgroundColor: '#4b4f50',
      borderWidth: 1,
      borderColor: 'rgba(235,236,230,0.18)',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow:
        '0px 8px 18px rgba(0,0,0,0.46), inset 0px 1px 0px rgba(255,255,255,0.24), inset 0px -10px 18px rgba(0,0,0,0.30)',
    },
    armBaseInner: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: '#2d3032',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.14)',
      boxShadow: 'inset 0px 5px 12px rgba(0,0,0,0.50), 0px 1px 0px rgba(255,255,255,0.12)',
    },
    armPivot: {
      position: 'absolute',
      left: layout.armPivotX,
      top: layout.armPivotY,
      width: ARM_WIDTH,
      height: layout.armLength,
      zIndex: 10,
      transformOrigin: 'top center',
    },
    armShaft: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: ARM_WIDTH,
      height: layout.armLength,
      borderRadius: ARM_WIDTH / 2,
      backgroundColor: '#8f9696',
      borderWidth: 1,
      borderColor: 'rgba(235,236,230,0.22)',
      boxShadow: '0px 3px 7px rgba(0,0,0,0.58), inset 0px 1px 0px rgba(255,255,255,0.28)',
    },
    armHead: {
      position: 'absolute',
      bottom: -10,
      left: -6,
      width: ARM_WIDTH + 12,
      height: 34,
      borderRadius: 5,
      backgroundColor: '#25282b',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.12)',
      alignItems: 'center',
      justifyContent: 'flex-end',
      boxShadow: '0px 4px 8px rgba(0,0,0,0.44), inset 0px 1px 0px rgba(255,255,255,0.10)',
    },
    armNeedle: {
      width: 3,
      height: 10,
      backgroundColor: '#9ea3a3',
      marginBottom: -6,
    },
    cover: {
      position: 'absolute',
      left: layout.coverLeft,
      top: layout.coverTop,
      width: layout.coverSize,
      height: layout.coverSize,
      borderRadius: layout.coverSize / 2,
      zIndex: 70,
    },
    coverGlass: {
      width: layout.coverSize,
      height: layout.coverSize,
      borderRadius: layout.coverSize / 2,
      backgroundColor: 'rgba(12, 12, 24, 0.62)',
      boxShadow: '0px 0px 1px rgba(255,255,255,0.10)',
    },
  });
}
