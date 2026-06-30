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

const PEEK_HEIGHT = 36;
const FALLBACK_ART = 'https://picsum.photos/400/400';
const LOCKED_Y = 0;
const ARM_WIDTH = 14;
const ARM_REST_DEG = 4;
const ARM_PLAY_DEG = 17;

const SOFT_EASING = Easing.bezier(0.16, 1, 0.3, 1);

const RIM_ACCENT_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#007aff'] as const;

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
  trackCount: number;
};

type SpotifyTrack = {
  id: string;
  title: string;
  artist: string;
  albumArt: string | null;
  uri: string;
};

const FALLBACK_GRADIENT: GradientColors = ['#1a1a2e', '#16161f', '#0a0a0f'];
const TOKEN_STORAGE_KEY = 'spotify_auth';
const LEGACY_TOKEN_STORAGE_KEY = 'spotify_token';
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

function getLayout(width: number, height: number) {
  const isLandscape = width > height;
  const shortSide = Math.min(width, height);
  const discSize = isLandscape ? shortSide * 0.78 : width * 0.78;
  const albumSize = isLandscape ? discSize * 0.72 : width * 0.38;
  const coverSize = discSize * 1.12;

  const discCenterX = isLandscape ? width * 0.73 : width * 0.66;
  const discCenterY = isLandscape ? height * 0.52 : height * 0.42;
  const discLeft = discCenterX - discSize / 2;
  const discTop = discCenterY - discSize / 2;

  const albumLeft = isLandscape ? width * 0.11 : width * 0.13;
  const albumTop = height * 0.34;

  const coverLeft = discCenterX - coverSize / 2;
  const coverTop = discCenterY - coverSize / 2;
  const hiddenY = -(coverTop + coverSize - PEEK_HEIGHT);

  const armPivotX = width - 50;
  const armPivotY = isLandscape ? height * 0.13 : height * 0.07;
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
  const [openedBox, setOpenedBox] = useState<{ type: 'playlist' | 'liked'; id: string; tracks: SpotifyTrack[] } | null>(null);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);

  const crateTranslateX = useSharedValue(0);
  const drawerKnobScale = useSharedValue(1);

  const [bottomGrad, setBottomGrad] = useState<GradientColors>(FALLBACK_GRADIENT);
  const [topGrad, setTopGrad] = useState<GradientColors>(FALLBACK_GRADIENT);

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

  const fetchPlaylists = useCallback(async () => {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return;

    try {
      const res = await fetch('https://api.spotify.com/v1/me/playlists?limit=20', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 200) {
        const data = await res.json();
        const items: SpotifyPlaylist[] = (data.items || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          imageUrl: p.images?.[0]?.url || null,
          trackCount: p.tracks?.total || 0,
        }));
        setPlaylists(items);
      }
    } catch (e) {
      console.log('Playlists error:', e);
    }
  }, [getValidAccessToken]);

  const fetchPlaylistTracks = useCallback(async (playlistId: string) => {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return [];

    try {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 200) {
        const data = await res.json();
        return (data.items || [])
          .filter((item: any) => item?.track?.id)
          .map((item: any) => ({
            id: item.track.id,
            title: item.track.name,
            artist: item.track.artists?.[0]?.name || '',
            albumArt: item.track.album?.images?.[0]?.url || null,
            uri: item.track.uri,
          })) as SpotifyTrack[];
      }
    } catch (e) {
      console.log('Playlist tracks error:', e);
    }
    return [];
  }, [getValidAccessToken]);

  const fetchLikedTracks = useCallback(async () => {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return [];

    try {
      const res = await fetch('https://api.spotify.com/v1/me/tracks?limit=50', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 200) {
        const data = await res.json();
        return (data.items || [])
          .filter((item: any) => item?.track?.id)
          .map((item: any) => ({
            id: item.track.id,
            title: item.track.name,
            artist: item.track.artists?.[0]?.name || '',
            albumArt: item.track.album?.images?.[0]?.url || null,
            uri: item.track.uri,
          })) as SpotifyTrack[];
      }
    } catch (e) {
      console.log('Liked tracks error:', e);
    }
    return [];
  }, [getValidAccessToken]);

  const playTrack = useCallback(async (uri: string) => {
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
  }, [getValidAccessToken, fetchNowPlaying]);

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

    crateTranslateX.value = withTiming(-layout.screenWidth, {
      duration: 420,
      easing: SOFT_EASING,
    });

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}
  }, [fetchPlaylists, crateTranslateX, layout.screenWidth]);

  const closeCrate = useCallback(() => {
    setOpenedBox(null);

    crateTranslateX.value = withTiming(0, {
      duration: 380,
      easing: SOFT_EASING,
    }, (finished) => {
      if (finished) runOnJS(setIsCrateOpen)(false);
    });
  }, [crateTranslateX]);

  const openBox = useCallback(async (type: 'playlist' | 'liked', id: string) => {
    setIsLoadingTracks(true);

    const tracks = type === 'liked'
      ? await fetchLikedTracks()
      : await fetchPlaylistTracks(id);

    setOpenedBox({ type, id, tracks });
    setIsLoadingTracks(false);
  }, [fetchLikedTracks, fetchPlaylistTracks]);

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

        {/* Drawer knob — always visible on left edge */}
        <GestureDetector gesture={drawerKnobGesture}>
          <Animated.View style={styles.drawerHandle}>
            <View style={styles.drawerKnob} />
          </Animated.View>
        </GestureDetector>

        {/* Crate — slides in from left */}
        {isCrateOpen ? (
          <Animated.View style={[styles.crateScreen, crateSlideStyle]}>

            <View style={styles.crateBackground} />

            <View style={styles.crateHeader}>
              <Text style={styles.crateHeaderTitle}>Your Crate</Text>
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
                  <Text style={styles.crateBoxOpenTitle}>
                    {openedBox.type === 'liked' ? 'Liked Songs' : playlists.find(p => p.id === openedBox.id)?.name || ''}
                  </Text>
                </View>

                <View style={styles.cardboardBox}>
                  <View style={styles.cardboardFlapTop} />
                  <View style={styles.cardboardFlapLeft} />
                  <View style={styles.cardboardFlapRight} />
                  <View style={styles.cardboardFlapBottom} />

                  <ScrollView style={styles.trackSpineList} showsVerticalScrollIndicator={false}>
                    {isLoadingTracks ? (
                      <Text style={styles.crateLoadingText}>digging through the crate…</Text>
                    ) : openedBox.tracks.map((track) => (
                      <Pressable
                        key={track.id}
                        style={styles.trackSpine}
                        onPress={async () => {
                          await playTrack(track.uri);
                          closeCrate();
                        }}
                      >
                        {track.albumArt ? (
                          <Image source={{ uri: track.albumArt }} style={styles.trackSpineArt} />
                        ) : (
                          <View style={[styles.trackSpineArt, styles.trackSpineArtFallback]} />
                        )}
                        <View style={styles.trackSpineInfo}>
                          <Text style={styles.trackSpineTitle} numberOfLines={1}>{track.title}</Text>
                          <Text style={styles.trackSpineArtist} numberOfLines={1}>{track.artist}</Text>
                        </View>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              </View>
            ) : (
              <ScrollView style={styles.crateGrid} contentContainerStyle={styles.crateGridContent}>

                <Pressable
                  style={styles.crateBox}
                  onPress={() => openBox('liked', 'liked')}
                >
                  <View style={styles.crateBoxFlapTop} />
                  <View style={styles.crateBoxFlapLeft} />
                  <View style={styles.crateBoxFlapRight} />
                  <View style={styles.crateBoxInner}>
                    <Text style={styles.crateBoxLabel}>♥</Text>
                    <Text style={styles.crateBoxName}>Liked Songs</Text>
                  </View>
                </Pressable>

                {playlists.map((playlist) => (
                  <Pressable
                    key={playlist.id}
                    style={styles.crateBox}
                    onPress={() => openBox('playlist', playlist.id)}
                  >
                    <View style={styles.crateBoxFlapTop} />
                    <View style={styles.crateBoxFlapLeft} />
                    <View style={styles.crateBoxFlapRight} />
                    <View style={styles.crateBoxInner}>
                      {playlist.imageUrl ? (
                        <Image source={{ uri: playlist.imageUrl }} style={styles.crateBoxArt} />
                      ) : (
                        <View style={[styles.crateBoxArt, styles.crateBoxArtFallback]} />
                      )}
                      <Text style={styles.crateBoxName} numberOfLines={2}>{playlist.name}</Text>
                      <Text style={styles.crateBoxCount}>{playlist.trackCount} tracks</Text>
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
      backgroundColor: '#16161f',
      overflow: 'hidden',
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
      left: layout.screenWidth,
      top: 0,
      width: layout.screenWidth,
      height: layout.screenHeight,
      zIndex: 80,
      backgroundColor: '#1a110a',
    },
    crateBackground: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(18,10,4,0.96)',
    },
    crateHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 56,
      paddingHorizontal: 20,
      paddingBottom: 16,
      borderBottomWidth: 1,
      borderBottomColor: 'rgba(212,175,55,0.2)',
    },
    crateHeaderTitle: {
      color: '#d4af37',
      fontSize: 22,
      fontWeight: '900',
      letterSpacing: 1,
    },
    crateCloseBtn: {
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(212,175,55,0.3)',
    },
    crateCloseBtnText: {
      color: 'rgba(212,175,55,0.8)',
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
      padding: 16,
      gap: 16,
    },
    crateBox: {
      width: (layout.screenWidth - 48) / 2,
      aspectRatio: 1,
      backgroundColor: '#c8954a',
      borderRadius: 4,
      overflow: 'hidden',
      position: 'relative',
      boxShadow: '4px 6px 16px rgba(0,0,0,0.5)',
    },
    crateBoxFlapTop: {
      position: 'absolute',
      top: 0,
      left: '10%',
      width: '80%',
      height: '20%',
      backgroundColor: '#b5833a',
      borderBottomLeftRadius: 4,
      borderBottomRightRadius: 4,
      zIndex: 2,
    },
    crateBoxFlapLeft: {
      position: 'absolute',
      left: 0,
      top: '10%',
      width: '18%',
      height: '80%',
      backgroundColor: '#a8762f',
      borderTopRightRadius: 4,
      borderBottomRightRadius: 4,
      zIndex: 2,
    },
    crateBoxFlapRight: {
      position: 'absolute',
      right: 0,
      top: '10%',
      width: '18%',
      height: '80%',
      backgroundColor: '#a8762f',
      borderTopLeftRadius: 4,
      borderBottomLeftRadius: 4,
      zIndex: 2,
    },
    crateBoxInner: {
      position: 'absolute',
      top: '22%',
      left: '20%',
      right: '20%',
      bottom: '8%',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      zIndex: 3,
    },
    crateBoxArt: {
      width: '70%',
      aspectRatio: 1,
      borderRadius: 3,
    },
    crateBoxArtFallback: {
      backgroundColor: '#7a5520',
    },
    crateBoxLabel: {
      color: '#d4af37',
      fontSize: 28,
    },
    crateBoxName: {
      color: '#2a1a0e',
      fontSize: 11,
      fontWeight: '900',
      textAlign: 'center',
      letterSpacing: 0.3,
    },
    crateBoxCount: {
      color: 'rgba(42,26,14,0.6)',
      fontSize: 9,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    crateBoxOpen: {
      flex: 1,
    },
    crateBoxOpenHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 14,
      gap: 14,
    },
    crateBackBtn: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(212,175,55,0.3)',
    },
    crateBackBtnText: {
      color: 'rgba(212,175,55,0.8)',
      fontSize: 11,
      fontWeight: '900',
    },
    crateBoxOpenTitle: {
      color: '#d4af37',
      fontSize: 16,
      fontWeight: '900',
      flex: 1,
    },
    cardboardBox: {
      flex: 1,
      margin: 16,
      backgroundColor: '#c8954a',
      borderRadius: 6,
      overflow: 'hidden',
      position: 'relative',
      boxShadow: '4px 8px 20px rgba(0,0,0,0.5)',
    },
    cardboardFlapTop: {
      position: 'absolute',
      top: 0,
      left: '5%',
      width: '90%',
      height: 28,
      backgroundColor: '#b5833a',
      borderBottomLeftRadius: 6,
      borderBottomRightRadius: 6,
      zIndex: 2,
    },
    cardboardFlapLeft: {
      position: 'absolute',
      left: 0,
      top: 28,
      width: 20,
      bottom: 20,
      backgroundColor: '#a8762f',
      borderTopRightRadius: 4,
      borderBottomRightRadius: 4,
      zIndex: 2,
    },
    cardboardFlapRight: {
      position: 'absolute',
      right: 0,
      top: 28,
      width: 20,
      bottom: 20,
      backgroundColor: '#a8762f',
      borderTopLeftRadius: 4,
      borderBottomLeftRadius: 4,
      zIndex: 2,
    },
    cardboardFlapBottom: {
      position: 'absolute',
      bottom: 0,
      left: '5%',
      width: '90%',
      height: 20,
      backgroundColor: '#b5833a',
      borderTopLeftRadius: 4,
      borderTopRightRadius: 4,
      zIndex: 2,
    },
    trackSpineList: {
      flex: 1,
      marginTop: 28,
      marginLeft: 20,
      marginRight: 20,
      marginBottom: 20,
    },
    trackSpine: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 10,
      borderBottomWidth: 1,
      borderBottomColor: 'rgba(42,26,14,0.15)',
      gap: 10,
    },
    trackSpineArt: {
      width: 36,
      height: 36,
      borderRadius: 3,
    },
    trackSpineArtFallback: {
      backgroundColor: '#7a5520',
    },
    trackSpineInfo: {
      flex: 1,
    },
    trackSpineTitle: {
      color: '#2a1a0e',
      fontSize: 13,
      fontWeight: '800',
    },
    trackSpineArtist: {
      color: 'rgba(42,26,14,0.6)',
      fontSize: 11,
      fontWeight: '600',
      marginTop: 2,
    },
    crateLoadingText: {
      color: 'rgba(42,26,14,0.6)',
      fontSize: 13,
      fontStyle: 'italic',
      fontWeight: '600',
      padding: 20,
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
      backgroundColor: '#d8d8dc',
      boxShadow: '0px 2px 6px rgba(0,0,0,0.6)',
    },
    armHead: {
      position: 'absolute',
      bottom: -10,
      left: -6,
      width: ARM_WIDTH + 12,
      height: 34,
      borderRadius: 5,
      backgroundColor: '#3a3a40',
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
    armNeedle: {
      width: 3,
      height: 10,
      backgroundColor: '#bbb',
      marginBottom: -6,
    },
    cover: {
      position: 'absolute',
      left: layout.coverLeft,
      top: layout.coverTop,
      width: layout.coverSize,
      height: layout.coverSize,
      borderRadius: layout.coverSize / 2,
      zIndex: 11,
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