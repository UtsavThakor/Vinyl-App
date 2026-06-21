import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthRequest } from 'expo-auth-session';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, Image, Pressable, StyleSheet, Text, View } from 'react-native';
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
import { CLIENT_ID, DISCOVERY, REDIRECT_URI, SCOPES } from '../spotify';

WebBrowser.maybeCompleteAuthSession();

const { width, height } = Dimensions.get('window');

// --- Bigger disc that bleeds off the top-left (matches reference) ---
const DISC_SIZE = Math.max(width, height) * 0.95;
const ALBUM_SIZE = DISC_SIZE * 0.42;      // album art scaled up with the disc
const PEEK_HEIGHT = 36;
const COVER_SIZE = DISC_SIZE * 1.12;
const FALLBACK_ART = 'https://picsum.photos/400/400';

// Disc center pulled toward upper-left so it bleeds off the top + left edges
const DISC_CENTER_X = width * 0.40;
const DISC_CENTER_Y = height * 0.42;
const DISC_LEFT = DISC_CENTER_X - DISC_SIZE / 2;
const DISC_TOP = DISC_CENTER_Y - DISC_SIZE / 2;

// Album art centered on the disc (same relationship as before, just bigger)
const ALBUM_LEFT = DISC_CENTER_X - ALBUM_SIZE / 2;
const ALBUM_TOP = DISC_CENTER_Y - ALBUM_SIZE / 2;

// Cover shares the disc center, larger box, same slide behavior
const COVER_LEFT = DISC_CENTER_X - COVER_SIZE / 2;
const COVER_TOP = DISC_CENTER_Y - COVER_SIZE / 2;

const LOCKED_Y = 0;
const HIDDEN_Y = -(COVER_TOP + COVER_SIZE - PEEK_HEIGHT);

// --- Tonearm geometry (top-right, my choice of placement) ---
const ARM_PIVOT_X = width - 50;
const ARM_PIVOT_Y = -40;
const ARM_LENGTH =
  Math.hypot(DISC_CENTER_X - ARM_PIVOT_X, DISC_CENTER_Y - ARM_PIVOT_Y) * 0.74;
const ARM_WIDTH = 14;
const ARM_REST_DEG = 4;
const ARM_PLAY_DEG = 17;

const SOFT_EASING = Easing.bezier(0.16, 1, 0.3, 1);

const FALLBACK_GRADIENT = ['#1a1a2e', '#16161f', '#0a0a0f'];

async function extractColors(imageUrl: string): Promise<string[]> {
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
          let r = 0, g = 0, b = 0, count = 0;
          for (let i = 0; i < data.length; i += 4) {
            r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
          }
          r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
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
        <TextPath href="#rim" startOffset="2%">{text}</TextPath>
      </SvgText>
    </Svg>
  );
}

const AnimatedGradient = Animated.createAnimatedComponent(LinearGradient);

