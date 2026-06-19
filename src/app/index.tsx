import { useEffect, useRef } from 'react';
import { Dimensions, Image, PanResponder, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const { width, height } = Dimensions.get('window');

// Size off the SMALLER dimension so the disc never overflows on any device
const BASE = Math.min(width, height);
const DISC_SIZE = BASE * 0.82;
const ALBUM_SIZE = DISC_SIZE * 0.52;   // bigger album relative to disc (fix #5)
const PEEK_HEIGHT = 36;
const ALBUM_ART = 'https://picsum.photos/400/400';

// Center the disc on screen, nudged slightly right to leave room for album (fix #1, #4, #7)
const DISC_LEFT = (width - DISC_SIZE) / 2 + width * 0.05;
const DISC_TOP = (height - DISC_SIZE) / 2;

// Album sits at the same vertical center, overlapping the disc's left edge (fix #3, #4)
const ALBUM_LEFT = DISC_LEFT - ALBUM_SIZE * 0.62;
const ALBUM_TOP = DISC_TOP + DISC_SIZE / 2 - ALBUM_SIZE / 2;

// Cover shares the disc's exact box, so translateY:0 locks perfectly onto it (fix #2)
const LOCKED_Y = 0;
const HIDDEN_Y = PEEK_HEIGHT - (DISC_TOP + DISC_SIZE);  // parked up top, only a clean arc peeks

const SOFT_EASING = Easing.bezier(0.16, 1, 0.3, 1);

export default function VinylPlayer() {
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
          console.log('Next song');
        } else if (gesture.dx < -60) {
          const now = Date.now();
          if (lastSwipeLeft.current && now - lastSwipeLeft.current < 1500) {
            console.log('Previous song');
            lastSwipeLeft.current = null;
          } else {
            console.log('Restart song');
            lastSwipeLeft.current = now;
          }
        }
      },
    })
  ).current;

  return (
    <View style={styles.container}>

      {/* Album art — behind the disc, tucked to the left */}
      <View style={styles.albumWrapper}>
        <Image source={{ uri: ALBUM_ART }} style={styles.albumArt} />
      </View>

      {/* Spinning disc — on top of album */}
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
          {/* Label + spindle hole (fix #6 — distinct from background) */}
          <View style={styles.label} />
          <View style={styles.centerHole} />
        </View>
      </Animated.View>

      {/* Dark glass cover — parks up top, slides down to lock onto disc */}
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
  container: {
    flex: 1,
    backgroundColor: '#16161f',   // slightly different from disc so they read separately
    overflow: 'hidden',
  },
  albumWrapper: {
    position: 'absolute',
    left: ALBUM_LEFT,             // changed — anchored to disc center, overlaps left edge
    top: ALBUM_TOP,               // changed — vertically aligned with disc center
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
    left: DISC_LEFT,              // changed — centered, fully visible
    top: DISC_TOP,                // changed
    width: DISC_SIZE,
    height: DISC_SIZE,
    borderRadius: DISC_SIZE / 2,
    zIndex: 2,
  },
  disc: {
    width: DISC_SIZE,
    height: DISC_SIZE,
    borderRadius: DISC_SIZE / 2,
    backgroundColor: '#070707',   // deep shiny black, distinct from bg
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#2e2e2e',
    overflow: 'hidden',
  },
  label: {                        // new — paper label area in the middle
    position: 'absolute',
    width: DISC_SIZE * 0.30,
    height: DISC_SIZE * 0.30,
    borderRadius: DISC_SIZE * 0.15,
    backgroundColor: '#23232e',
    zIndex: 4,
  },
  centerHole: {
    position: 'absolute',
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#0a0a0a',   // changed — dark hole, no longer matches bg
    borderWidth: 2,
    borderColor: '#555',
    zIndex: 5,
  },
  cover: {
    position: 'absolute',
    left: DISC_LEFT,              // changed — IDENTICAL box to disc so it locks exactly
    top: DISC_TOP,                // changed
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