# Vinyl

A vinyl-inspired music controller PWA built with Expo and React Native Web. Connects to Spotify and turns your current playback into a tactile record player experience.

## What it does

- Spinning disc that reflects your currently playing track
- Album artwork on the disc label, colors extracted to theme the background
- Tonearm animates in and out on play/pause
- Disc lid syncs with Spotify's repeat state — pull it down to loop, push it up to stop
- Scrub through a track by holding the disc and rotating it
- Swipe right to skip, swipe left to restart, swipe left twice quickly for previous
- Tap the disc or tonearm to play/pause
- Long press the album sleeve to open the vinyl insert
- Insert shows real lyrics fetched from LRCLIB (no auth required) and per-track stats
- Stats tracked per track: play count, needle time, loop count, first and last played
- Stats and lyrics cached locally with AsyncStorage

## Tech

- Expo 56 / React Native Web
- React Native Reanimated 4 for animations
- React Native Gesture Handler for disc scrub, swipe, and lid gestures
- Spotify Web API with Authorization Code + PKCE (no client secret needed)
- LRCLIB for lyrics
- AsyncStorage for local persistence
- Deployed as a static PWA on Vercel

## Setup

### Spotify

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), add redirect URIs for every environment you use:

- `http://127.0.0.1:8081` for local dev
- `https://your-project.vercel.app` for production

### Environment variables

The Spotify client ID is kept as a fallback in `src/spotify.ts`. To override it:

```bash
EXPO_PUBLIC_SPOTIFY_CLIENT_ID=your_spotify_client_id
EXPO_PUBLIC_SPOTIFY_REDIRECT_URI=https://your-project.vercel.app
```

## Running locally

```bash
npm install
npm run web
```

Open at `http://127.0.0.1:8081` — not `localhost`. Spotify no longer accepts localhost redirect URIs.

## Deploying

Vercel config is already in `vercel.json`. Connect the repo, set your environment variables in the Vercel dashboard, and it deploys automatically on push.

## Notes

Spotify playback control requires an active Spotify session on a device. Open Spotify somewhere first, then use the app to control it.