export default function VinylPlayer() {
  const [token, setToken] = useState<string | null>(null);
  const [albumArt, setAlbumArt] = useState<string>(FALLBACK_ART);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trackInfo, setTrackInfo] = useState({ title: '', album: '', artist: '' });

  const [bottomGrad, setBottomGrad] = useState<string[]>(FALLBACK_GRADIENT);
  const [topGrad, setTopGrad] = useState<string[]>(FALLBACK_GRADIENT);
  const gradFade = useSharedValue(1);

  const [request, response, promptAsync] = useAuthRequest(
    { clientId: CLIENT_ID, scopes: SCOPES, usePKCE: true, redirectUri: REDIRECT_URI },
    DISCOVERY
  );

  useEffect(() => {
    AsyncStorage.getItem('spotify_token').then((saved) => {
      if (saved) setToken(saved);
    });
  }, []);

  useEffect(() => {
    if (response?.type === 'success' && response.params.code && request?.codeVerifier) {
      exchangeCodeForToken(response.params.code, request.codeVerifier);
    }
  }, [response]);

  async function exchangeCodeForToken(code: string, verifier: string) {
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
      const data = await res.json();
      if (data.access_token) {
        setToken(data.access_token);
        AsyncStorage.setItem('spotify_token', data.access_token);
      } else {
        console.log('Token error:', data);
      }
    } catch (e) {
      console.log('Exchange error:', e);
    }
  }

  const fetchNowPlaying = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${token}` },
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
        setToken(null);
        AsyncStorage.removeItem('spotify_token');
      }
    } catch (e) {
      console.log('Now playing error:', e);
    }
  }, [token]);

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
        if (finished) runOnJS(setBottomGrad)(cols);
      });
    });
    return () => {
      active = false;
    };
  }, [albumArt]);

  const topGradStyle = useAnimatedStyle(() => ({ opacity: gradFade.value }));

  const sendCommand = useCallback(
    async (method: 'POST' | 'PUT', endpoint: string) => {
      if (!token) return;
      try {
        await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
          method,
          headers: { Authorization: `Bearer ${token}` },
        });
        setTimeout(fetchNowPlaying, 200);
      } catch (e) {
        console.log('Command error:', e);
      }
    },
    [token, fetchNowPlaying]
  );

  const rotation = useSharedValue(0);
  const coverY = useSharedValue(HIDDEN_Y);
  const armAngle = useSharedValue(ARM_REST_DEG);
  const isLooping = useRef(false);
  const lastSwipeLeft = useRef<number | null>(null);

  useEffect(() => {
    if (isPlaying) {
      rotation.value = withRepeat(
        withTiming(rotation.value + 1, { duration: 12000, easing: Easing.linear }),
        -1,
        false
      );
      armAngle.value = withTiming(ARM_PLAY_DEG, { duration: 900, easing: SOFT_EASING });
    } else {
      cancelAnimation(rotation);
      armAngle.value = withTiming(ARM_REST_DEG, { duration: 900, easing: SOFT_EASING });
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
      runOnJS(sendCommand)('POST', 'next');
    } else if (e.translationX < -60) {
      const now = Date.now();
      if (lastSwipeLeft.current && now - lastSwipeLeft.current < 1500) {
        runOnJS(sendCommand)('POST', 'previous');
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
      coverY.value = withTiming(LOCKED_Y, { duration: 700, easing: SOFT_EASING });
      runOnJS(sendCommand)('PUT', 'repeat?state=track');
    } else if (e.translationY < -40 && isLooping.current) {
      isLooping.current = false;
      coverY.value = withTiming(HIDDEN_Y, { duration: 700, easing: SOFT_EASING });
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

        {/* Disc */}
        <GestureDetector gesture={discGesture}>
          <Animated.View style={[styles.discWrapper, discAnimatedStyle]}>
            <View style={styles.disc}>
              {[...Array(10)].map((_, i) => {
                const size = DISC_SIZE * 0.34 + i * DISC_SIZE * 0.05;
                return (
                  <View
                    key={i}
                    style={{
                      position: 'absolute',
                      width: size,
                      height: size,
                      borderRadius: size / 2,
                      borderWidth: 1.5,
                      borderColor: i % 2 === 0 ? '#2a2a2a' : '#161616',
                    }}
                  />
                );
              })}
              <Image source={{ uri: albumArt }} style={styles.discLabel} />
              <View style={styles.centerHole} />
            </View>
            {rimString ? <RimText size={DISC_SIZE} text={rimString} /> : null}
          </Animated.View>
        </GestureDetector>

        {/* Album art */}
        <View style={styles.albumWrapper}>
          <Image source={{ uri: albumArt }} style={styles.albumArt} />
        </View>

        {/* Tonearm */}
        <Animated.View style={[styles.armPivot, armAnimatedStyle]} pointerEvents="none">
          <View style={styles.armShaft} />
          <View style={styles.armHead}>
            <View style={styles.armNeedle} />
          </View>
        </Animated.View>

        {/* Cover */}
        <GestureDetector gesture={coverGesture}>
          <Animated.View style={[styles.cover, coverAnimatedStyle]}>
            <View style={styles.coverGlass} />
          </Animated.View>
        </GestureDetector>

      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loginContainer: {
    flex: 1,
    backgroundColor: '#16161f',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 40,
  },
  loginTitle: { color: '#fff', fontSize: 48, fontWeight: 'bold', letterSpacing: 2 },
  loginButton: {
    backgroundColor: '#1DB954',
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderRadius: 30,
  },
  loginButtonText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  container: { flex: 1, backgroundColor: '#16161f', overflow: 'hidden' },
  albumWrapper: {
    position: 'absolute',
    left: ALBUM_LEFT,
    top: ALBUM_TOP,
    zIndex: 7,
    boxShadow: '6px 10px 16px rgba(0,0,0,0.9)',
  },
  albumArt: { width: ALBUM_SIZE, height: ALBUM_SIZE, borderRadius: ALBUM_SIZE / 2 },
  discWrapper: {
    position: 'absolute',
    left: DISC_LEFT,
    top: DISC_TOP,
    width: DISC_SIZE,
    height: DISC_SIZE,
    borderRadius: DISC_SIZE / 2,
    zIndex: 2,
  },
  disc: {
    width: DISC_SIZE,
    height: DISC_SIZE,
    borderRadius: DISC_SIZE / 2,
    backgroundColor: '#070707',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#2e2e2e',
    overflow: 'hidden',
  },
  discLabel: {
    position: 'absolute',
    width: DISC_SIZE * 0.30,
    height: DISC_SIZE * 0.30,
    borderRadius: DISC_SIZE * 0.15,
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
    left: ARM_PIVOT_X,
    top: ARM_PIVOT_Y,
    width: ARM_WIDTH,
    height: ARM_LENGTH,
    zIndex: 5,
    transformOrigin: 'top center',
  },
  armShaft: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: ARM_WIDTH,
    height: ARM_LENGTH,
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
  armNeedle: { width: 3, height: 10, backgroundColor: '#bbb', marginBottom: -6 },
  cover: {
    position: 'absolute',
    left: COVER_LEFT,
    top: COVER_TOP,
    width: COVER_SIZE,
    height: COVER_SIZE,
    borderRadius: COVER_SIZE / 2,
    zIndex: 6,
  },
  coverGlass: {
    width: COVER_SIZE,
    height: COVER_SIZE,
    borderRadius: COVER_SIZE / 2,
    backgroundColor: 'rgba(12, 12, 24, 0.62)',
    boxShadow: '0px 0px 1px rgba(255,255,255,0.10)',
  },
});