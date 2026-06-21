import { useAuthRequest } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { Dimensions, Image, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { CLIENT_ID, DISCOVERY, REDIRECT_URI, SCOPES } from '../spotify';

WebBrowser.maybeCompleteAuthSession();

const { width, height } = Dimensions.get('window');

const BASE = Math.min(width, height);
const DISC_SIZE = BASE * 0.82;
const ALBUM_SIZE = DISC_SIZE * 0.52;
const PEEK_HEIGHT = 36;
const FALLBACK_ART = 'https://picsum.photos/400/400';

const DISC_LEFT = (width - DISC_SIZE) / 2 + width * 0.05;
const DISC_TOP = (height - DISC_SIZE) / 2;
const ALBUM_LEFT = DISC_LEFT - ALBUM_SIZE * 0.62;
const ALBUM_TOP = DISC_TOP + DISC_SIZE / 2 - ALBUM_SIZE / 2;

const LOCKED_Y = 0;
const HIDDEN_Y = PEEK_HEIGHT - (DISC_TOP + DISC_SIZE);

const SOFT_EASING = Easing.bezier(0.16, 1, 0.3, 1);

export default function VinylPlayer() {
  const [token, setToken] = useState<string | null>(null);
  const [albumArt, setAlbumArt] = useState<string>(FALLBACK_ART);

  // Spotify auth request
  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: CLIENT_ID,
      scopes: SCOPES,
      usePKCE: true,
      redirectUri: REDIRECT_URI,
    },
    DISCOVERY
  );

  // When login succeeds, exchange the code for a token
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
      } else {
        console.log('Token error:', data);
      }
    } catch (e) {
      console.log('Exchange error:', e);
    }
  }

  // Poll the currently playing track every 3 seconds
  useEffect(() => {
    if (!token) return;
    const fetchNowPlaying = async () => {
      try {
        const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 200) {
          const data = await res.json();
          const art = data?.item?.album?.images?.[0]?.url;
          if (art) setAlbumArt(art);
        }
      } catch (e) {
        console.log('Now playing error:', e);
      }
    };
    fetchNowPlaying();
    const interval = setInterval(fetchNowPlaying, 3000);
    return () => clearInterval(interval);
  }, [token]);

  // Send a playback command to Spotify
  async function sendCommand(method: 'POST' | 'PUT', endpoint: string) {
    if (!token) return;
    try {
      await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      console.log('Command error:', e);
    }
  }

  const rotation = useSharedValue(0);
  const coverY = useSharedValue(HIDDEN_Y);
  const isLooping = useRef(false);
  const lastSwipeLeft = useRef<number | null>(null);

  useEffect(() => {
    rotation.value = 0;
    rotation.value = withRepeat(
      withTiming(1, { duration: 4000, easing: Easing.linear }),
      -1,
      false
    );
  }, []);

  const discAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 360}deg` }],
  }));

  const coverAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: coverY.value }],
  }));

  const coverPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > 40 && !isLooping.current) {
          isLooping.current = true;
          coverY.value = withTiming(LOCKED_Y, { duration: 700, easing: SOFT_EASING });
        } else if (gesture.dy < -40 && isLooping.current) {
          isLooping.current = false;
          coverY.value = withTiming(HIDDEN_Y, { duration: 700, easing: SOFT_EASING });
        }
      },
    })
  ).current;

  const discPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx > 60) {
          // Swipe right — next song
          sendCommand('POST', 'next');
        } else if (gesture.dx < -60) {
          const now = Date.now();
          if (lastSwipeLeft.current && now - lastSwipeLeft.current < 1500) {
            // Double swipe left — previous song
            sendCommand('POST', 'previous');
            lastSwipeLeft.current = null;
          } else {
            // Single swipe left — restart current song (seek to 0)
            sendCommand('PUT', 'seek?position_ms=0');
            lastSwipeLeft.current = now;
          }
        }
      },
    })
  ).current;

  // ---- LOGIN SCREEN ----
  if (!token) {
    return (
      <View style={styles.loginContainer}>
        <Text style={styles.loginTitle}>Vinyl</Text>
        <Pressable
          style={styles.loginButton}
          disabled={!request}
          onPress={() => promptAsync()}
        >
          <Text style={styles.loginButtonText}>Connect Spotify</Text>
        </Pressable>
      </View>
    );
  }

  // ---- VINYL PLAYER ----
  return (
    <View style={styles.container}>

      <View style={styles.albumWrapper}>
        <Image source={{ uri: albumArt }} style={styles.albumArt} />
      </View>

      <Animated.View
        style={[styles.discWrapper, discAnimatedStyle]}
        {...discPanResponder.panHandlers}
      >
        <View style={styles.disc}>
          {[...Array(12)].map((_, i) => {
            const size = DISC_SIZE * 0.38 + i * DISC_SIZE * 0.055;
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
          {/* Album art in the disc label area */}
          <Image source={{ uri: albumArt }} style={styles.discLabel} />
          <View style={styles.centerHole} />
        </View>
      </Animated.View>

      <Animated.View
        style={[styles.cover, coverAnimatedStyle]}
        {...coverPanResponder.panHandlers}
      >
        <View style={styles.coverGlass} />
      </Animated.View>

    </View>
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
    left: ALBUM_LEFT,
    top: ALBUM_TOP,
    zIndex: 1,
    transform: [{ rotate: '-6deg' }],
    shadowColor: '#000',
    shadowOffset: { width: 6, height: 10 },
    shadowOpacity: 0.9,
    shadowRadius: 16,
    elevation: 10,
  },
  albumArt: {
    width: ALBUM_SIZE,
    height: ALBUM_SIZE,
    borderRadius: 14,
  },
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
  cover: {
    position: 'absolute',
    left: DISC_LEFT,
    top: DISC_TOP,
    width: DISC_SIZE,
    height: DISC_SIZE,
    borderRadius: DISC_SIZE / 2,
    zIndex: 3,
  },
  coverGlass: {
    width: DISC_SIZE,
    height: DISC_SIZE,
    borderRadius: DISC_SIZE / 2,
    backgroundColor: 'rgba(12, 12, 24, 0.62)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
});