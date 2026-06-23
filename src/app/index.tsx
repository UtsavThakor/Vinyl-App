import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthRequest } from 'expo-auth-session';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ColorValue, Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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
  };
}

type PlayerLayout = ReturnType<typeof getLayout>;

function getExpiresAt(expiresIn = 3600) {
  return Date.now() + expiresIn * 1000;
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

      <SvgText fill="rgba(255,255,255,0.5)" fontSize={13} fontWeight="600" letterSpacing={3}>
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

  const { playManualRecordChange, playLidClick } = useVinylSfx();

  const [auth, setAuth] = useState<SpotifyAuth | null>(null);
  const [albumArt, setAlbumArt] = useState<string>(FALLBACK_ART);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trackInfo, setTrackInfo] = useState({ title: '', album: '', artist: '' });

  const [bottomGrad, setBottomGrad] = useState<GradientColors>(FALLBACK_GRADIENT);
  const [topGrad, setTopGrad] = useState<GradientColors>(FALLBACK_GRADIENT);

  const gradFade = useSharedValue(1);
  const token = auth?.accessToken ?? null;

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
      const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 200) {
        const data = await res.json();
        const art = data?.item?.album?.images?.[0]?.url;

        if (art) setAlbumArt(art);

        setIsPlaying(!!data?.is_playing);

        setTrackInfo({
          title: data?.item?.name || '',
          album: data?.item?.album?.name || '',
          artist: data?.item?.artists?.[0]?.name || '',
        });
      } else if (res.status === 204) {
        setIsPlaying(false);
      } else if (res.status === 401) {
        await clearAuth();
      }
    } catch (e) {
      console.log('Now playing error:', e);
    }
  }, [clearAuth, getValidAccessToken]);

  useEffect(() => {
    if (!token) return;

    fetchNowPlaying();

    const interval = setInterval(fetchNowPlaying, 1000);

    return () => clearInterval(interval);
  }, [token, fetchNowPlaying]);

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

  const handleLoopOn = useCallback(async () => {
    const wasPlaying = isPlaying;

    playLidClick();

    await sendCommand('PUT', 'repeat?state=track');

    if (wasPlaying) {
      setTimeout(() => {
        sendCommand('PUT', 'play');
      }, 350);
    }
  }, [isPlaying, playLidClick, sendCommand]);

  const rotation = useSharedValue(0);
  const coverY = useSharedValue(layout.hiddenY);
  const armAngle = useSharedValue(ARM_REST_DEG);

  const isLooping = useRef(false);
  const lastSwipeLeft = useRef<number | null>(null);

  useEffect(() => {
    if (!isLooping.current) {
      coverY.value = layout.hiddenY;
    }
  }, [layout.hiddenY]);

  useEffect(() => {
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
    transform: [{ rotate: `${rotation.value * 360}deg` }],
  }));

  const coverAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: coverY.value }],
  }));

  const armAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${armAngle.value}deg` }],
  }));

  const discGesture = Gesture.Pan().onEnd((e) => {
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

  const coverGesture = Gesture.Pan().onEnd((e) => {
    if (e.translationY > 40 && !isLooping.current) {
      isLooping.current = true;

      coverY.value = withTiming(LOCKED_Y, {
        duration: 700,
        easing: SOFT_EASING,
      });

      runOnJS(handleLoopOn)();
    } else if (e.translationY < -40 && isLooping.current) {
      isLooping.current = false;

      coverY.value = withTiming(layout.hiddenY, {
        duration: 700,
        easing: SOFT_EASING,
      });

      runOnJS(sendCommand)('PUT', 'repeat?state=off');
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

        <View style={styles.albumWrapper}>
          <Image source={{ uri: albumArt }} style={styles.albumArt} />
        </View>

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

              <Image source={{ uri: albumArt }} style={styles.discLabel} />
              <View style={styles.centerHole} />
            </View>

            {rimString ? <RimText size={layout.discSize} text={rimString} /> : null}
          </Animated.View>
        </GestureDetector>

        <GestureDetector
          gesture={Gesture.Tap().onEnd(() => {
            runOnJS(sendCommand)(isPlaying ? 'PUT' : 'PUT', isPlaying ? 'pause' : 'play');
          })}
        >
          <Animated.View style={[styles.armPivot, armAnimatedStyle]}>
            <View style={styles.armShaft} />
            <View style={styles.armHead}>
              <View style={styles.armNeedle} />
            </View>
          </Animated.View>
        </GestureDetector>

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
      zIndex: 9,
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